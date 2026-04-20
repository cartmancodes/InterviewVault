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
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

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

Running untrusted code is the defining problem here. Three increasingly paranoid layers are usually discussed:

**Naive: run in the API process.** Disqualifying. A malicious submission can `rm -rf`, exfiltrate secrets, or launch outbound connections on behalf of the API server.

**Baseline: Docker containers.** Each submission runs in a fresh container built from a per-language base image. The container is configured as:
- Read-only root filesystem with a small writable `tmpfs` for compiler output.
- CPU and memory cgroup limits (e.g. 1 vCPU, 256 MB).
- Wall-clock timeout enforced externally by the worker (e.g. 5s total, plus per-case cap).
- `--network=none` to eliminate outbound traffic.
- Dropped Linux capabilities, a restrictive seccomp profile, and a non-root UID inside the container.
- No bind mounts except the read-only source code drop.

**Hardened: microVMs (Firecracker / gVisor).** Containers share the host kernel, so a kernel-level exploit is a cross-tenant break-out. Firecracker or gVisor put a second isolation boundary (a minimal VM or a user-space kernel) around each execution. The cost is a modest cold-start overhead that can be amortised with a warm pool of pre-booted sandboxes.

**Test harness.** Test cases are stored once in a neutral JSON shape (arrays, primitives, encoded tree/graph structures). Each language's worker image ships with a small runner that deserialises the inputs into language-native types (e.g. an array becomes a `TreeNode` via level-order decoding), invokes the user's entry function, and serialises the output for comparison. This avoids duplicating test data per language.

### 2. Queue-Based Asynchronous Execution

A contest can produce ~10k submissions in the first minute. If a submission runs 100 test cases at ~100 ms each, that is ~10 CPU-seconds of work per submission, so 10k submissions = 100k CPU-seconds to clear in 60 seconds = ~1,700 cores. Provisioning that synchronously off the API servers is both technically and economically wrong.

**Design:**
- `POST /submit` returns immediately after enqueueing.
- Worker auto-scaling is driven by queue depth (or `ApproximateNumberOfMessagesVisible` in SQS terms), not CPU on the API tier.
- Workers are stateless so they can be torn down aggressively after a contest ends.
- Visibility timeouts and idempotent worker logic protect against duplicate execution if a worker dies mid-job.
- Dead-letter queues capture submissions that repeatedly fail, e.g. because a worker image is broken.

**Trade-off:** the price of decoupling is that the client experience becomes "submit, then poll." We accept ~1 Hz polling as the UX cost.

### 3. Contest Leaderboards

A contest leaderboard needs to update within a few seconds of a submission being accepted, for potentially hundreds of thousands of concurrent viewers. Doing this with `SELECT ... GROUP BY user ORDER BY score` on the submission table every few seconds will crush the database.

**Chosen design: Redis sorted set per contest.**
- Key: `contest:{contestId}:leaderboard`.
- Score: encoded as `(problems_solved * -1e12) + penalty_timestamp_ms`, so that `ZRANGE ... 0 N` gives the correct ordering (more problems first, earlier finish breaks ties).
- On every `ACCEPTED` submission during a contest, the worker does a single `ZADD` (or `ZINCRBY` if the scoring model is incremental).
- Read path: `ZRANGE` for the top N, `ZRANK` for the caller's own rank.
- The sorted set is hydrated at contest start and torn down (persisted to cold storage) at contest end so Redis memory does not grow unbounded.

This gives near-real-time ranks, keeps the primary database out of the read path, and scales horizontally by sharding contests across Redis nodes (one contest = one shard is usually fine because contests are bounded).

### 4. Cheating Detection

Once money, ratings, or hiring signals are on the line, cheating appears. This is typically offline and heuristic rather than in-band:

- **Submission timing fingerprints.** Flag users whose first submissions for each problem land within implausibly short windows of contest start, especially on hard problems.
- **Code similarity.** Tokenise submissions (drop whitespace, identifiers) and compare via MinHash / winnowing fingerprints across all contest submissions. Tight clusters of near-identical solutions from distinct users surface copy-paste or leaked solutions.
- **IP / device clustering.** Multiple high-scoring accounts from a single device or residential IP range during a contest is a strong signal.
- **Behavioural signals.** Paste events, editor focus loss, and suspiciously low keystroke counts relative to final code length are collected client-side and attached to the submission.
- **Post-hoc review queue.** Flagged submissions go into a moderation queue where a reviewer can invalidate results and adjust the leaderboard after the contest ends. This is why leaderboards can be "provisional" until a few hours after the contest.

