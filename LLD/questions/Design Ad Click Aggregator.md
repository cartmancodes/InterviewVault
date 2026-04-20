# Design Ad Click Aggregator

> **Pattern**: Stream Aggregation / Exactly-Once
> **Difficulty**: Hard
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/ad-click-aggregator)

## Table of Contents
1. [Understanding the Problem](#understanding-the-problem)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

An ad click aggregator sits at the intersection of two very different workloads: a massive write-heavy ingest pipeline (every click on every ad on every page) and a read-heavy analytics pipeline (advertisers continually refreshing dashboards to watch campaign performance). The interesting tension in the problem is that both sides care about money: advertisers pay per click, so clicks cannot be lost or double-counted, yet the dashboards must feel live.

### Functional Requirements

- When a user clicks on an ad, the click is recorded and the user is redirected to the advertiser's destination URL.
- Advertisers can query aggregated click metrics for their ads at minute-level granularity (counts over arbitrary time ranges, grouped by ad, campaign, or advertiser).
- Metrics should become visible in near real time, not hours after the fact.

**Out of scope:** ad serving, ad targeting, demographic profiles, conversion tracking, cross-device identity, offline attribution.

### Non-Functional Requirements

- Scale: around 10K clicks/second at peak, roughly 100M clicks/day.
- Accuracy: no lost clicks, no double-counted clicks. Billing data must ultimately be exact.
- Freshness: advertiser dashboards should see clicks within roughly a minute.
- Query latency: sub-second response for typical dashboard queries.
- Resilience to duplicates, retries, malicious click injection, and late-arriving events.
- Fault tolerance: a broker, worker, or AZ failure should not drop or duplicate events.

---

## Core Entities

| Entity | Key Fields | Notes |
|--------|-----------|-------|
| **Ad** | `ad_id`, `campaign_id`, `advertiser_id`, `destination_url`, `bid`, `budget` | Metadata only; rarely changes. |
| **Impression** | `impression_id`, `ad_id`, `user_id`, `shown_at`, `placement` | Generated every time the ad is rendered. The impression ID is the natural dedup key. |
| **Click Event** | `click_id`, `impression_id`, `ad_id`, `user_id`, `ts`, `ip`, `ua` | Raw, append-only fact. This is what the system ingests. |
| **Aggregate Metric** | `ad_id`, `minute_bucket`, `click_count`, `unique_users` | Pre-computed row in the OLAP store; the unit of truth for the dashboard. |

The impression is what makes click tracking tractable. Every render produces a fresh impression ID that is signed before being handed to the browser; that ID is what arrives when a user clicks, so duplicates caused by retries or replay attacks can be detected without relying on identity.

---

## API Design

### Click ingest

```
GET /click?impression=<signed_impression_id>
  -> 302 Redirect to advertiser destination
```

The request is intentionally a `GET` so the browser can follow the redirect without custom client code. The payload is the signed impression ID, verified server-side with an HMAC secret. The click processor never blocks the redirect on a durable write; it pushes to the stream, caches the impression ID, and returns the 302.

### Metrics query

```
GET /ads/{ad_id}/metrics?from=<ts>&to=<ts>&granularity=minute|hour|day
  -> { buckets: [ { ts, clicks, unique_users } ... ] }
```

Optional variants roll up by `campaign_id` or `advertiser_id`. All reads hit the pre-aggregated OLAP store, never the raw event stream.

---

## High-Level Design

```
Browser click
   |
   v
[Click Processor]  -- verify HMAC, dedup in Redis -->
   |
   v
[Kafka / Kinesis]  (partitioned by ad_id, N-day retention)
   |
   v
[Stream Processor: Flink]  (tumbling 1-min windows, idempotent sink)
   |
   +--> [OLAP store: Druid / ClickHouse / BigQuery]
   |
   +--> [Data lake: S3]   -- nightly Spark reconciliation
                          -- batch results overwrite OLAP rollups
```

The ingest side is tuned for never losing a click: the stream is the source of truth, Redis only exists to drop near-duplicates, and the OLAP store is a materialized view that can always be rebuilt from the lake. The query side is deliberately boring: serve pre-aggregated minute rows out of an OLAP engine that already handles time-series scans efficiently.

---

## Deep Dives

### 1. Exactly-Once vs At-Least-Once

True end-to-end exactly-once does not exist in most distributed pipelines; what we actually want is effectively-once: at-least-once delivery combined with idempotent processing, so duplicates get absorbed. Kafka provides at-least-once by default; Flink's checkpointing plus a sink that can deduplicate (via impression ID or a compound key) gives us the effective guarantee. For ad billing, this is stronger than the "exactly-once" label suggests, because even if Flink replays a window from a checkpoint, the sink will reject the duplicate write.

### 2. Idempotency via Signed Impression IDs

The dedup key is generated upstream of the click, at render time. The ad placement service issues a fresh `impression_id` per render, signs it with an HMAC secret, and embeds the signed token in the click URL. The click processor verifies the signature (blocking fake click injection), then checks a distributed Redis set for the impression ID. First write wins: if new, publish to the stream and cache the ID; if already present, drop. This stays correct across retries at any layer, including browser reload, CDN replays, or ingest-side retries. At 100M impressions/day and a 24-hour dedup window, the Redis footprint is on the order of a couple of gigabytes.

### 3. Stream Processing and Windowing

Flink reads the Kafka topic partitioned by `ad_id`, applies a tumbling 1-minute window, and emits `(ad_id, minute, count, unique_users)` rows into the OLAP store. Watermarks control when a window is considered closed. Unique-user counting uses HyperLogLog sketches inside each window to keep state bounded; sketches can be merged across windows for longer granularities. The sink uses an upsert keyed on `(ad_id, minute_bucket)` so window replays overwrite rather than duplicate.

### 4. Late-Arriving Data

Clients on poor networks, mobile app wakeups, and retry queues all produce clicks that arrive with timestamps minutes or hours in the past. The system needs two complementary mechanisms:

- A bounded allowed-lateness on the Flink windows (for example, keep windows open for 10 minutes past their end). Late events within that lag update the live row.
- An authoritative batch layer. Every raw event is also written to S3. A nightly Spark job recomputes every minute bucket for the prior day from the lake and overwrites the OLAP rows. This is the Lambda-style reconciliation that makes billing data exact, even though the real-time numbers on the dashboard are slightly approximate.

### 5. Hot Advertisers and Hot Partitions

Partitioning by `ad_id` is simple but catastrophic when a single ad goes viral. Two defenses:

- Randomized key salting at ingest: rewrite the Kafka key as `ad_id:<0..N>` so the hot ad spreads across N partitions. The stream processor strips the suffix before aggregation.
- Two-stage aggregation: pre-aggregate within each salted partition, then merge the partial counts in a second Flink operator keyed by plain `ad_id`. This keeps per-task state small on hot keys.

OLAP-side hotspots are handled by sharding on `advertiser_id` rather than `ad_id`, which naturally spreads load since a single advertiser usually runs many ads with different popularity profiles.

### 6. Accuracy and Reconciliation

Billing cannot be "close enough." The design treats the OLAP store as a fast approximate cache and the data lake + batch job as the authoritative ledger. Daily, the batch job overwrites the real-time numbers; advertisers see rapidly updating estimates during the day that stabilize to exact numbers overnight. Discrepancies between the two layers also serve as a monitoring signal: a sudden large gap means the stream pipeline has regressed (bad deploy, skew, clock drift).

---

## Scaling Journey: 0 to Infinity

### Stage 1: 0 to 100 Clicks/sec (MVP)

**Goal.** Prove the redirect, the counting, and the advertiser dashboard work end to end.

**Architecture.** A single stateless click service behind a load balancer writes each click synchronously to Postgres as an `INSERT` into a `clicks` table. The metrics API runs `SELECT ad_id, date_trunc('minute', ts), count(*) FROM clicks GROUP BY ...` on demand, maybe with a small materialized view refreshed every few minutes.

**What you skip.** No Kafka, no Flink, no Redis, no HLL. Dedup is a unique index on `impression_id`. Late data is whatever Postgres sees.

**Failure mode.** Two problems show up together. First, write amplification: every click is a durable WAL write, and at a few hundred writes per second the primary starts to lag. Second, aggregation queries scan the hot tail of the clicks table and cripple the same primary that is trying to ingest. The read and write paths are fighting over the same disk.

### Stage 2: 100 to 1K Clicks/sec

**Goal.** Keep the redirect fast even when the analytics query load grows, and survive brief DB outages without losing clicks.

**Architecture.** Introduce an asynchronous ingest buffer. The click service writes to a lightweight queue (Kafka with a small cluster, or SQS for simplicity) and returns the 302 immediately. A batch worker drains the queue every few seconds and bulk-inserts into Postgres. Analytics queries are redirected to a read replica, and a scheduled job maintains per-minute rollup tables (`ad_minute_counts`) so dashboards hit a small pre-aggregated table rather than the raw clicks.

**What you skip.** Still no stream processor; aggregation is micro-batched via cron. No Redis dedup yet; the unique index on `impression_id` in Postgres is enough at this volume. No reconciliation layer.

**Failure mode.** The pre-aggregation cron starts falling behind at peak, so dashboards lag. Meanwhile, the write primary gets hot on a few popular ads because the bulk inserter is keyed by `ad_id`. Per-minute freshness becomes inconsistent across ads, and a single bad deploy of the cron job can silently produce wrong numbers for hours.

### Stage 3: 1K to 100K Clicks/sec

**Goal.** Real-time metrics, strong idempotency, and a write path that never touches an OLTP database.

**Architecture.** This is where the canonical design crystallizes.

- Click service verifies the HMAC-signed `impression_id`, does a Redis `SET NX` for dedup, and publishes to Kafka partitioned by `ad_id`.
- Flink consumes the topic with 1-minute tumbling windows and allowed lateness of 10 minutes. State is checkpointed to S3.
- Sink is an OLAP store (Druid or ClickHouse) upserting on `(ad_id, minute_bucket)`. Unique users are tracked via HLL sketches.
- Raw events are also tee'd to S3 via Kafka Connect for the future batch layer.
- Advertiser dashboards query the OLAP store directly.

**What you skip.** Still a single Flink job graph. No cross-region replication. No separate tiered storage for cold minutes. Reconciliation is planned but not yet running.

**Failure mode.** A viral ad pins one Kafka partition and one Flink task at 100% CPU while the rest of the cluster sits idle. Watermarks on the hot partition stall, which stalls the entire job's progress and delays every advertiser's dashboard. Simultaneously, a bad deploy produces subtly wrong counts for a few hours, and there is no batch job to correct the numbers before billing runs.

### Stage 4: 100K to 1M Clicks/sec

**Goal.** Eliminate hot partitions, add an authoritative correction path, and isolate tenants so one advertiser cannot degrade another.

**Architecture.**

- Key salting at ingest: rewrite Kafka keys as `ad_id:<0..N>` with N chosen per ad based on recent traffic. A two-stage Flink topology pre-aggregates per salted key, then merges by plain `ad_id` in a downstream operator.
- Shard the OLAP store by `advertiser_id`; route queries via a thin metrics-API layer that fans out and merges.
- Reconciliation pipeline: nightly Spark job reads the S3 raw event lake, recomputes every minute bucket for the prior day, and overwrites the OLAP rows. The OLAP store becomes a fast approximate view; S3 plus the batch job is the ledger of record.
- Multi-AZ Kafka with rack-aware replication; Flink savepoints support zero-downtime upgrades.
- Redis dedup sharded by `impression_id` hash, with a 24-hour TTL sized for peak.

**What you skip.** Still a single region for now. No tiered accuracy SLAs yet; one OLAP store serves both dashboard and billing queries.

**Failure mode.** At this volume the cost and blast radius of the single-region design becomes untenable. A regional outage loses minutes of clicks from the OLAP view (the lake is still safe, but dashboards go dark). Billing queries and advertiser dashboards contend for the same OLAP cluster, and a heavy export from one advertiser can slow dashboards for everyone. Late-arriving events from mobile SDKs start exceeding the 10-minute watermark and silently drop.

### Stage 5: 1M+ Clicks/sec (Hyperscale)

**Goal.** Multi-region durability, tiered accuracy SLAs, and tenant isolation for the largest advertisers.

**Architecture.**

- Active-active ingest across regions. Each region has its own Kafka cluster; raw events are replicated to a global S3 bucket for the reconciliation pipeline. Impression IDs are globally unique, so cross-region duplicates dedup correctly in Redis (per-region) and again at the sink (via upsert key).
- Tiered accuracy: a fast approximate tier serves dashboards out of a pre-aggregated, HLL-backed OLAP cluster with a freshness SLA of under a minute but explicit "estimated" labelling. A separate exact tier, rebuilt nightly from S3 by Spark, serves billing, invoicing, and external reporting. Advertisers see both numbers in the UI.
- Multi-level pre-aggregation: minute rollups compacted into hourly, daily, weekly, and monthly tables. Dashboard queries pick the coarsest table that still satisfies the requested granularity.
- Hot-advertiser isolation: the top N advertisers by traffic get dedicated Flink job graphs and dedicated OLAP shards, so a Super Bowl campaign cannot starve smaller clients.
- Late-arrival side channel: events arriving past the allowed lateness are written to a "late events" topic that feeds the batch layer only, so the nightly Spark job still corrects them without destabilizing the streaming windows.
- Observability: continuous diffing between the stream tier and the batch tier emits a drift metric; above a threshold it pages on-call and pauses billing exports.

**What you skip at this point.** Nothing essential; any further scaling is about cost optimization (spot capacity for batch, tiered storage for old minutes, smarter compaction) and product features (sub-second granularity, custom attribution windows).

---

## Expected Depth by Level

| Level | Breadth vs Depth | What interviewers expect | Pitfalls |
|-------|------------------|--------------------------|----------|
| Mid (E4) | ~80% breadth, 20% depth | Arrive at a workable batch or micro-batch design. Identify the need for idempotency. Choose reasonable stores with a short justification. Respond well to prompts about scaling. | Jumping straight to "use Kafka and Flink" without explaining why. Forgetting to protect billing accuracy. |
| Senior (E5) | ~60% breadth, 40% depth | Move through the high-level design quickly, then go deep on at least two of: exactly-once semantics, hot partitions, reconciliation, late data, OLAP choice. Articulate trade-offs between batch, micro-batch, and streaming. Recognize bottlenecks before being asked. | Hand-waving dedup ("we'll just use a UUID"). Treating stream vs batch as either/or instead of complementary. |
| Staff+ (E6+) | ~40% breadth, 60% depth | Skip fundamentals. Drive the conversation. Discuss specifics like Flink watermarks, HLL merging, key salting, Kafka replication modes, and the cost/accuracy trade-off between tiers. Bring real operational experience: how deploys corrupt windows, how to diff stream vs batch, how to evacuate a hot region. Teach the interviewer something. | Being academic instead of operational. Proposing exotic architectures without justifying them against simpler Lambda-style designs. |
