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
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

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

## Core Entities

| Entity | Key Fields | Notes |
|---|---|---|
| **Job** | `jobId`, `ownerId`, `payload`, `schedule`, `nextRunAt`, `timezone`, `maxRetries`, `status` | The durable definition of "what to run and when." A recurring job rewrites `nextRunAt` each time it completes a dispatch. |
| **Schedule** | `type` (`once` / `cron` / `interval`), `cronExpr`, `intervalMs`, `startAfter`, `endBefore` | Derived, not stored separately; embedded inside the job row. Cron parsing happens when computing `nextRunAt`. |
| **Run** | `runId`, `jobId`, `scheduledFor`, `dispatchedAt`, `startedAt`, `finishedAt`, `status`, `attempt`, `lastError`, `idempotencyKey` | One row per attempt. `idempotencyKey` is typically `hash(jobId, scheduledFor)` so retries of the same scheduled firing share a key. |
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
```

Flow for a single firing:

1. Client calls `POST /jobs`. The API service parses the schedule, computes `nextRunAt`, and persists the job row.
2. The **Dispatcher** wakes on a short tick (typically every second) and queries the Jobs DB for rows whose `nextRunAt <= now() + lookaheadWindow`.
3. For each due row the dispatcher creates a `Run` row in a `DISPATCHED` state with a stable `idempotencyKey = hash(jobId, scheduledFor)`, and publishes a message to the work queue.
4. If the job is recurring, the dispatcher recomputes the next `nextRunAt` in the same transaction that writes the run row. If the job is one-shot, the dispatcher marks it `COMPLETED_SCHEDULED`.
5. A worker consumes the queue message, claims the run (marks it `RUNNING`), executes the payload, and writes back either `SUCCEEDED` or `FAILED`. Failure paths feed into the retry logic.

Why these components:
- **Separate dispatcher** so that the API service does not block on scheduling concerns and so that the "find due jobs" loop can be tuned independently.
- **Work queue** so that execution can scale horizontally and so that worker crashes redeliver the message instead of losing the run.
- **Runs as first-class rows** so that history, retry count, and idempotency are all persisted durably rather than living in queue state.

---

## Deep Dives

### 1. Timed Dispatch: Finding Due Jobs on Time

The core loop is deceptively simple: find all jobs whose `nextRunAt <= now()` and enqueue them. The problems show up under load.

**Naive poll with `SELECT * FROM jobs WHERE next_run_at <= now()`.** Works up to maybe a few thousand jobs. At scale the query becomes a scanning nightmare because `next_run_at` is constantly being rewritten, killing cache locality and inflating index churn.

**Indexed poll with a partial index.** Create a B-tree index on `next_run_at` and ask for only the next `N` rows each tick:
```sql
SELECT job_id, next_run_at, schedule, payload_ref
  FROM jobs
 WHERE next_run_at <= now() + interval '1 second'
   AND status = 'ACTIVE'
 ORDER BY next_run_at ASC
 LIMIT 1000
 FOR UPDATE SKIP LOCKED;