Crucially, cheating detection is an **offline** pipeline reading from the submission store and event bus; it never sits in the synchronous submit path.

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
- **Result cache** in Redis keyed by `(problemId, codeHash, language)` short-circuits duplicate submissions (users resubmitting identical code) and speeds up deterministic replays.
- Primary store migrates from Postgres to a partitioned setup: problems in a key-value store with heavy caching, submissions in a wide-column store (DynamoDB or Cassandra) partitioned by `userId` with a GSI on `contestId`.
- Separate **problem-read service** fronted by a CDN for problem descriptions, which are essentially static.

**What you skip:** microVM isolation (still on plain Docker), cross-region replication, cheating detection pipeline.

**Failure mode that pushes to next stage:** Two events coincide. First, a security researcher demonstrates a container escape using a kernel CVE, and during triage it becomes clear that a single tenant break-out would affect the co-located submissions on that host. Second, a flagship contest with 250k registered users makes clear that even aggressive autoscaling cannot bring up plain EC2+Docker fast enough; cold starts are on the critical path.

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
- **Multi-region active-active** submission path. A submission is accepted in the user's nearest region, executed locally, and asynchronously replicated to a global store for profile/history views. Consistency is eventual; during a region failover, users may briefly see stale history but can still submit.
- **Per-contest sharded leaderboard.** A single marquee contest gets its own dedicated Redis cluster, pre-provisioned from the contest schedule. Reads are served from regional replicas; writes go to the primary and fan out.
- **Tiered storage for submissions.** Hot submissions (last 30 days) in the primary KV store; warm in cheaper columnar storage; cold in object storage with an index. Drives down cost at this volume.
- **Capacity pre-allocation.** Contest scheduling directly feeds the capacity planner; worker fleets, Redis clusters, and queue partitions are provisioned before the contest opens rather than reactively.
- **End-to-end cheating detection pipeline** running continuously, including client-side behavioural telemetry (paste, focus, keystroke cadence) joined against code-similarity graphs.
- **Chaos testing and game-day drills** on the full contest path, because at this scale a contest-day incident is a company-wide event.

**What you skip:** Nothing obvious is skipped; at this stage the work is less about adding components and more about operational maturity.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What a strong signal looks like |
|---|---|---|
| **Mid (IC4)** | ~80 / 20 | Clean API and data model. Correctly identifies that code must run in an isolated sandbox (container / VM / serverless) rather than in the API server. Walks through the happy-path submit flow end to end. Lets the interviewer pick which area to deepen. |
| **Senior (IC5)** | ~60 / 40 | Moves quickly through the high-level design and spends real time on trade-offs: Docker vs Firecracker vs Lambda, synchronous vs queued execution, direct-DB vs Redis sorted set for the leaderboard. Describes the test-harness serialisation strategy concretely rather than hand-waving "we run test cases." Calls out burst arithmetic (cores needed for a contest spike) and justifies auto-scaling on queue depth. |
| **Staff+ (IC6+)** | ~40 / 60, candidate-led | Drives the conversation. Identifies non-obvious failure modes (hot-key contention on a marquee contest, cross-tenant escape risk, fairness across contests in a shared queue). Proposes a minimal design with a clear upgrade path rather than inventing infrastructure that is not justified by scale. Can go deep on any one component - sandbox internals, leaderboard scoring encoding, cheating-detection heuristics - without hand-holding. |

**Common traps to avoid at any level:**
- Running user code in the API process "just to get started" - it is disqualifying, not a stepping stone.
- Trying to keep `POST /submit` synchronous. The latency and failure modes force asynchronous processing almost immediately.
- Reaching for WebSockets for the leaderboard when 1 Hz polling of a Redis sorted set is simpler and sufficient.
- Treating cheating detection as an in-band check on the submit path; it belongs in an offline pipeline.
