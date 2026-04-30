# Design Job Scheduler

> **Pattern**: Cron / Distributed Scheduler
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Timed Dispatch: Finding Due Jobs on Time](#1-timed-dispatch-finding-due-jobs-on-time)
   - [2. Leader Election for the Dispatcher](#2-leader-election-for-the-dispatcher)
   - [3. Idempotency Keys and Deduplication](#3-idempotency-keys-and-deduplication)
   - [4. At-Least-Once vs Exactly-Once Execution](#4-at-least-once-vs-exactly-once-execution)
   - [5. Retries, Backoff, and Dead-Letter Handling](#5-retries-backoff-and-dead-letter-handling)
   - [6. Time Zone and DST Correctness](#6-time-zone-and-dst-correctness)
   - [7. Missed-Job Policy](#7-missed-job-policy)
   - [8. Job Output Storage](#8-job-output-storage)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A job scheduler lets clients register work to run at a specific point in time (one-shot or recurring) and then reliably dispatches that work to a pool of executors when its trigger time arrives. The interesting engineering is not the CRUD surface that accepts the job definition; it is the invariant that a job scheduled for `T` actually fires near `T` even when servers die, leaders fail over, the clock drifts, or a million other jobs are due in the same second. A good design separates three concerns cleanly: storing the schedule, picking the "due" set at the right moment, and delivering those items to workers in a way that survives duplicates.

### Functional Requirements

**Core:**
- Register a job to run once at a specific future timestamp.
- Register a job to run on a recurring schedule (cron expression or interval).
- Register an immediate one-shot job that should execute as soon as possible.
- Query the status of a job (next run time, last run result, history of runs).
- List runs for a job with pagination, including success/failure outcome and execution duration.

**Out of scope (below the line):**
- Cancelling or rescheduling an in-flight job (treated as a separate admin flow if needed at all).
- Complex job DAGs with fan-out and fan-in dependencies (this is workflow orchestration, a different product).
- Sending rich notifications on completion (assumed to be implemented by the worker's own handler).

### Non-Functional Requirements

- **Timeliness.** A job scheduled for time `T` should begin executing within a tight bound of `T`, typically within two seconds under normal load.
- **At-least-once execution.** A successfully acknowledged job must run at least once. Losing a job is strictly worse than running it twice.
- **Idempotency surface.** Because the system is at-least-once, every run must carry an identifier that lets downstream handlers deduplicate.
- **Throughput.** Handle bursty fan-in around round-minute boundaries (e.g. tens of thousands of jobs fire at `HH:00:00`).
- **Scale target.** Roughly ten thousand dispatches per second sustained, with spikes an order of magnitude higher.
- **Durability over raw latency.** A lost schedule is a correctness bug; a slightly late fire is an SLO miss but tolerable.
- **Availability of the dispatcher.** There must be exactly one active dispatcher per shard at a time to avoid double-firing, but the system must never be stuck without one.

---

## 🧒 Layman's Explanation

Think of a job scheduler like an **office calendar with recurring meetings**. You tell it "every Monday at 9 AM, sync with marketing," and the calendar app fires the reminder at the right moment without you having to remember. Or picture **a wall of alarm clocks** — fifty of them set throughout the day, each ringing at its appointed minute, some one-time, some recurring. Or a **factory conveyor belt**: at 8 AM the welding robot starts, at 9 AM painting kicks in, at 10 AM packaging — each station triggered on schedule, with later steps depending on earlier ones finishing.

The hard part is the **"wake me at exactly this time" challenge**. A single timer on one machine works for fifty alarms but falls over at fifty thousand — you need a sharded timer system, with the work split across many machines, each responsible for a slice of the schedule. Then comes **idempotency**: if the scheduler fires twice because of a network glitch, you must not run the job twice — otherwise you charge the customer twice, or send the same email twice, or double-book the meeting. The system stamps each firing with a unique key so downstream handlers can recognise duplicates and ignore them.

**Failure handling** is the next puzzle. What if the worker crashes mid-job? Retry — but not forever. Back off between attempts (1s, 2s, 4s, 8s) so a flaky downstream service has time to recover. After enough failures, drop the job in a **dead letter queue** for a human to investigate. **Dependencies** add another layer: Job B can only run after Job A finishes, forming a directed acyclic graph (DAG). Then there's **time zones and DST** — "9 AM daily" in San Francisco vs Tokyo means very different absolute moments, and DST shifts twice a year produce subtle bugs where a 2 AM job runs twice or not at all. Finally, **backfill**: you forgot to run the daily report for two weeks; now you need to run 14 historical jobs in the right order without flooding workers.

### When the analogy breaks down

Real schedulers like Airflow handle thousands of DAGs with millions of task instances, integrate with cloud providers (S3, BigQuery, Kubernetes), manage resource pools so heavy jobs do not starve light ones, and provide rich UIs for engineers to inspect failed jobs, replay them, and trace dependencies across complex workflows. A wall of alarm clocks does not have version control, audit logs, or a debugger.

---

## Core Entities

| Entity | Key Fields | Notes |
|---|---|---|
| **Job** | `jobId`, `ownerId`, `payload`, `schedule`, `nextRunAt`, `timezone`, `maxRetries`, `missedJobPolicy`, `status` | The durable definition of "what to run and when." A recurring job rewrites `nextRunAt` each time it completes a dispatch. `missedJobPolicy` is a per-job enum: `SKIP`, `BACKFILL_ALL`, or `BACKFILL_ONCE`. |
| **Schedule** | `type` (`once` / `cron` / `interval`), `cronExpr`, `intervalMs`, `startAfter`, `endBefore` | Derived, not stored separately; embedded inside the job row. Cron parsing happens when computing `nextRunAt` and must use a time-zone-aware library to handle DST transitions correctly. |
| **Run** | `runId`, `jobId`, `scheduledFor`, `dispatchedAt`, `startedAt`, `finishedAt`, `status`, `attempt`, `lastError`, `idempotencyKey`, `outputRef` | One row per attempt. `idempotencyKey` is typically `hash(jobId, scheduledFor)` so retries of the same scheduled firing share a key. `outputRef` is an object-storage key (e.g. S3 path) pointing to logs and result artifacts; not stored inline. |
| **Worker** | `workerId`, `heartbeatAt`, `capabilities[]`, `currentRunId` | Ephemeral; lives in a service registry (Redis, etcd, or the queue broker's consumer list). Heartbeat drives stale-worker detection. |

---

## API Design

All endpoints live behind an authenticated gateway; `ownerId` is derived from the caller's identity, not the payload.

```
POST /v1/jobs
     body: {
       "payload": { "handler": "sendEmail", "args": {...} },
       "schedule": { "type": "cron", "expr": "0 9 * * *", "tz": "America/Los_Angeles" },
       "maxRetries": 5,
       "missedJobPolicy": "BACKFILL_ONCE",
       "idempotencyKey": "user-123-welcome"   // optional, for client-side dedup of creation
     }
     -> { "jobId": "job_abc", "nextRunAt": "2026-04-21T16:00:00Z" }

GET  /v1/jobs/{jobId}
     -> full job definition plus next run time and last run summary

GET  /v1/jobs/{jobId}/runs?cursor=<opaque>&limit=50
     -> paginated run history with outcome, duration, attempt number

DELETE /v1/jobs/{jobId}
     -> soft-delete; pauses further firings but preserves history
```

Design notes:
- `POST /jobs` is intentionally synchronous and cheap: it writes one row and returns. The hard work happens later, off the hot path.
- `idempotencyKey` on the create endpoint is for deduplicating the creation call itself, which is a different concern from per-run idempotency.
- A separate `POST /v1/jobs/{jobId}/trigger` can expose manual "run now" for operators, producing a `Run` whose `scheduledFor` is `now()`.

---

## High-Level Design

```
                    +---------------+
        Client ---> | API Service   |---> Jobs DB (Postgres / Dynamo)
                    +---------------+        ^
                                             | reads due rows
                                             |
                    +------------------+     |
                    | Dispatcher       |-----+
                    | (leader-elected) |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | Work Queue       |
                    | (Kafka / SQS)    |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | Worker Pool      |----> User handler
                    | (stateless)      |
                    +--------+---------+
                             |
                             v
                    +------------------+
                    | Runs DB          |
                    | (append-only)    |
                    +------------------+
                             |
                             v
                    +------------------+
                    | Object Storage   |
                    | (S3 / GCS)       |
                    | job output/logs  |
                    +------------------+
```

Flow for a single firing:

1. Client calls `POST /jobs`. The API service parses the schedule, computes `nextRunAt` using a time-zone-aware library, and persists the job row.
2. The **Dispatcher** wakes on a short tick (typically every second) and queries the Jobs DB for rows whose `nextRunAt <= now() + lookaheadWindow`. It queries only a bounded near-future window — not the entire table — reducing the scan from O(total jobs) to O(jobs due in the next window).
3. For each due row the dispatcher creates a `Run` row in a `DISPATCHED` state with a stable `idempotencyKey = hash(jobId, scheduledFor)`, and publishes a message to the work queue.
4. If the job is recurring, the dispatcher recomputes the next `nextRunAt` in the same transaction that writes the run row. If the job is one-shot, the dispatcher marks it `COMPLETED_SCHEDULED`.
5. A worker consumes the queue message, claims the run (marks it `RUNNING`), executes the payload, and writes back either `SUCCEEDED` or `FAILED`. Failure paths feed into the retry logic.
6. Job output, logs, and result artifacts are written to object storage; only the S3 key (`outputRef`) is stored in the Runs DB row.

Why these components:
- **Separate dispatcher** so that the API service does not block on scheduling concerns and so that the "find due jobs" loop can be tuned independently.
- **Work queue** so that execution can scale horizontally and so that worker crashes redeliver the message instead of losing the run.
- **Runs as first-class rows** so that history, retry count, and idempotency are all persisted durably rather than living in queue state.
- **Object storage for output** so that large logs and artifacts do not bloat the metadata tables or slow the dispatcher's indexed queries.

---

## Deep Dives

### 1. Timed Dispatch: Finding Due Jobs on Time

The core loop is deceptively simple: find all jobs whose `nextRunAt <= now()` and enqueue them. The problems show up under load.

**Naive poll with `SELECT * FROM jobs WHERE next_run_at <= now()`.** Works up to maybe a few thousand jobs. At scale the query becomes a full-table scan because `next_run_at` is constantly being rewritten, killing cache locality and inflating index churn. The scan cost is O(total jobs), not O(jobs due soon).

**Indexed poll with a near-future lookahead window.** Create a B-tree index on `next_run_at` and query only a bounded window ahead of wall-clock time:
```sql
SELECT job_id, next_run_at, schedule, payload_ref
  FROM jobs
 WHERE next_run_at <= now() + interval '30 seconds'
   AND status = 'ACTIVE'
 ORDER BY next_run_at ASC
 LIMIT 1000
 FOR UPDATE SKIP LOCKED;
```
The 30-second lookahead shrinks the scan from O(total jobs) to O(jobs due in the next 30 seconds) — typically orders of magnitude smaller. `FOR UPDATE SKIP LOCKED` lets multiple dispatcher workers within a shard cooperate without stepping on each other. Dispatch in batches rather than one job at a time to amortise the DB round-trip cost.

**Time-bucketed tables.** As the firing rate climbs, even the indexed poll touches rows across the whole timeline. Partitioning the jobs table by `nextRunAt` minute-bucket means each dispatcher tick only touches a tiny, recent partition. Old partitions are dropped cheaply via DDL, avoiding the slow-vacuum problem of deleting millions of rows.

**In-memory priority queue for hot windows.** For the highest-volume tier, the dispatcher pre-loads jobs due in the next few minutes into an in-process min-heap keyed on `nextRunAt`. Firing becomes a heap pop comparison against wall-clock time; the DB is only touched on bucket-load and run-write. This is the pattern most cron services at scale converge on. The tradeoff: the heap must be rebuilt on dispatcher restart, so bucket-load on failover must be fast — time-bucketed tables make this cheap.

**Clock discipline.** All dispatchers must run NTP/chrony with strict drift bounds. A dispatcher whose clock is five seconds slow will fire every job five seconds late across its entire shard; worse, a dispatcher five seconds fast will fire before the intended time, which some handlers treat as a correctness violation. Monitoring per-host clock skew is non-negotiable. At scale, a clock skew alert threshold of ±500ms is a reasonable starting point.

### 2. Leader Election for the Dispatcher

Multiple dispatcher instances pulling the same due-window will double-fire jobs unless they coordinate. The standard mitigations are leader election or partitioning.

**Single-leader model.** One dispatcher node holds a lease in a coordination service (ZooKeeper, etcd, or a Postgres advisory lock). Only the lease holder performs the due-query and enqueues runs. On lease loss the next candidate picks up within a tick or two. Simple and correct, but the single leader is a throughput ceiling. Lease TTLs are typically short (5–10 seconds) with aggressive heartbeating so that failover completes in seconds rather than minutes.

**Why a plain Redis lock is not enough.** A classic `SETNX` lease without fencing can admit a zombie leader: node A's lease expires under a GC pause, node B takes over and starts dispatching, but then node A resumes thinking it still holds the lease. Both nodes now dispatch the same jobs simultaneously. The fix is fencing tokens: each lock acquisition returns a monotonically increasing token, and every enqueue operation includes the token. The queue or downstream service rejects writes with stale tokens. etcd and ZooKeeper provide fencing tokens natively (revision numbers / zxid). With Redis you must implement Redlock plus an explicit token generation mechanism.

**Sharded leaders.** Partition jobs by `hash(jobId) % N`. Each shard has its own lease, and leadership for different shards can live on different hosts. A six-shard layout can be served by three physical dispatchers, each holding two leases. Adding a dispatcher host means redistributing leases, not vertical scaling. This scales linearly until the coordination service itself becomes the bottleneck, which is usually well past a hundred shards.

**Failure behaviour.** On leader loss the system experiences a brief window — the duration of the lease TTL — during which no jobs in that shard are dispatched. Jobs scheduled for that window fire late by at most one TTL period. As long as dispatch latency stays within the timeliness SLO, the system has behaved correctly. Monitoring the "dispatch lag" metric (actual fire time minus scheduled fire time) per shard catches failover anomalies.

**Standby readiness.** The standby dispatcher should pre-connect to the DB and maintain an idle connection pool so that lease acquisition is the only step between standby and active. Cold-start delay (pool warmup, schema cache load) adds to failover latency and should be measured explicitly.

### 3. Idempotency Keys and Deduplication

Because the queue is at-least-once and workers can crash mid-run, the same `Run` can be delivered to two workers or executed twice on one worker. Making execution idempotent is the only principled answer.

**Scheduler-side idempotency key.** The dispatcher stamps every run with `idempotencyKey = hash(jobId, scheduledFor)`. Retries of a failed attempt for the same `scheduledFor` reuse the key. This key is the contract between the scheduler and downstream handlers. If individual retry attempts must be distinguishable, use `hash(jobId, scheduledFor, attempt)` instead — but note this weakens deduplication across attempts.

**Worker-side claim-before-execute.** Before running, the worker atomically flips the `Run` row from `DISPATCHED` to `RUNNING` with a compare-and-set (CAS) on the expected status and a `workerId` stamp. If the CAS fails, some other worker already owns it and this worker drops the message. This turns the queue's at-least-once into "at most one concurrently-executing worker per run," which is strictly weaker than exactly-once but sufficient for most handlers.

**Fencing tokens for exclusive execution.** When the job must run exclusively — no two workers simultaneously — a distributed lock alone is insufficient. A worker holding the lock can stall (GC pause, network partition), the lock expires, a second worker acquires the lock and begins, then the first worker resumes assuming it still holds the lock. The fencing token pattern solves this: the lock service returns a monotonically increasing token on each acquisition, and all side-effecting calls include the token. The downstream system rejects calls with a token lower than the highest seen. Workers that wake from a stall discover their token is stale before touching any external state.

**Handler-side dedup.** The handler itself should treat `idempotencyKey` as a primary key for side effects. A payment handler, for example, writes `(idempotencyKey, charge_id)` as a unique row, so a replay finds the existing row and returns its result rather than charging twice. The scheduler cannot enforce this; it can only supply the key. Providing an SDK helper that wraps the idempotency-key check is the practical way to drive adoption.

### 4. At-Least-Once vs Exactly-Once Execution

True exactly-once execution in a distributed system requires a distributed transaction between the job DB and the queue — expensive and often impractical. What schedulers can offer is a layered stack that composes into effective exactly-once for well-behaved handlers. Being explicit about this distinction is one of the highest-signal things a candidate can say.

**The fundamental problem.** The dispatcher marks a job `RUNNING` and then enqueues the worker task. If the dispatcher crashes between these two steps, the job is in one of two bad states: the mark succeeded but the enqueue did not (job is lost), or the enqueue succeeded but was re-queued on recovery while the job also ran before the crash (double execution). There is no atomic operation spanning the DB write and the queue publish without a distributed 2PC.

**Layer 1: At-least-once delivery.** The queue redelivers on worker crash. This is the non-negotiable floor; without it, jobs are silently lost. The transactional outbox pattern bridges the atomicity gap at the dispatcher: write the run row and an outbox message in the same DB transaction, then a relay asynchronously publishes to the queue and deletes the outbox row on acknowledgement. The DB becomes the source of truth; the queue is a delivery mechanism, not a durability store.

**Layer 2: Single-executor-at-a-time.** Via the CAS claim above, only one worker is in the `RUNNING` state for a given run at any moment. Duplicate deliveries see the status already taken and drop.

**Layer 3: Handler-side idempotent side effects.** The handler uses the idempotency key as a fencing device on whatever external system it touches (database row, payment API, outbound webhook). Two executions map to one externally visible effect.

**Layer 4: Transactional outbox at the worker.** When the handler must atomically record "job done" and "side effect happened" across two systems, use a transactional outbox: write both to the same DB in one transaction, then a separate relay publishes the side effect. Combined with layer 3 this gives effective exactly-once.

In an interview, being explicit that exactly-once is a property of the composed system and not a primitive the scheduler provides is the important signal. "I give you at-least-once plus an idempotency key, and you compose that into exactly-once at the handler" is the honest answer. Attempting true exactly-once at the infrastructure layer requires distributed transactions that cost more in latency and complexity than the problem is worth.

### 5. Retries, Backoff, and Dead-Letter Handling

Failures are the default case, not the exception: transient network blips, downstream 5xx, worker OOMs, timeout overruns.

**Retry classification.** Not every failure should retry. The handler reports a terminal taxonomy:
- `RETRY_TRANSIENT` (network, 5xx) -> retry with backoff.
- `RETRY_RATE_LIMITED` (429) -> retry with longer backoff and jitter, respecting `Retry-After`.
- `FAIL_PERMANENT` (bad payload, auth error, handler does not exist) -> move directly to dead-letter without further retries.

**Exponential backoff with jitter.** `delay = min(base * 2^attempt, cap) + random(0, jitter)`. Jitter is essential to avoid thundering-herd retries from a fleet of workers that all failed at the same instant because of a downstream outage. Without jitter, the retry wave is as bad as the original load.

**Retry budget.** Each job carries a `maxRetries`. After exhausting retries the run is moved to a dead-letter store (a separate table or DLQ) with the full error trail. The job itself remains scheduled for its next `nextRunAt` if recurring; only the specific failed run is dead-lettered.

**Dead-letter queue triage.** The DLQ is read by an operator UI, not reprocessed automatically. Automatic DLQ drain is a classic foot-gun: a systemic downstream outage fills the DLQ, the drain policy retries everything at midnight, and the same outage happens again amplified.

**Poison-job protection.** A single job that consistently crashes the worker process can take out an entire worker fleet if the queue keeps redelivering it. Track per-run `attempt` count on the broker side and force-DLQ after `N` attempts even if the worker did not explicitly classify the failure. This broker-side protection is independent of the application-level `maxRetries` setting and acts as a safety net against unhandled panics.

### 6. Time Zone and DST Correctness

Scheduling "every day at 2:00 AM" sounds simple until daylight saving time (DST) changes the wall-clock relationship to UTC. On the day clocks spring forward, 2:00 AM does not exist — the clock jumps from 1:59 AM to 3:00 AM, so the job never fires. On the day clocks fall back, 2:00 AM occurs twice — the job fires once, then the clock rewinds and the same wall-clock time occurs again, potentially firing a second time.

**Store and compute in UTC.** All `nextRunAt` timestamps in the DB are UTC. The cron expression and its associated time zone are stored in the job definition; `nextRunAt` is the UTC timestamp of the next intended firing. Recomputing `nextRunAt` after each dispatch requires converting from UTC to the job's local time zone, applying the cron rule, and converting back to UTC. This conversion step must use a time-zone-aware library (e.g., `pytz` / `zoneinfo` in Python, `java.time.ZoneId` in Java, `date-fns-tz` in JavaScript) that understands DST transitions and IANA time zone data.

**Handle the ambiguous and missing hours explicitly.** A good library raises or returns a sentinel on ambiguous times (fall-back) and missing times (spring-forward). The scheduler must have an explicit policy: for a missing time, advance to the next valid occurrence; for an ambiguous time, choose the first occurrence (pre-transition) or skip to the next cycle. Document the policy clearly; operators will ask.

**Keep IANA tz data fresh.** Governments change DST rules with short notice. The IANA time zone database is updated several times per year. Running stale tz data can cause systematic misfires for jobs in affected regions. Pin tz data versions and ship updates through your normal dependency management process.

### 7. Missed-Job Policy

If the scheduler is down for two hours and ten jobs were missed, what happens when it recovers? Without a defined policy, the answer is unpredictable: some implementations run all missed jobs immediately (potentially flooding workers), others silently skip them.

**Three canonical policies.** Make `missedJobPolicy` a first-class per-job configuration attribute:

| Policy | Behaviour on recovery | Best for |
|---|---|---|
| `SKIP` | Discard all missed firings; resume from the next scheduled time. | Cache refresh, metric rollup — jobs where only the current state matters. |
| `BACKFILL_ALL` | Enqueue one run for every missed firing immediately. | Audit logs, billing events — jobs where every occurrence must be recorded. |
| `BACKFILL_ONCE` | Enqueue exactly one run for the most recent missed firing. | Daily reports, ETL snapshots — jobs where missing a cycle is bad but running once is sufficient. |

**Stale-run detection.** When the dispatcher recovers, it scans for jobs whose `nextRunAt` is in the past. For each such job it checks the policy and acts accordingly. For `BACKFILL_ALL`, it computes all missed firing times between `nextRunAt` and `now()` and enqueues them. For `BACKFILL_ONCE`, it enqueues only the most recent. For `SKIP`, it advances `nextRunAt` to the next future occurrence without creating any runs.

**Cap backfill depth.** Even with `BACKFILL_ALL`, set a maximum backfill depth (e.g. 100 missed firings). A job that has been paused for a month should not enqueue thousands of runs on resume and overwhelm the worker pool.

### 8. Job Output Storage

Job metadata — schedule, status, `last_run_at`, `next_run_at` — is queried on every dispatcher tick. Job output — logs, result payloads, artifacts — can be gigabytes per run and is queried rarely (only during debugging or auditing). Mixing them in the same table has a predictable outcome: the metadata table bloats, index scans slow, and dispatcher performance degrades.

**Separate storage tiers.** Store job metadata in the scheduler's primary DB (Postgres or DynamoDB), optimised for small-row indexed reads. Store job output in object storage (S3, GCS) with a reference key (`outputRef`) in the `runs` table. The metadata row stays small and fast; the output is fetched on demand via a separate presigned URL or download endpoint.

**Retention policies are independent.** Job metadata may need to be retained for years for compliance. Job output can be deleted after 30 days without affecting scheduling correctness. Decoupling storage tiers makes it possible to apply different lifecycle rules. Object storage lifecycle policies (e.g. S3 lifecycle rules) handle output expiry automatically without touching the metadata DB.

**Streaming writes for large output.** Workers should stream output to object storage incrementally rather than buffering the full result in memory and writing at the end. For long-running jobs, streaming provides partial output visibility before completion and avoids OOM on large result sets.

---

## Scaling Journey: 0 to Infinity

### Stage 1: 0 to 100 Jobs/day (MVP)

**Goal:** Prove the scheduling model works end to end; optimise for simplicity and zero operational overhead.

**Architecture:**
- Single process running both the API and the dispatcher on one VM.
- Postgres holds `jobs` and `runs` tables.
- Dispatcher is a loop inside the API process that wakes every second and runs the indexed query.
- Workers are a thread pool inside the same process; the queue is an in-memory channel.
- Cron parsing is a library call; no time-zone cleverness beyond what the library ships.

**What you skip:** No leader election (there is one process). No external queue. No retries beyond in-process exponential backoff. No sharding. No metrics beyond logs.

**Failure mode that pushes to next stage:** The single process is a single point of failure. A routine deploy restarts it and any run that was mid-flight is lost. Worse, the dispatcher loop is sharing CPU with the API and, during even modest job bursts, the API latency spikes because the dispatcher is hogging threads. The single-node lifetime of the system dictates the durability of every scheduled job.

### Stage 2: 100 to 10K Jobs/day

**Goal:** Get the dispatcher off the API box, make execution survive crashes, introduce durable retries.

**Architecture changes:**
- Split into three services: API, Dispatcher, Worker fleet.
- Postgres stays as the primary store; add a read replica for `GET /runs` pagination.
- A **leader-elected dispatcher** uses a single Postgres advisory lock or a simple etcd lease. Only one instance is active; others stand by.
- Introduce an external **work queue** (SQS, Redis Streams, or RabbitMQ). The dispatcher writes run rows and publishes queue messages atomically via the outbox pattern.
- Workers claim runs with a status CAS before executing and handle retries with exponential backoff plus jitter.

**What you skip:** Sharding the dispatcher. Kafka. Time-bucket partitioning. Multi-region. In-memory priority queue hot path.

**Failure mode that pushes to next stage:** At the first real customer with recurring jobs firing every minute across tens of thousands of users, the dispatcher's due-query starts to sweep a growing table. The single active dispatcher becomes the throughput ceiling: it can only push so many enqueues per second through one DB connection and one broker publisher. Round-minute fan-in (`:00` second) produces visible dispatch lag that breaks the two-second timeliness SLO.

### Stage 3: 10K to 1M Jobs/day

**Goal:** Parallelise the dispatcher, shrink the due-query hot path, and move to a high-throughput work queue.

**Architecture changes:**
- **Shard jobs by `hash(jobId) % N`.** Each shard has its own dispatcher lease; shards are spread across dispatcher hosts. Adding a dispatcher host is adding leases, not scaling vertically.
- **Time-bucketed job tables.** Partition the `jobs` table by `nextRunAt` minute-bucket. Each dispatcher tick hits only the current bucket plus a small lookahead. Old buckets are pruned.
- **Migrate queue to Kafka or a partitioned SQS setup.** Kafka partitions align with job shards so that ordering-per-shard is cheap and consumer scaling is a matter of adding consumers per partition.
- **Runs DB becomes append-only.** A run is immutable once written; state transitions become new rows keyed by `(runId, version)`. This plays nicely with append-heavy stores like Cassandra or DynamoDB.
- **Observability is now a first-class concern.** Per-shard dispatch lag, per-handler failure rate, and DLQ depth are on dashboards, with alerts on sustained deviation.

**What you skip:** Multi-region. In-memory heap dispatcher. Per-tenant isolation. Elaborate fairness between tenants.

**Failure mode that pushes to next stage:** At the top of the hour a million jobs are due simultaneously. Even with sharding, each shard's dispatcher is issuing thousands of DB round-trips per second to read the due rows and write the run rows. The DB becomes the bottleneck; dispatch lag creeps above the SLO for the first few seconds of each minute. Separately, a single "noisy neighbour" tenant with a million-job recurring campaign dominates several shards and starves other tenants' jobs.

### Stage 4: 1M to 100M Jobs/day

**Goal:** Push hot-window dispatch off the DB entirely and isolate tenants so no one customer can monopolise a shard.

**Architecture changes:**
- **In-memory priority queue per shard.** Each dispatcher shard pre-loads jobs due in the next few minutes into an in-process min-heap. Firing becomes a heap-pop against wall-clock time with no DB read on the hot path. The DB is only touched on bucket-load (periodic) and run-write (batched). This is the pattern that converges industry-wide at this tier.
- **Hierarchical dispatchers.** A routing layer shards first by time bucket (coarse), then within each bucket by tenant or `jobId` hash. Marquee tenants get dedicated dispatcher shards; long-tail tenants share.
- **Per-tenant weighted fair queuing** on the work queue so that one runaway campaign cannot drain all worker capacity. Tokens are issued per tenant based on their configured quota. Low-priority jobs that have been waiting beyond a threshold receive an age-based priority boost to prevent indefinite starvation.
- **Idempotency keys become a system-wide contract.** Every run carries `hash(jobId, scheduledFor, attempt)` (or just `hash(jobId, scheduledFor)` if retries should collide). Handler SDKs ship with helpers that use this key for outbox-style dedup.
- **Regional worker pools** for locality; the dispatcher remains centralised per region with cross-region async replication of job definitions.
- **Poison-job protection** at the broker: force-DLQ after N redeliveries regardless of handler classification.

**What you skip:** Multi-region active-active dispatch. Custom time-series-aware storage engines. ML-based workload forecasting.

**Failure mode that pushes to next stage:** At this scale a regional outage during peak fan-in (commerce midnight batch, for instance) blacks out the scheduler for that region's customers for minutes. The hot in-memory heaps are rebuilt on failover, and the rebuild from the time-bucketed tables is itself expensive enough to delay dispatch. Meanwhile coordination services (etcd, ZooKeeper) start showing election-latency tails because the number of leases they juggle has grown into the thousands.

### Stage 5: 100M+ Jobs/day (Hyperscale)

**Goal:** Multi-region resilience, second-or-better timeliness even during regional failover, and per-tenant isolation strong enough that incident blast radius is bounded to a single customer.

**Architecture changes:**
- **Multi-region active-active dispatch.** Jobs are homed to a primary region based on tenant geography; a warm standby in a second region holds a replicated copy of the jobs table and can assume dispatch leadership within seconds if the primary fails. Runs are replicated asynchronously to a global store for history queries.
- **Per-tenant sharded dispatch for top customers.** A dedicated dispatcher fleet, queue, and worker pool per flagship tenant means their peak does not touch the shared path at all. Capacity is pre-provisioned from their published campaign schedule.
- **Tiered storage for runs.** Hot runs (last 30 days) in the primary KV store; warm in cheaper columnar storage; cold in object storage with a secondary index. At tens of billions of rows, tier management drives cost far more than it drives correctness.
- **Exactly-once-effectively via outbox at every layer.** The dispatcher's run-write-plus-enqueue is an outbox. The worker's side-effect-plus-status-update is an outbox. Handlers' SDKs encourage their own outboxes. At this scale, exactly-once is an ecosystem property, not a feature.
- **Capacity forecasting feeds pre-provisioning.** Known schedules (hourly, daily top-of-minute, scheduled campaigns) drive auto-scaling decisions minutes in advance rather than reactively after queue depth spikes.
- **Continuous chaos.** Dispatcher failover, broker partition loss, and coordination-service election storms are injected continuously in production so that the system's failure modes are the ones the team has already rehearsed.

**What you skip:** Nothing obvious is skipped; at this stage the work is operational maturity, cost management, and forecasting rather than new architectural primitives.

---

## Insider Tips and Tricks

### The Dispatcher Must Scan Only the Near-Future Window

A naive dispatcher that scans all jobs for "next run time in the past" does a full table scan every second. The fix: index jobs on `next_run_at`. Query only jobs where `next_run_at <= now() + 30s` (a small lookahead window). Dispatch in batches. This reduces the scan from O(total jobs) to O(jobs due in the next 30 seconds) — typically orders of magnitude smaller.

### Exactly-Once Execution Is Impossible Without Two-Phase Commit

The dispatcher marks a job "running" and enqueues the worker task. If the dispatcher crashes between these two steps, the job is either lost (enqueue didn't happen) or double-executed (the job was re-queued on recovery but also ran before the crash). True exactly-once requires a distributed transaction between the job DB and the queue — prohibitively expensive. The practical standard: at-least-once execution + idempotent job implementations. Job code must be safe to run twice.

### Leader Election Is Required for the Dispatcher

If you run two dispatcher instances without coordination, both will dispatch the same job simultaneously — double execution. Solution: use leader election (via ZooKeeper ephemeral nodes, etcd distributed lock, or Postgres advisory lock) so only one dispatcher is active at a time. The standby becomes leader within seconds of the primary failing. This trades simplicity for availability — accept the brief window during failover where no jobs are dispatched.

### Job Scheduling Must Handle Time Zone and DST Correctly

A job scheduled for "every day at 2:00 AM" in a US time zone will either run twice or not at all on the day daylight saving time changes (clocks spring forward past 2am or fall back through 2am). Store all schedules in UTC internally. Convert to local time only for display. When converting cron expressions to next-run timestamps, use a time zone-aware library (e.g., `pytz`, `java.time.ZoneId`) that correctly handles DST transitions.

### Missed Jobs from Downtime Need an Explicit Policy

If the scheduler is down for 2 hours and 10 scheduled jobs were missed, what happens when it comes back? Three policies: (1) skip all missed runs (backfill never); (2) run all missed runs immediately (backfill always); (3) run only the most recent missed run (backfill once). The right choice depends on job semantics — a "generate daily report" job should run once for yesterday; a "refresh cache" job should probably just run once now. Make the missed-job policy a per-job configuration attribute.

### Distributed Locks for Job Exclusivity Have Fencing Token Requirements

When a job must run exclusively (no two instances simultaneously), use a distributed lock. But naive distributed locks have a failure mode: the lock holder becomes slow (GC pause, network partition) and the lock expires, another instance acquires the lock and starts running, then the first instance "wakes up" thinking it still holds the lock and also runs — two simultaneous executions despite the lock. The fix: fencing tokens. Each lock acquisition returns a monotonically increasing token. Workers include the token in all side-effecting operations; the receiving service rejects requests with stale tokens.

### Job Priority Queues Require Starvation Prevention

A system with high-priority jobs flooding the queue will starve low-priority jobs indefinitely. Starvation prevention: age-based priority boost (a low-priority job that has been waiting for 1 hour gets promoted to medium priority). This is the same technique used in OS process schedulers. Without it, a single burst of high-priority jobs during a peak period can delay low-priority jobs for hours or days.

### Job Output Storage Must Be Separate from Job Metadata

Job metadata (schedule, status, last_run_at, next_run_at) belongs in the scheduler's DB — it's queried constantly by the dispatcher. Job output (results, logs, artifacts) can be large (GB per run) and is queried rarely (only when debugging). Storing output in the same DB bloats the metadata tables and slows dispatcher scans. Store output in object storage (S3) with a reference (S3 key) in the metadata table. Retention policy on job output is separate from retention on job metadata.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What a strong signal looks like |
|---|---|---|
| **Mid** | Breadth with a correct happy-path. | Names the jobs table, a dispatcher loop, a queue, a worker. Articulates why the queue is there (decoupling, retries). Understands at-least-once delivery and that the handler needs idempotency. Recognises that two dispatchers running naively will double-fire and proposes a lock, even if the locking story is hand-wavy. |
| **Senior** | Depth on dispatch and idempotency. | Picks a leader-election substrate (etcd/ZooKeeper) and can defend it over a naive Redis lock (fencing tokens). Shards by `hash(jobId)` and explains per-shard leases. Chooses an indexed-poll with a near-future lookahead window plus time-bucketed tables as the dispatcher strategy and can reason about the DB query under load. Draws the idempotency-key contract between scheduler and handler, and explains the CAS claim. Handles retries with exponential backoff plus jitter and names a DLQ. Knows that exactly-once is composed from at-least-once plus handler idempotency and says so explicitly. Names the missed-job policy problem and proposes at least two options. |
| **Staff** | Depth plus operability, cost, and failure-mode analysis. | Moves to in-memory priority queues per shard for hot-window dispatch and can defend the DB-as-cold-store pattern. Introduces hierarchical / per-tenant dispatch fleets and weighted fair queuing to solve noisy-neighbour problems, including age-based priority boost for starvation prevention. Treats the transactional outbox as a first-class pattern both at the dispatcher and at the handler. Reasons about clock skew and DST as correctness concerns, not operational ones — calls out the spring-forward/fall-back edge cases and advocates for a tz-aware library. Discusses the fencing token requirement for distributed locks and the zombie-leader failure mode. Explains why job output belongs in object storage rather than the metadata DB and ties it back to dispatcher scan performance. Connects missed-job policy to job semantics and makes it a per-job configuration attribute. Discusses multi-region active-active and what breaks during regional failover (hot-heap rebuild cost, coordination-service election tails). Connects capacity planning to known schedules (pre-provisioning ahead of top-of-minute fan-in). Talks about observability metrics that matter: per-shard dispatch lag, DLQ depth trend, per-handler success rate, coordination-service election latency. Surfaces the ecosystem nature of exactly-once and is clear about what the scheduler cannot guarantee on its own. |