```
`FOR UPDATE SKIP LOCKED` lets multiple dispatcher workers within a shard cooperate without stepping on each other. A one-second lookahead window smooths over dispatcher tick granularity.

**Time-bucketed tables.** As the firing rate climbs, even the indexed poll touches rows across the whole timeline. Partitioning the jobs table by `nextRunAt` minute-bucket means each dispatcher tick only touches a tiny, recent partition. Old partitions get dropped cheaply.

**In-memory priority queue for hot windows.** For the highest-volume tier, the dispatcher pre-loads jobs due in the next few minutes into an in-process min-heap keyed on `nextRunAt`. Firing becomes a heap pop comparison against wall-clock time; the DB is only touched on bucket-load and run-write. This is the pattern most cron services at scale converge on.

**Clock discipline.** All dispatchers must run NTP/chrony with strict drift bounds. A dispatcher whose clock is five seconds slow will fire every job five seconds late across its entire shard; worse, a dispatcher five seconds fast will fire before the intended time, which some handlers treat as a correctness violation. Monitoring per-host clock skew is non-negotiable.

### 2. Leader Election for the Dispatcher

Multiple dispatcher instances pulling the same due-window will double-fire jobs unless they coordinate. The standard mitigations are leader election or partitioning.

**Single-leader model.** One dispatcher node holds a lease in a coordination service (ZooKeeper, etcd, or a Redis-based lock with fencing tokens). Only the lease holder performs the due-query and enqueues runs. On lease loss the next candidate picks up within a tick or two. Simple and correct, but the single leader is a throughput ceiling.

**Sharded leaders.** Partition jobs by `hash(jobId) % N`. Each shard has its own lease, and leadership for different shards can live on different hosts. A six-shard layout can be served by three physical dispatchers, each holding two leases. This scales linearly until the coordination service itself becomes the bottleneck, which is usually well past a hundred shards.

**Why a plain Redis lock is not enough.** A classic `SETNX` lease without fencing can admit a zombie leader: node A's lease expires, node B takes over, but a paused-then-resumed node A still thinks it is leader and writes to the queue. Fencing tokens (monotonic integers included in every enqueue) let downstream reject stale writes. etcd and ZooKeeper hand these out natively; with Redis you implement Redlock plus your own token.

**Failure behaviour.** On leader loss the system should self-heal in seconds, not minutes. Lease TTLs are typically short (five to ten seconds) with aggressive heartbeating. The visible symptom of a slow failover is a small batch of jobs firing late; as long as they fire within SLO, the system has behaved correctly.

### 3. Idempotency Keys and Deduplication

Because the queue is at-least-once and workers can crash mid-run, the same `Run` can be delivered to two workers or executed twice on one worker. Making execution idempotent is the only principled answer.

**Scheduler-side idempotency key.** The dispatcher stamps every run with `idempotencyKey = hash(jobId, scheduledFor)`. Retries of a failed attempt for the same `scheduledFor` reuse the key. This key is the contract between the scheduler and downstream handlers.

**Worker-side claim-before-execute.** Before running, the worker atomically flips the `Run` row from `DISPATCHED` to `RUNNING` with a compare-and-set on the expected status and a `workerId` stamp. If the CAS fails, some other worker already owns it and this worker drops the message. This turns the queue's at-least-once into "at most one concurrently-executing worker per run," which is strictly weaker than exactly-once but sufficient for most handlers.

**Handler-side dedup.** The handler itself should treat `idempotencyKey` as a primary key for side effects. A payment handler, for example, writes `(idempotencyKey, charge_id)` as a unique row, so a replay finds the existing row and returns its result rather than charging twice. The scheduler cannot enforce this; it can only supply the key.

### 4. At-Least-Once vs Exactly-Once Execution

True exactly-once execution in a distributed system is impossible without cooperation from the effectful code. What schedulers can offer is a stack of guarantees that composes into practical exactly-once for well-behaved handlers.

**Layer 1: At-least-once delivery.** The queue redelivers on worker crash. This is the non-negotiable floor; without it, jobs are silently lost.

**Layer 2: Single-executor-at-a-time.** Via the CAS claim above, only one worker is in the `RUNNING` state for a given run at any moment. Duplicate deliveries see the status already taken and drop.

**Layer 3: Handler-side idempotent side effects.** The handler uses the idempotency key as a fencing device on whatever external system it touches (database row, payment API, outbound webhook). Two executions map to one externally visible effect.

**Layer 4: Transactional outbox.** When the handler must atomically record "job done" and "side effect happened" across two systems, use a transactional outbox: write both to the same DB in one transaction, then a separate relay publishes the side effect. Combined with layer 3 this gives effective exactly-once.

In an interview, being explicit that exactly-once is a property of the composed system and not a primitive the scheduler provides is the important signal. "I give you at-least-once plus an idempotency key, and you compose that into exactly-once at the handler" is the honest answer.

### 5. Retries, Backoff, and Dead-Letter Handling

Failures are the default case, not the exception: transient network blips, downstream 5xx, worker OOMs, timeout overruns.

**Retry classification.** Not every failure should retry. The handler reports a terminal taxonomy:
- `RETRY_TRANSIENT` (network, 5xx) -> retry with backoff.
- `RETRY_RATE_LIMITED` (429) -> retry with longer backoff and jitter, respecting `Retry-After`.
- `FAIL_PERMANENT` (bad payload, auth error, handler does not exist) -> move directly to dead-letter without further retries.

**Exponential backoff with jitter.** `delay = min(base * 2^attempt, cap) + random(0, jitter)`. Jitter is essential to avoid thundering-herd retries from a fleet of workers that all failed at the same instant because of a downstream outage. Without jitter, the retry wave is as bad as the original load.

**Retry budget.** Each job carries a `maxRetries`. After exhausting retries the run is moved to a dead-letter store (a separate table or DLQ) with the full error trail. The job itself remains scheduled for its next `nextRunAt` if recurring; only the specific failed run is dead-lettered.

**Dead-letter queue triage.** The DLQ is read by an operator UI, not reprocessed automatically. Automatic DLQ drain is a classic foot-gun: a systemic downstream outage fills the DLQ, the drain policy retries everything at midnight, and the same outage happens again amplified.

**Poison-job protection.** A single job that consistently crashes the worker process can take out an entire worker fleet if the queue keeps redelivering it. Track per-run `attempt` count on the broker side and force-DLQ after `N` attempts even if the worker did not explicitly classify the failure.

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
- **Per-tenant weighted fair queuing** on the work queue so that one runaway campaign cannot drain all worker capacity. Tokens are issued per tenant based on their configured quota.
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

## Expected Depth by Level

| Level | Breadth vs Depth | What a strong signal looks like |
|---|---|---|
| **Mid** | Breadth with a correct happy-path. | Names the jobs table, a dispatcher loop, a queue, a worker. Articulates why the queue is there (decoupling, retries). Understands at-least-once delivery and that the handler needs idempotency. Recognises that two dispatchers running naively will double-fire and proposes a lock, even if the locking story is hand-wavy. |
| **Senior** | Depth on dispatch and idempotency. | Picks a leader-election substrate (etcd/ZooKeeper) and can defend it over a naive Redis lock (fencing tokens). Shards by `hash(jobId)` and explains per-shard leases. Chooses an indexed-poll plus time-bucketed tables as the dispatcher strategy and can reason about the DB query under load. Draws the idempotency-key contract between scheduler and handler, and explains the CAS claim. Handles retries with exponential backoff plus jitter and names a DLQ. Knows that exactly-once is composed from at-least-once plus handler idempotency and says so explicitly. |
| **Staff** | Depth plus operability, cost, and failure-mode analysis. | Moves to in-memory priority queues per shard for hot-window dispatch and can defend the DB-as-cold-store pattern. Introduces hierarchical / per-tenant dispatch fleets and weighted fair queuing to solve noisy-neighbour problems. Treats the transactional outbox as a first-class pattern both at the dispatcher and at the handler. Reasons about clock skew as a correctness concern, not an operational one. Discusses multi-region active-active and what breaks during regional failover (hot-heap rebuild cost, coordination-service election tails). Connects capacity planning to known schedules (pre-provisioning ahead of top-of-minute fan-in). Talks about observability metrics that matter: per-shard dispatch lag, DLQ depth trend, per-handler success rate, coordination-service election latency. Surfaces the ecosystem nature of exactly-once and is clear about what the scheduler cannot guarantee on its own. |
