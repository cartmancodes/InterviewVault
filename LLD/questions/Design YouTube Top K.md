# Design YouTube Top K Videos

> **Pattern**: Streaming Aggregation / Heavy Hitters
> **Difficulty**: Hard
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/top-k)

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

The goal is to build a service that answers a single question fast: "What are the K most-viewed videos over some time window?" Users are browsing a "Trending" page, an analytics dashboard, or a recommendation surface, and they expect the list back in milliseconds. The problem looks trivial at small scale (a single SQL `GROUP BY` will do), but the naive solution falls apart at YouTube-level throughput. The hard part is reconciling three simultaneously demanding constraints: massive write volume, low-latency reads, and correctness over many time windows.

### Functional Requirements

**In scope**

- Return the top K videos by view count for a specified time window. K can go up to 1,000.
- Support a fixed set of tumbling windows: 1 hour, 1 day, 1 month, and all-time.
- Results are anchored to "now" — users query the most recent window, not arbitrary ranges.
- Ingest view events from clients and attribute them to the right video and window.

**Out of scope**

- Arbitrary time ranges (e.g., "top videos between March 4 and March 11").
- Per-region, per-category, or per-user top-K slices (these are trivial extensions but distract from the core problem).
- View fraud detection and bot filtering.
- Authenticated or personalized trending.

### Non-Functional Requirements

- **Scale**: YouTube-class. Roughly 70 billion Shorts views per day, which is about 700K events per second on average and likely multi-million at peak. Roughly 3–4 billion videos exist over a decade of uploads.
- **Read latency**: Tens of milliseconds at p99. This is a user-facing page, so the budget is small.
- **Event freshness**: A view should be reflected in the top-K list within about a minute. Strong real-time is not required, but hourly lag is unacceptable.
- **Accuracy**: The initial bar is "exact counts." During deep dives we relax this in exchange for tractable memory footprints, because approximate top-K is usually acceptable for a trending list.
- **Availability**: Highly available reads. Writes can tolerate brief outages because the ingest pipeline is buffered.

---

## Core Entities

- **View Event**: `{ video_id, user_id (optional), timestamp, region (optional) }`. The raw unit of work the system ingests. Billions per day.
- **Video**: The thing being ranked. Only `video_id` matters for the ranking problem; other metadata lives in the catalog service.
- **Time Window**: A concrete bucket the system aggregates into. Fixed set: `1h`, `1d`, `1m`, `all_time`. Each window has a start and end boundary (tumbling) or a rolling boundary (sliding).
- **Aggregation / Bucket Count**: The materialized `(video_id, window_id) -> count` tuple that feeds ranking queries.
- **Top-K List**: The cached/derived output — a sorted list of `(video_id, count)` pairs for a given window.

---

## API Design

A single read endpoint covers the functional scope. Writes arrive through the view-event pipeline, not a public API.

```http
GET /v1/views/top-k?window={1h|1d|1m|all_time}&k={1..1000}

Response 200:
{
  "window": "1d",
  "generated_at": "2026-04-20T10:34:00Z",
  "results": [
    { "video_id": "abc123", "views": 9421873 },
    { "video_id": "def456", "views": 8810422 }
  ]
}
```

Notes on the design:

- No pagination because K is capped at 1,000. The response is small enough to return in one payload.
- `window` is an enum, not a free-form range. This is the key constraint that makes streaming pre-aggregation feasible.
- `generated_at` lets clients show "updated N seconds ago" and lets caches reason about staleness.
- The event-ingest side is internal: producers write to a Kafka topic (`view-events`) keyed by `video_id`.

---

## High-Level Design

The canonical architecture is a classic lambda-shaped pipeline collapsed into a pure streaming shape once you reach scale:

1. **Client beacon** posts view events to an edge ingest service.
2. **Ingest service** validates and writes to a **Kafka topic** partitioned by `video_id`. Partitioning by video means all events for a video land on the same partition, which makes downstream aggregation stateful-but-local.
3. **Stream processor** (Flink, Spark Structured Streaming, or Kafka Streams) consumes the topic and maintains per-window counters for every active video. It checkpoints state to RocksDB + durable object storage.
4. **Aggregation store** holds the materialized windowed counts. Depending on scale, this is Postgres with an index, a sharded KV store, Redis sorted sets, or a real-time OLAP engine like Druid/Pinot/ClickHouse.
5. **Top-K service** answers `GET /top-k` by either querying the store directly (small scale) or reading a precomputed list out of a cache (large scale).
6. **Cache layer** (Redis/Memcached) holds the final top-K arrays per window with short TTLs. A background job refreshes them at a cadence that matches the freshness SLA.

