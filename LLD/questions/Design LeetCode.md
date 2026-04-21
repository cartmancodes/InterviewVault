# Design LeetCode

> **Pattern**: Sandboxed Execution / Queue-based Workers
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/leetcode)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Secure Code Execution Sandbox](#1-secure-code-execution-sandbox)
   - [2. Queue-Based Asynchronous Execution](#2-queue-based-asynchronous-execution)
   - [3. Contest Leaderboards](#3-contest-leaderboards)
   - [4. Cheating Detection](#4-cheating-detection)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

LeetCode is a platform where engineers practice algorithmic problems by writing solutions in their preferred language, submitting code against a hidden test-case suite, and competing on live contest leaderboards. The interesting part of the design is not the CRUD around problems, but the fact that we are running arbitrary user-supplied code on our own infrastructure and must do so safely and at burst scale.

### Functional Requirements

**Core:**
- Browse a paginated list of problems with filters (difficulty, tag, status).
- Open a problem page and view the full description plus a language-specific code stub.
- Submit a solution in one of several supported languages and receive pass/fail feedback against a suite of test cases.
- View live contest leaderboards while a competition is running.

**Out of scope:**
- Authentication and profile management (assumed handled by an identity service).
- Billing or premium tier enforcement.
- Social features (discuss, comments, friends).
- Analytics and recommendation features.

### Non-Functional Requirements

- **Security first.** User-submitted code is adversarial by default; it must never be able to touch host resources, the network, or other users' submissions.
- **Latency budget.** A submission should return a verdict within roughly five seconds under normal load.
- **Burst scale.** A weekly contest can produce tens of thousands of submissions inside a sixty-second window at start time.
- **Availability over strong consistency.** A slightly stale leaderboard is acceptable; a downed submission pipeline during a contest is not.
- **Fair execution.** Two users' solutions that hit the same test cases should see comparable wall-clock execution time so that time-based tiebreaks remain meaningful.

---

## Core Entities

| Entity | Key Fields | Notes |
|---|---|---|
| **Problem** | `problemId`, `title`, `description`, `difficulty`, `tags[]`, `codeStubs{lang -> stub}`, `testCases[]` | Test cases stored in a language-neutral JSON shape; deserialised inside the worker. |
| **Submission** | `submissionId`, `userId`, `problemId`, `language`, `sourceCode`, `status`, `runtimeMs`, `memoryKb`, `failedCaseIdx`, `createdAt` | Terminal statuses: `ACCEPTED`, `WRONG_ANSWER`, `TLE`, `MLE`, `RUNTIME_ERROR`, `COMPILE_ERROR`. |
| **User** | `userId`, `handle`, `rating`, `stats` | Implicit; sourced from the auth/identity service. User identity is always taken from the JWT, never the request body. |
| **Contest** | `contestId`, `startTs`, `endTs`, `problemIds[]`, `scoringRules` | Scoring is typically "distinct problems solved, ties broken by earliest first-solve time." |
| **LeaderboardEntry** | `contestId`, `userId`, `score`, `penaltyTs` | Kept hot in Redis as a sorted set for the duration of the contest. |

---

## API Design

All endpoints live behind an authenticated gateway; `userId` comes from the session token, never the payload.

```
GET  /v1/problems?cursor=<opaque>&limit=50&difficulty=&tag=
     -> paginated problem summaries

GET  /v1/problems/{problemId}?language=python3
     -> full description + language-specific stub (test cases are NOT returned)

POST /v1/problems/{problemId}/submit
     body: { "language": "python3", "code": "<source>" }
     -> { "submissionId": "sub_abc", "status": "QUEUED" }

GET  /v1/submissions/{submissionId}
     -> { "status": "ACCEPTED" | "RUNNING" | ..., "runtimeMs": 82, "failedCaseIdx": null }
     (client polls ~1 Hz; 202 while running, 200 on terminal state)

GET  /v1/contests/{contestId}/leaderboard?cursor=&limit=100
     -> top-N entries plus the caller's own rank
```

Notes:
- `POST /submit` is intentionally asynchronous. It returns a handle, not a verdict.
- `GET /submissions/{id}` is the polling endpoint; alternatively a thin WebSocket/SSE layer can push the same state change, but polling is cheaper and simpler.
- The leaderboard endpoint is paginated plus a "give me my own rank" side-channel so users deep in the standings do not have to page through everyone above them.

---

## High-Level Design

```
                 +---------------+
     Browser --->| API Gateway   |---> Auth / JWT
                 +-------+-------+
                         |
                         v
                 +---------------+         +------------------+
                 | Submission    |-------->| Submission Queue |
                 | Service       |         | (SQS / Kafka)    |
                 +-------+-------+         +---------+--------+
                         |                           |
                         |                           v
                         |                 +-------------------+
                         |                 | Worker Pool       |
                         |                 |  (containerised   |
                         |                 |   sandboxes)      |
                         |                 +----+--------+-----+
                         |                      |        |
                         v                      v        v
                 +---------------+     +-----------+  +------------+
                 | Problem Store |     | Submission|  | Leaderboard|
                 | (DynamoDB)    |     | Store     |  | (Redis ZSET)|
                 +---------------+     +-----------+  +------------+
```

Request flow for a submission:

1. Client hits `POST /submit`. The Submission Service writes a `QUEUED` row to the submission store and publishes a job containing `{submissionId, problemId, language, codeRef}` onto the queue.
2. A worker picks the job up, pulls the problem's test cases (cached locally or from the problem store), and runs the user code inside a hardened sandbox against each case sequentially with per-case time and memory budgets.
3. On completion the worker writes the verdict back to the submission store and, if the submission is part of a live contest, performs a `ZADD` on the contest's sorted set in Redis.
4. The client has been polling `GET /submissions/{id}` the whole time and now sees the terminal state.

Why these components:
- **Queue** decouples bursty submissions from slow execution, so the API stays responsive even when workers are saturated.
- **Redis sorted set** is a natural fit for rank queries: `ZRANGE` and `ZREVRANGE` are O(log N + M).
- **Problem store** is read-heavy and mostly immutable; a key-value store with heavy caching is sufficient.

---

## Deep Dives

### 1. Secure Code Execution Sandbox

Running untrusted code is the defining challenge of this design. A naive implementation is disqualifying and each layer of hardening addresses a specific attack surface.

**Naive: run in the API process.** Immediately disqualifying. A malicious submission can `rm -rf /`, exfiltrate environment variables (including database credentials and cloud IAM tokens), launch outbound network connections from the API server's identity, or fork-bomb the host. There is no recovery path from this design.

**Baseline: Docker containers with a hardened profile.** Each submission runs in a fresh container built from a per-language base image. The container must be configured with all of the following:
- Read-only root filesystem with a small writable `tmpfs` for compiler output and scratch space, capped at a few MB.
- CPU and memory cgroup limits (e.g. 1 vCPU, 256 MB RAM) so a runaway submission cannot monopolise host resources.
- Wall-clock timeout enforced by the worker process externally via `SIGKILL` — not just CPU time limits — because a sleeping submission consumes no CPU but still occupies the sandbox slot.
- `--network=none` to completely eliminate outbound TCP/UDP. A submission that opens a socket to exfiltrate answers or communicate with an accomplice must be impossible.
- All Linux capabilities dropped (`--cap-drop=ALL`), `--no-new-privileges` set, and a non-root UID inside the container.
- A restrictive seccomp-bpf profile that whitelists only the syscalls needed to compile and run code. Dangerous syscalls — `ptrace`, `mount`, `socket`, `clone` with `CLONE_NEWUSER` — are blocked at the kernel level regardless of what the container runtime would normally allow.

**Hardened: microVMs (Firecracker / gVisor).** Docker containers share the host kernel. A kernel-level exploit embedded in user code could escape the container and compromise the host or all co-located submissions on that machine. Two production-grade alternatives exist:
- **gVisor**: Intercepts all syscalls in user space via a Go-based kernel implementation. User code never directly reaches the host kernel. The trade-off is a ~10-20% CPU overhead and incompatibility with some kernel features.
- **Firecracker microVMs**: Each submission runs inside a lightweight virtual machine with its own minimal kernel. Startup time is ~125ms, which is fast enough for code judges when pre-warmed. This is the isolation model used by AWS Lambda. A kernel exploit in user code cannot cross the VM boundary.

For interview purposes: mention seccomp-bpf as the minimum acceptable baseline, Firecracker as the production-grade answer for multi-tenant safety.

**Test harness.** Test cases are stored once in a neutral JSON shape (arrays, primitives, encoded tree/graph structures). Each language's worker image ships with a small runner that deserialises the inputs into language-native types — for example, an array of integers becomes a `TreeNode` via level-order decoding for a tree problem — invokes the user's entry function, and serialises the output for comparison. This avoids duplicating test data per language and ensures that the comparison logic is consistent across all language runtimes.

**Streaming partial verdicts.** Rather than running all test cases before returning any result, the worker can stream partial verdicts back: "Test 1: Passed, Test 2: Passed, Test 3: Wrong Answer — Expected 5, Got 4." This dramatically improves perceived latency (users see progress immediately) and allows early termination on the first failure, saving execution time and compute cost. Each partial result is written to the submission store so the polling endpoint can surface it incrementally.

### 2. Queue-Based Asynchronous Execution

A contest can produce ~10k submissions in the first minute. If a submission runs 100 test cases at ~100 ms each, that is ~10 CPU-seconds of work per submission, so 10k submissions = 100k CPU-seconds to clear in 60 seconds = roughly 1,700 cores needed instantaneously. Provisioning that synchronously off the API servers is both technically and economically infeasible.

**Design:**
- `POST /submit` returns immediately after enqueueing. The API server never blocks on execution.
- Worker auto-scaling is driven by queue depth (or `ApproximateNumberOfMessagesVisible` in SQS terms), not CPU on the API tier. This allows the two tiers to scale independently.
- Workers are stateless and ephemeral: after executing a submission, the container is destroyed and a fresh one is started. This ensures that no state from one submission can bleed into the next — no lingering files, no cached secrets, no residual process state.
- Visibility timeouts and idempotent worker logic protect against duplicate execution if a worker dies mid-job. The submission's status transitions (`QUEUED` → `RUNNING` → terminal) must be atomic writes so that a re-queued job detects an already-completed execution and skips re-running.
- Dead-letter queues capture submissions that repeatedly fail, for example because a worker image has a regression for a specific language version.
- Pre-warming a pool of idle containers or microVMs reduces cold-start latency to under 100ms, which is essential for meeting the five-second end-to-end SLA.

**Contest burst handling.** When a contest with 10K participants starts simultaneously, spinning up 10K containers on demand would take minutes. The solution is to pre-warm a pool of idle containers five to ten minutes before the contest start time. When the contest opens, incoming submissions draw immediately from the warm pool. Auto-scaling refills the pool asynchronously so it never runs dry. The contest schedule feeds directly into the capacity planner; burst readiness is a proactive operation, not a reactive one.

**Trade-off:** the price of decoupling is that the client experience becomes "submit, then poll." The ~1 Hz polling cadence is the accepted UX cost. An optional SSE or WebSocket layer can push verdict events instead, but polling is simpler to operate and sufficient for most users.

### 3. Contest Leaderboards

A contest leaderboard needs to update within a few seconds of a submission being accepted, for potentially hundreds of thousands of concurrent viewers. Doing this with `SELECT COUNT(*) WHERE score > ?` on the submission table for each rank request requires a full O(N) table scan per user query. At 10K participants that is already expensive; at 100K it is fatal.

**Chosen design: Redis sorted set per contest.**
- Key: `contest:{contestId}:leaderboard`.
- Score: encoded as `(problems_solved * -1e12) + penalty_timestamp_ms`, so that `ZRANGE ... 0 N` gives the correct ordering — more problems solved first, with earlier finish time breaking ties.
- On every `ACCEPTED` submission during a contest, the worker performs a single `ZADD` (or `ZINCRBY` if the scoring model is incremental). This is an O(log N) write.
- Read path: `ZREVRANGE` for the top N entries, `ZREVRANK` for the caller's own rank. Both are O(log N) operations. For a 10K-participant contest, rank lookup takes microseconds rather than the seconds a database scan would require.
- The sorted set is hydrated at contest start from a cold snapshot and torn down (persisted to cold storage) at contest end so Redis memory does not grow unbounded across historical contests.

This design keeps the primary database entirely out of the live read path, gives near-real-time ranks, and scales horizontally by dedicating a separate Redis cluster to each large contest.

### 4. Cheating Detection

Once money, ratings, or hiring signals are on the line, cheating appears. This pipeline is offline and heuristic rather than in-band — it must never sit on the synchronous submit path, because adding latency or blocking verdicts for every honest user is an unacceptable trade-off.

- **Submission timing fingerprints.** Flag users whose first submissions for each problem land within implausibly short windows after contest start, especially on hard problems. Solving a hard dynamic programming problem in under 90 seconds from the moment the contest opens is statistically improbable without prior knowledge.
- **Code similarity.** Tokenise submissions (strip whitespace, normalise identifiers) and compare via MinHash or winnowing fingerprints across all contest submissions for a given problem. Tight clusters of near-identical solutions from distinct users surface copy-paste or leaked solutions. Similarity above a threshold triggers manual review.
- **IP and device clustering.** Multiple high-scoring accounts originating from a single device fingerprint or residential IP range during a contest is a strong signal of a coordinated proxy submission ring.
- **Behavioural signals.** Paste events, editor focus loss, and suspiciously low keystroke counts relative to final code length are collected client-side and attached to the submission as metadata. A submission where the user typed three characters and pasted the rest warrants scrutiny.
- **Post-hoc review queue.** Flagged submissions enter a moderation queue where a reviewer can invalidate results and adjust the leaderboard after the contest ends. Leaderboards are published as "provisional" until the review window closes, typically a few hours after contest end.

The cheating detection pipeline reads from the submission store and the event bus as an offline consumer. It never touches the real-time execution path.

---

## Scaling Journey: 0 to Infinity

### Stage 1: 0 to 100 Users (MVP)

**Goal:** Prove the product works end to end for a small set of early users; keep cost at near-zero; iterate on problem content.

**Architecture:**
- Single monolithic web service (API + rendering) on one VM.
- One Postgres instance holding `problems`, `submissions`, `users`.
- Code execution runs **inline** in a Docker container spawned by the same server on submit; the HTTP request blocks until the verdict is ready.
- Test cases stored as JSON columns on the problem row.

**What you skip:** queue, Redis, auto-scaling, microVMs, contest feature. No leaderboard. No polling endpoint.

**Failure mode that pushes to next stage:** At ~100 concurrent users the inline execution model starves the web server. A few slow submissions (TLE cases, compile timeouts) pin request-handling threads and cause all users' pages to hang. The server crashes under a modest load spike.

### Stage 2: 100 to 1,000 Users

**Goal:** Decouple execution from the request path and stop HTTP threads from being held hostage by user code.

**Architecture changes:**
- Introduce a **submission queue** (start with Redis Lists or SQS; Kafka is overkill here).
- Split out a **worker pool** of small VMs, each running Docker to sandbox individual submissions.
- `POST /submit` now returns a `submissionId` immediately; client polls `GET /submissions/{id}`.
- Add a read replica to Postgres to absorb polling traffic.
- Static assets move behind a CDN.

**What you skip:** microVMs, Redis sorted sets, contest pipeline, auto-scaling. Workers are a fixed small pool sized for peak non-contest load.

**Failure mode that pushes to next stage:** The first real contest lands. 5,000 users submit inside the first two minutes. The fixed worker pool cannot drain the queue; submissions sit queued for minutes, breaking the five-second SLA. Simultaneously, a SQL `GROUP BY user` query powering the leaderboard times out under the read load.

### Stage 3: 1K to 100K Users

**Goal:** Handle contest bursts and make the leaderboard real-time without hammering the database.

**Architecture changes:**
- **Auto-scaling worker pool** driven by queue depth; scale-out begins minutes before scheduled contest start via a warm-up job.
- **Redis sorted set per contest** for the leaderboard, updated by workers on `ACCEPTED`.
- **Result cache** in Redis keyed by `SHA256(code + problemId + language)` short-circuits duplicate submissions (users resubmitting identical code) and speeds up deterministic replays. Cache is invalidated per-problem when test cases change.
- Primary store migrates from Postgres to a partitioned setup: problems in a key-value store with heavy caching, submissions in a wide-column store (DynamoDB or Cassandra) partitioned by `userId` with a GSI on `contestId`.
- Separate **problem-read service** fronted by a CDN for problem descriptions, which are essentially static.

**What you skip:** microVM isolation (still on plain Docker), cross-region replication, cheating detection pipeline.

**Failure mode that pushes to next stage:** Two events coincide. First, a security researcher demonstrates a container escape using a kernel CVE, and during triage it becomes clear that a single tenant break-out would affect all co-located submissions on that host. Second, a flagship contest with 250k registered users makes clear that even aggressive autoscaling cannot bring up plain EC2+Docker fast enough; cold starts are on the critical path.

### Stage 4: 100K to 10M Users

**Goal:** Industrial-grade isolation, sub-second worker cold start, and operable contests at global scale.

**Architecture changes:**
- Replace plain Docker with **Firecracker microVMs** (or gVisor) for per-submission isolation. A second kernel boundary means a container escape is no longer a cross-tenant compromise.
- Maintain a **warm pool** of pre-booted sandboxes per language so that submit-to-start latency stays in the tens of milliseconds.
- **Per-language worker fleets** so that a spike in one language (e.g. a Python-heavy contest) does not starve others.
- **Regional worker pools** close to the user, with the submission queue regionalised. Contest results are reconciled back to a global submission store asynchronously.
- **Offline cheating-detection pipeline** consuming a submission event stream: code-similarity (MinHash), timing fingerprints, IP clustering, post-hoc leaderboard adjustment.
- **Backpressure and fairness** in the queue: weighted fair queuing across contests so that one popular contest cannot starve another.

**What you skip:** Multi-region active-active writes for submissions (still single-region primary with async replication), fully custom kernel hardening.

**Failure mode that pushes to next stage:** At tens of millions of users the single-region submission store becomes a blast radius. A regional outage during a global contest blacks out the entire platform for the contest window. Also, the shared Redis cluster holding every live contest's leaderboard starts to show hot-key contention on marquee events where a single contest accounts for most of the traffic.

### Stage 5: 10M+ Users

**Goal:** Multi-region resilience, zero-downtime contests, and per-contest capacity isolation.

**Architecture changes:**
- **Multi-region active-active** submission path. A submission is accepted in the user's nearest region, executed locally, and asynchronously replicated to a global store for profile and history views. Consistency is eventual; during a region failover, users may briefly see stale history but can still submit.
- **Per-contest sharded leaderboard.** A single marquee contest gets its own dedicated Redis cluster, pre-provisioned from the contest schedule. Reads are served from regional replicas; writes go to the primary and fan out.
- **Tiered storage for submissions.** Hot submissions (last 30 days) in the primary KV store; warm in cheaper columnar storage; cold in object storage with an index. Drives down cost at this volume.
- **Capacity pre-allocation.** Contest scheduling directly feeds the capacity planner; worker fleets, Redis clusters, and queue partitions are provisioned before the contest opens rather than reactively.
- **End-to-end cheating detection pipeline** running continuously, including client-side behavioural telemetry (paste, focus, keystroke cadence) joined against code-similarity graphs.
- **Chaos testing and game-day drills** on the full contest path, because at this scale a contest-day incident is a company-wide event.

**What you skip:** Nothing obvious is skipped; at this stage the work is less about adding components and more about operational maturity.

---

## Insider Tips and Tricks

These are the specific, non-obvious points that separate candidates who have thought deeply about sandboxed execution from those who have only sketched the surface.

### You Cannot Use a Thread Pool for Code Execution

Thread pools reuse OS threads across tasks. A malicious submission that calls `while(true){}` or allocates unbounded memory will kill or starve every other thread in the pool — it does not stay contained to its own thread. A thread is not an isolation boundary; it is merely a scheduling unit within the same process and the same address space.

The minimum acceptable floor is one process per submission. Each submission must run in a fully isolated process that can be killed without affecting any other submission. One container per submission is the production standard. Thread-per-submission is categorically wrong regardless of how convenient it sounds.

### Docker Is Insufficient Isolation for Multi-Tenant Code Execution

Docker containers share the host kernel. A kernel exploit embedded in user code — a crafted sequence of syscalls that triggers a privilege escalation CVE — can escape the container entirely and gain root on the host, compromising every other submission currently running on that machine.

Production sandboxes use one of three approaches to add a second isolation boundary:
- **seccomp-bpf syscall whitelists**: A BPF program attached to the process intercepts every syscall and blocks dangerous ones (`ptrace`, `mount`, `socket`, `clone` with `CLONE_NEWUSER`). This does not prevent kernel exploits but dramatically shrinks the attack surface.
- **gVisor**: Intercepts all syscalls in user space via a user-space kernel written in Go. User code never directly reaches the host kernel. Higher CPU overhead but no VM startup cost.
- **Firecracker microVMs**: Each submission runs inside a minimal virtual machine with a 125ms cold-start time (used by AWS Lambda). A kernel exploit in user code cannot cross the VM boundary — it is contained within the guest kernel.

For interview purposes: mention seccomp-bpf as the minimum acceptable hardening on top of Docker, and Firecracker as the production-grade answer for multi-tenant safety. Saying "we use Docker" without mentioning seccomp-bpf or a microVM layer is an incomplete answer at senior and staff levels.

### Time Limits Require Two Separate Enforcement Mechanisms

`RLIMIT_CPU` limits CPU time — the amount of time the CPU actually spends executing instructions for this process. It does not count wall-clock time spent sleeping, waiting on I/O, or blocked on a mutex. A submission that calls `time.sleep(60)` or blocks forever on a socket read consumes zero CPU time and will never be killed by `RLIMIT_CPU` alone.

Both mechanisms are required:
- **`RLIMIT_CPU`**: Kills compute-intensive infinite loops (a tight `while(true)` loop that pegs the CPU). This is set directly on the sandboxed process.
- **External watchdog process**: The worker process starts a timer when it launches the sandbox. After N wall-clock seconds it sends `SIGKILL` to the sandbox process group. This kills sleeping submissions, I/O-blocking submissions, and any submission that has paused execution through non-CPU means.

Omitting either mechanism leaves a category of malicious or buggy submissions undetected.

### Memory Limits: cgroups vs RLIMIT_AS

`RLIMIT_AS` limits the virtual address space of a process — the range of addresses that can be mapped. This is not the same as physical memory usage. A program can `mmap` a large region (consuming virtual address space) without ever touching the pages, using essentially zero physical RAM. Conversely, a program can SIGSEGV before hitting `RLIMIT_AS` if it touches pages that exhaust actual physical memory first. `RLIMIT_AS` enforcement is therefore unpredictable.

cgroup memory limits track actual RSS (Resident Set Size) — the physical pages currently in use by the process. When a cgroup's memory limit is reached, the kernel OOM-killer fires predictably and terminates the process, returning a clean signal to the worker. Production judges use cgroup memory limits, not `RLIMIT_AS`, for accurate and predictable memory enforcement.

### Workers Must Be Ephemeral and Stateless

After each submission finishes, the container or microVM is destroyed. A fresh one is started for the next submission. This is not optional hygiene — it is a correctness requirement. A non-ephemeral worker can leak state between submissions in multiple ways:
- User A's code writes a file to a shared `tmpfs`. User B's code on the same worker reads that file and copies the answer.
- A memory-unsafe language leaves heap memory that the next process might partially read.
- Resource accounting (memory high-watermark, file descriptor counts) does not reset, causing false MLE verdicts on submissions that are clean.

Destroying and recreating containers has latency cost. This is mitigated by maintaining a **warm pool** of pre-initialized idle containers. When a submission arrives it claims a container from the warm pool (latency under 100ms), executes, and the container is discarded. The pool is refilled asynchronously. This achieves both safety (ephemeral containers) and performance (no cold-start penalty in the hot path).

### Contest Burst Handling Requires Pre-Warmed Capacity

When a contest with 10K participants opens simultaneously, the submission rate spikes from near-zero to thousands of submissions per minute in seconds. Reactive auto-scaling — spinning up containers only after the spike arrives — is too slow. Container startup takes seconds; VM startup takes tens of seconds; acquiring new EC2 instances takes minutes. By the time new capacity is live, the burst has already violated the latency SLA.

The solution is proactive pre-warming:
1. The contest schedule is known in advance. Five to ten minutes before start time, a capacity planner pre-warms a pool of N idle containers — sized based on registered participant count and historical submission rates.
2. When the contest opens, submissions draw immediately from the pre-warmed pool. There is no cold-start latency.
3. Auto-scaling refills the pool asynchronously. As the pool drains, new containers are started in the background, maintaining a buffer.

Pre-warming is the difference between a smooth contest launch and a queue backlog that takes twenty minutes to drain.

### Leaderboard Is a Redis Sorted Set, Not a Database Query

The intuitive implementation of "get my rank" is a SQL query: `SELECT COUNT(*) FROM leaderboard WHERE score > :my_score`. This is an O(N) full table scan. At 10K participants it is slow; at 100K participants it is a denial-of-service attack on the database during the highest-traffic moment of the week.

Redis sorted sets solve this with purpose-built data structures:
- `ZADD contest:{id} score userId` inserts or updates a score in O(log N).
- `ZREVRANK contest:{id} userId` returns the user's rank in O(log N).
- `ZREVRANGE contest:{id} 0 99` returns the top 100 users in O(log N + 100).

For a 10K-participant contest, rank lookup takes microseconds with Redis versus seconds with a database scan. The sorted set is the canonical answer whenever a leaderboard or ranking feature appears in a system design problem.

Score encoding for multi-criteria ranking (problems solved first, then earliest finish time): `score = (problems_solved * 1e12) - penalty_timestamp_ms`. This encodes both dimensions into a single float such that `ZREVRANGE` returns the correct ordering without any post-processing.

### Identical Submission Caching Short-Circuits Execution

For popular problems, a large fraction of accepted submissions are functionally identical — the canonical two-sum with a hash map looks the same across tens of thousands of users, modulo variable names. Running each of those through the full judge pipeline wastes compute.

The solution is a result cache keyed by `SHA256(normalized_code + problemId + language)`. Before executing a submission, the worker checks the cache. On a hit it returns the cached verdict immediately, skipping execution entirely. On a miss it executes normally and writes the result to the cache.

Cache invalidation is scoped: when test cases for a problem are modified, all cached results for that `problemId` are invalidated. This ensures that a cached ACCEPTED verdict from before a test case was fixed does not persist after the fix.

This optimization is particularly valuable during contests, where many participants submit near-identical solutions for straightforward problems, and during the first few minutes after a popular problem is published.

### Partial Verdicts Before Full Execution Improve UX and Save Compute

The naive implementation runs all test cases, then returns a single verdict. From the user's perspective this means staring at "Running..." for several seconds before seeing any information at all.

A better design streams partial verdicts as each test case completes. The worker writes intermediate results to the submission store after each test case: "Test 1: Passed (12ms), Test 2: Passed (14ms), Test 3: Wrong Answer — Expected 5, Got 4." The polling endpoint surfaces these intermediate states. The user sees progress in real time and knows exactly which test case failed.

Two engineering benefits beyond UX:
- **Early termination**: Once a test case fails, the worker can stop execution immediately. For a submission that fails on test case 3 of 100, the judge does 3% of the work instead of 100%. At scale this represents significant compute savings.
- **Debugging signal**: Showing the specific failing test case and the actual versus expected output is far more useful to the user than "Wrong Answer." It enables immediate diagnosis without requiring the user to download and run test cases locally.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What a strong signal looks like |
|---|---|---|
| **Mid (IC4)** | ~80 / 20 | Clean API and data model. Correctly identifies that code must run in an isolated sandbox (container / VM / serverless) rather than in the API server. Walks through the happy-path submit flow end to end. Lets the interviewer pick which area to deepen. |
| **Senior (IC5)** | ~60 / 40 | Moves quickly through the high-level design and spends real time on trade-offs: Docker vs Firecracker vs Lambda, synchronous vs queued execution, direct-DB vs Redis sorted set for the leaderboard. Describes the test-harness serialisation strategy concretely rather than hand-waving "we run test cases." Calls out burst arithmetic (cores needed for a contest spike) and justifies auto-scaling on queue depth. Mentions seccomp-bpf as a minimum sandbox hardening and distinguishes `RLIMIT_CPU` from wall-clock timeouts. |
| **Staff+ (IC6+)** | ~40 / 60, candidate-led | Drives the conversation. Identifies non-obvious failure modes: hot-key contention on a marquee contest, cross-tenant escape risk from a shared kernel, fairness across contests in a shared queue, `RLIMIT_AS` vs cgroup memory semantics. Proposes a minimal design with a clear upgrade path rather than inventing infrastructure that is not justified by scale. Proactively raises pre-warming for contest bursts, identical-submission caching, and partial verdict streaming as concrete optimisations with measurable impact. Can go deep on any one component — sandbox internals, leaderboard score encoding, cheating-detection heuristics — without hand-holding. |

**Common traps to avoid at any level:**
- Running user code in the API process "just to get started" — it is disqualifying, not a stepping stone.
- Using a thread pool for code execution — threads share address space and cannot isolate runaway code.
- Trying to keep `POST /submit` synchronous. The latency and failure modes force asynchronous processing almost immediately.
- Relying solely on `RLIMIT_CPU` for time enforcement without a wall-clock watchdog process.
- Using `RLIMIT_AS` for memory enforcement instead of cgroup memory limits.
- Reaching for WebSockets for the leaderboard when 1 Hz polling of a Redis sorted set is simpler and sufficient.
- Treating cheating detection as an in-band check on the submit path; it belongs in an offline pipeline.
- Claiming Docker is sufficient isolation without mentioning seccomp-bpf or a microVM layer.