Data flow at steady state: client beacon → Kafka → Flink → materialized rollup table → cache → API. Read path is entirely cache-hit in the happy case.

---

## Deep Dives

### 1. Count-Min Sketch (CMS)

A Count-Min Sketch is a 2D array of counters with `d` hash functions and `w` columns. Each insert hashes the item into one cell per row and increments it. Reads return the minimum across the `d` cells, which bounds the overestimation error. Collisions are monotonic — counts only go up — which is why we keep the minimum.

Why it matters here: a dense hash map of 3–4 billion video IDs to 64-bit counters is roughly 60–80 GB per window. A CMS sized for ~0.1% error across the same population fits in a few hundred MB. That means you can keep hot windows entirely in memory on a single node and scale horizontally via partitioning.

Trade-off: CMS gives you approximate counts for any key, but it does not by itself tell you which keys are the heavy hitters. You pair it with a second structure (a min-heap of size K, or a Space-Saving / Misra-Gries summary) that tracks candidate top items. Every increment updates the sketch; candidates admitted to the heap are verified against the sketch.

Gotcha: sketches drift over long horizons because old counts never decay. For all-time windows that is fine; for rolling windows you either rebuild per tumbling interval or run a forgetful variant (sliding-window CMS with multiple generations).

### 2. Heavy Hitters and Space-Saving

Space-Saving (Metwally) and Misra-Gries are the canonical streaming top-K algorithms. You keep a fixed number of slots (say 10K for a top-1K query). On each event, increment the slot if the key is present; otherwise replace the minimum-count slot with the new key, inheriting its count (Space-Saving) or decrement all slots (Misra-Gries).

These algorithms are elegant because they give you the candidate set directly, no separate heap needed, and they use O(K) memory regardless of how many unique videos exist. Combined with CMS for approximate count verification, they handle the top-K problem in a few hundred MB of state per window.

The error bound: any item with true frequency greater than `N/m` (where `m` is the number of slots) is guaranteed to be in the output. So with 10K slots and 1B events in a window, you catch everything that got more than 100K views. For trending content that floor is fine.

### 3. Streaming Aggregation with Flink

Flink is the default choice because it handles the annoying parts of stream processing: event-time semantics, watermarks, exactly-once sinks, and large keyed state backed by RocksDB.

Shape of the job:

- Source: Kafka consumer on `view-events`, keyed by `video_id`.
- Watermark strategy: `BoundedOutOfOrdernessWatermark` with ~30 seconds of slack — enough to tolerate network jitter without blowing the freshness SLA.
- Windowing: one job per window size (1h, 1d, 1m) or a single job emitting multiple granularities.
- State: per-key counters kept in RocksDB. Checkpoints to S3/HDFS every minute or two.
- Sink: upsert into the rollup table or write to Redis sorted sets.

Keyed partitioning is what makes this parallel. Each Flink task owns a disjoint set of `video_id` keys and never needs to coordinate with other tasks for aggregation. Cross-key coordination only happens at the top-K reduction step.

### 4. Time Windows: Tumbling vs Sliding

**Tumbling windows** are disjoint and fixed: `[9:00, 10:00)`, `[10:00, 11:00)`. Every event belongs to exactly one window. Easy to reason about, trivial to materialize — you emit a final count when the window closes and never touch it again.

**Sliding windows** move continuously: "last 60 minutes" at 10:06:00 means `[9:06, 10:06)`; at 10:06:01 it shifts by a second. These give a smoother user experience (no sudden "top videos reset at the top of the hour") but cost far more state because events stay in scope for the whole window length.

A common compromise is **hopping windows**: a 1-hour window that advances every 5 minutes. You materialize overlapping windows at fixed offsets. For a trending page this is usually good enough.

For this design, tumbling is the default because the spec says "top-K for the last hour/day/month." If you want "last hour as of right now," you compose from finer-grained tumbling buckets — see the next deep dive.

### 5. Tiered Time-Window Aggregation

Rather than keep one monolithic counter per window size, maintain rollups at multiple granularities: per-minute, per-hour, per-day, per-month. A query for "last 1 hour" sums 60 per-minute buckets. "Last 1 day" sums 24 per-hour buckets. "Last 1 month" sums 30 per-day buckets.

This buys you three things. First, you can answer the implicit "sliding" semantics (last hour ending now) cheaply by summing a small, bounded number of pre-computed buckets. Second, you amortize writes: 60 events get folded into one per-minute bucket before anything touches the per-hour rollup. Third, old buckets can be evicted or moved to cold storage on a schedule that matches the largest window they feed.

Real-time OLAP engines (Druid, Pinot) bake this pattern in as "ingestion-time rollups." You can implement the same thing by hand on top of Postgres or Cassandra.

### 6. Approximate vs Exact Trade-offs

Exact counts require a counter per `(video_id, window)` tuple. Storage and update costs scale with cardinality. At 3–4 billion videos, exact all-time counts are expensive but tractable with sharding. Exact per-hour counts are worse, because the cardinality of "videos viewed this hour" is also enormous.

Approximate algorithms (CMS, Space-Saving, HyperLogLog for distinct counts) trade bounded error for dramatic memory savings and simpler scaling. The question to ask the interviewer: "Is being off by 0.1% on view counts acceptable if it lets us serve the top-K in tens of milliseconds at any scale?" For a trending page the answer is almost always yes; for a creator's ad-revenue dashboard it is no.

A hybrid model works well: approximate counts drive the real-time trending UI, and an offline exact pipeline (Spark batch over event logs) reconciles the numbers daily for billing, analytics, and cold-storage rollups.

### 7. Fault Tolerance and Exactly-Once

The pipeline has three failure axes:

- **Ingest**: Kafka replication (RF=3) and producer acks=all make event loss unlikely. Idempotent producers plus event IDs dedupe retries.
- **Stream processing**: Flink checkpoints state to durable storage. On restart it replays from the last checkpoint and consumes Kafka from the matching offset. Combined with transactional sinks this gets you end-to-end exactly-once.
- **Serving**: If the cache is cold, the API falls back to the rollup store. If the rollup store is unavailable, the last good cached top-K is served with a stale indicator. Request coalescing during cache fills prevents thundering herd.

Accept that "exactly-once" in streaming really means "effectively exactly-once given idempotent writes." You do not get literal once-delivery; you get idempotent processing such that the observable state is as if each event was processed once.

### 8. Sharding Strategy

Partition by `video_id` at every layer — Kafka, stream processor state, rollup store. This keeps all events for a given video on one physical path and turns aggregation into an embarrassingly parallel per-partition job.

Top-K queries require a fan-out: query each shard for its local top-K, merge the partial lists on the coordinator. This is the classic MapReduce top-K. You need to query at least top-K from each shard (more is safer); the merge step sorts `N * shards` items and returns the global top-K.

Hot videos — a Mr. Beast launch going viral — can create hot partitions. Mitigations: key salting for write-hot videos (split one video's events across multiple sub-keys, merge on read), two-tier aggregation (local pre-aggregation per task before the keyed shuffle), or a dedicated "celebrity" path that handles the top fraction of a percent of videos on oversized hardware.

---

## Scaling Journey: 0 to Infinity

This is the progression I would walk through in an interview, grounding each step in what specifically breaks.

### Stage 1: 0 to 100 Events/sec

**Goal**: Prove the concept. Correctness over everything. A single process should be able to answer every query.

**Architecture**: A monolithic web service with a Postgres database. View events `INSERT` into a `view_events` table. Top-K queries run `SELECT video_id, COUNT(*) FROM view_events WHERE ts > now() - interval '1 day' GROUP BY video_id ORDER BY 2 DESC LIMIT K`. An index on `(video_id, ts)` helps. For all-time, a `video_counts(video_id, count)` table updated on insert avoids the full scan.

**What you skip**: No Kafka, no stream processor, no cache, no sharding. Events and queries hit the same database. A single box, probably a read replica for analytics if you are feeling fancy.

**Failure mode**: The `GROUP BY ts > now() - interval '1 month'` query starts to time out as the table crosses tens of millions of rows. Indexes can only do so much when the aggregation touches half the table. The write path is also starting to contend with the query path on I/O.

### Stage 2: 100 to 1K Events/sec

**Goal**: Decouple reads from writes. Make top-K queries cheap even as the event table grows.

**Architecture**: Introduce a rollup table: `video_counts_hourly(video_id, hour_bucket, count)`. A cron job (or a trigger on insert) increments the current hour's bucket. Top-K queries sum recent buckets instead of scanning `view_events`. Add a Redis cache in front of the API that stores the computed top-K for each window with a 30–60 second TTL. A tiny background worker refreshes the cache proactively so user reads are always hot.

**What you skip**: Still no streaming infrastructure. The rollup is updated synchronously or via a per-minute cron. Still a single Postgres instance. Still no approximate algorithms.

**Failure mode**: The synchronous rollup update becomes a write hotspot — every event takes a row lock on the same `(video_id, current_hour)` row. Peak traffic creates lock contention. The `view_events` table's growth rate makes backups painful. A spiky viral video saturates its partition's write capacity.

### Stage 3: 1K to 100K Events/sec

**Goal**: Asynchronous, buffered ingest. Horizontal write scaling. Precomputed rollups fed by a stream processor.

**Architecture**: Put Kafka in front of everything. Producers (edge API) write view events to a partitioned topic keyed by `video_id`. A Flink job consumes the topic, maintains per-window counters in keyed state, and emits materialized rollups to a sharded Postgres or Cassandra every 10–30 seconds. The API reads the rollup store through Redis with request coalescing. Introduce Redis sorted sets (`ZSET`) keyed by window, `ZADD video_id score=count` — `ZREVRANGE 0 K-1` gives you the top-K in O(log N + K). Use these as the read-path hot cache.

**What you skip**: Still exact counts. No approximate algorithms yet — state fits in RocksDB per Flink task. No multi-region. No cold-storage tiering beyond rotating old partitions.

**Failure mode**: Flink's RocksDB state for the monthly window starts blowing past the local disk budget on the largest tasks. Hot video keys cause one partition's throughput to lag the fleet, creating per-partition freshness skew. The rollup store's write amplification from per-video upserts becomes the next bottleneck.

### Stage 4: 100K to 1M Events/sec

**Goal**: Bound memory with approximate algorithms. Mitigate key skew. Tier the rollups.

**Architecture**: Swap exact counters for a **Count-Min Sketch + Space-Saving** pair inside the Flink operator state. Memory drops from tens of GB per task to a few hundred MB with bounded error. Add key salting for the top 0.01% of videos — split their event streams across multiple sub-keys, then merge at read. Introduce tiered aggregation: per-minute → per-hour → per-day → per-month, where each tier is fed by the tier below. Move the rollup store to a real-time OLAP engine (Druid, Pinot, or ClickHouse) that natively supports ingestion-time rollups. Put a CDN or regional cache in front of the top-K API because reads vastly outnumber writes.

**What you skip**: No cross-region replication yet. No per-region top-K (still global). All-time counts still use an exact path because they are small and authoritative.

**Failure mode**: A single Kafka cluster and a single region become the bottleneck. Cross-Atlantic event latency pushes the freshness SLA. The coordinator doing the top-K merge across hundreds of shards becomes a bottleneck for `K=1000` queries.

### Stage 5: 1M+ Events/sec (Hyperscale)

**Goal**: Multi-region ingest. Hierarchical top-K. Graceful degradation under any failure.

**Architecture**: Deploy the ingest pipeline per region. Each region runs its own Kafka + Flink + rollup store, producing regional top-K lists. A global aggregation layer periodically merges regional results into a world top-K using the same MapReduce-style fan-in. Use a gossip or pub-sub channel for regions to exchange their heavy-hitter candidates so global merges do not miss videos that are medium-hot in every region but top-K nowhere. Tier storage: recent windows in Redis/memory, older rollups in ClickHouse/Pinot, raw events archived to object storage after 30–90 days. Async reconciliation jobs (Spark on S3 event logs) run nightly to fix approximate drift. The API gracefully falls back to "last known good" top-K during any partial outage and surfaces staleness to the client.

**What you skip**: Nothing, but there is always more: ML-driven anomaly detection for view fraud, personalized trending, real-time A/B testing of the trending algorithm itself.

**Failure mode**: At this scale you are no longer scaling a system; you are running a product. Failures become organizational rather than technical — data quality regressions, schema migrations across dozens of services, coordinating rollouts across regions. The architecture is fundamentally capable of another 10x, but each 10x requires care, not invention.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What the interviewer expects |
|---|---|---|
| **Mid-level (E4/L4)** | ~80% breadth, 20% depth | End-to-end correct design at modest scale. Clear API, reasonable data model, identifies at least one scaling pinch point (e.g., "this query will get slow"). Can name Kafka and Redis but may not reason about partitioning or exactly-once. Interviewer drives the deep dives. |
| **Senior (E5/L5)** | ~60% breadth, 40% depth | Near-optimal topology. Proactively reaches for stream processing and pre-aggregation without prompting. Can explain tumbling vs sliding windows, watermarks, and why partitioning by `video_id` matters. Discusses cache invalidation and request coalescing. Comfortable with one approximate algorithm (CMS or Space-Saving) and knows when to apply it. |
| **Staff+ (E6+/L6+)** | ~40% breadth, 60% depth | Drives the conversation into hyperscale trade-offs unprompted. Compares multiple approximate algorithms, discusses hot-key mitigation, fault tolerance with exactly-once semantics, multi-region aggregation, and tiered storage. Can quantify error bounds and memory footprints. Draws on production experience: "we ran into this at X, here is what broke and why." Minimal interviewer steering; interviewer is mostly probing for gaps. |
