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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Think of the Billboard Hot 100. Every week, the music industry counts radio plays, sales, and streams across the entire country to figure out the top 100 songs. Nobody actually listens to every single play — they aggregate counts from sample stations and projection models, then publish a chart. That's exactly the Top-K problem: out of millions of songs, surface the handful that matter most right now.

A simpler version: a school's "most-borrowed library books" leaderboard. Every book has a checkout counter on its card. The librarian wants the top 10 most popular books this month. Reading every single checkout slip would take all night — instead, every checkout adds 1 to a tally per book, and once a day the librarian sorts the tally to find the top 10. Or imagine a bakery owner with a clicker by the cash register for each pastry; at end of day, she sorts the clickers to see whether croissants or muffins won.

YouTube's challenge is that same idea, but with a few twists that make it brutal:

- **Counting at scale**: YouTube has billions of views per day. You can't write every view to one single counter — that counter would melt (a "hot key"). Instead, each region or datacenter keeps its own counter, and they're summed together periodically.
- **Approximate counting**: counting every view exactly is wasteful when all you need is "approximately the top 100." Algorithms like Count-Min Sketch trade a tiny bit of accuracy for huge memory savings.
- **Time windows**: "top 10 today" needs different math than "top 10 ever." The system maintains rolling windows or buckets of counts so it can answer either question quickly.
- **Heavy hitters vs the long tail**: 99% of videos get only a few views; 1% get millions. The system has to be efficient for both extremes — it can't waste memory on every obscure cooking video, but it can't lose the viral hits either.

### When the analogy breaks down

Real YouTube fights view fraud (bots inflating counts), shifts top-K constantly across regions, genres, and timeframes, and balances "actual top" vs "personalized recommendations" — the trending chart you see is sometimes filtered just for you, mixing global popularity with what your account is likely to click. The Billboard chart is one global list; YouTube's "top K" is really thousands of overlapping lists computed simultaneously.

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

Sizing CMS correctly is a practical skill interviewers probe. The width `w` controls per-estimate error: setting `w = ceil(e / ε)` (where `e` ≈ 2.718 and `ε` is your desired relative error) gives estimates within `ε * N` of the true count. The depth `d = ceil(ln(1/δ))` controls failure probability `δ`. For 1% error at 99% confidence: `w ≈ 272`, `d ≈ 7`. In practice, `w=2000, d=5` gives sub-1% error for typical workloads with a tiny memory footprint — around 80 KB for 32-bit counters.

Trade-off: CMS gives you approximate counts for any key, but it does not by itself tell you which keys are the heavy hitters. You pair it with a second structure — a min-heap of size K, or a Space-Saving / Misra-Gries summary — that tracks candidate top items. Every increment updates the sketch; candidates admitted to the heap are verified against the sketch count.

Gotcha: sketches drift over long horizons because old counts never decay. For all-time windows that is fine; for rolling windows you either rebuild per tumbling interval or run a forgetful variant — a sliding-window CMS with multiple generational layers. In the generational approach, you maintain G sketch generations of equal time span; on each event you increment the current generation's sketch, and the estimated count for any key is the sum across all non-expired generations. When the oldest generation falls outside the window, its sketch is discarded and a fresh generation starts.

### 2. Heavy Hitters and Space-Saving

Space-Saving (Metwally) and Misra-Gries are the canonical streaming top-K algorithms. You keep a fixed number of slots (say 10K for a top-1K query). On each event, increment the slot if the key is present; otherwise replace the minimum-count slot with the new key, inheriting its count (Space-Saving) or decrement all slots (Misra-Gries).

These algorithms are elegant because they give you the candidate set directly — no separate heap needed — and they use O(K) memory regardless of how many unique videos exist. Combined with CMS for approximate count verification, they handle the top-K problem in a few hundred MB of state per window.

The Space-Saving guarantee is stronger than CMS for top-K: any item with true frequency greater than `N / m` (where `m` is the number of monitored counters) is guaranteed to appear in the output set — there are no false negatives for truly popular items. CMS can overcount non-popular items and inadvertently elevate them into your candidate heap; Space-Saving cannot miss a genuinely high-frequency item. The error bound for count estimates is also bounded above by `N / m`, so with 10K slots and 1B events in a window, every item with more than 100K true views is guaranteed to be tracked. For trending content that floor is acceptable.

The practical implication: in an interview, prefer Space-Saving over a raw CMS-plus-heap when you need a correctness guarantee about which items appear in the top-K set. Use CMS as a supplementary structure when you also need fast point-query estimates for arbitrary video IDs outside the tracked set.

### 3. Streaming Aggregation with Flink

Flink is the default choice because it handles the annoying parts of stream processing: event-time semantics, watermarks, exactly-once sinks, and large keyed state backed by RocksDB.

Shape of the job:

- Source: Kafka consumer on `view-events`, keyed by `video_id`.
- Watermark strategy: `BoundedOutOfOrdernessWatermark` with ~30 seconds of slack — enough to tolerate network jitter without blowing the freshness SLA.
- Windowing: one job per window size (1h, 1d, 1m) or a single job emitting multiple granularities.
- State: per-key counters kept in RocksDB. Checkpoints to S3/HDFS every minute or two.
- Sink: upsert into the rollup table or write to Redis sorted sets.

Keyed partitioning is what makes this parallel. Each Flink task owns a disjoint set of `video_id` keys and never needs to coordinate with other tasks for aggregation. Cross-key coordination only happens at the top-K reduction step, which is a periodic fan-in rather than a per-event operation.

A subtlety worth raising in interviews: Flink's exactly-once guarantee requires that sinks support idempotent writes or two-phase commit. Redis does not natively support 2PC, so the standard pattern is to write to Flink's Kafka sink with exactly-once semantics and have a separate job read from that output topic and write to Redis. Alternatively, accept at-least-once delivery to Redis and rely on the idempotent nature of counter increments — overcounting by a small number of replayed events is acceptable for a trending page.

### 4. Time Windows: Tumbling vs Sliding vs Session

**Tumbling windows** are disjoint and fixed: `[9:00, 10:00)`, `[10:00, 11:00)`. Every event belongs to exactly one window. Easy to reason about, trivial to materialize — you emit a final count when the window closes and never touch it again. The cost is that results jump at window boundaries, which can cause the top-K list to change abruptly at the top of the hour.

**Sliding windows** move continuously: "last 60 minutes" at 10:06:00 means `[9:06, 10:06)`; at 10:06:01 it shifts by a second. These give a smoother user experience but cost far more state because events stay in scope for the whole window length. Every event must be tracked with its timestamp so it can be removed when it ages out of the window.

**Hopping windows** are a common compromise: a 1-hour window that advances every 5 minutes. You materialize overlapping windows at fixed offsets, giving near-sliding smoothness at a bounded multiple of the tumbling cost. For a trending page this is usually good enough.

**Session windows** group events by gaps in activity per key — a window closes when there is no event for a configurable idle gap. These are useful for per-user session analytics but not relevant for global trending counts.

For this design, tumbling is the default because the spec says "top-K for the last hour/day/month." If you want "last hour as of right now" with smooth updates, compose from finer-grained tumbling buckets as described in the next deep dive.

Late-arriving events complicate all window types. A view event generated on a mobile device offline for 10 minutes arrives at the aggregator timestamped 10 minutes ago. Flink's watermark mechanism handles this: the watermark is the system's estimate of how far event time has advanced. Events with timestamps behind the current watermark minus the allowed lateness are either dropped or routed to a side output for reconciliation. Setting allowed lateness too low loses legitimate late events; too high delays window finalization. For a trending page, 30–60 seconds of allowed lateness covers most real-world network delays without degrading freshness.

### 5. Tiered Time-Window Aggregation

Rather than keep one monolithic counter per window size, maintain rollups at multiple granularities: per-minute, per-hour, per-day, per-month. A query for "last 1 hour" sums 60 per-minute buckets. "Last 1 day" sums 24 per-hour buckets. "Last 1 month" sums 30 per-day buckets.

This buys you three things. First, you can answer the implicit "sliding" semantics (last hour ending now) cheaply by summing a small, bounded number of pre-computed buckets. Second, you amortize writes: 60 events get folded into one per-minute bucket before anything touches the per-hour rollup. Third, old buckets can be evicted or moved to cold storage on a schedule that matches the largest window they feed.

Real-time OLAP engines (Druid, Pinot) bake this pattern in as "ingestion-time rollups." You can implement the same thing by hand on top of Postgres or Cassandra. Cassandra is a particularly natural fit: model the rollup as `(video_id, window_type, bucket_start) -> count` with a counter column, and use time-to-live (TTL) on rows to automatically expire old buckets. The downside is that Cassandra's counter columns do not support exactly-once semantics — you get at-least-once increment, which is fine for approximate trending but not for exact billing counts.

### 6. Approximate vs Exact Trade-offs

Exact counts require a counter per `(video_id, window)` tuple. Storage and update costs scale with cardinality. At 3–4 billion videos, exact all-time counts are expensive but tractable with sharding — roughly 32 bytes per entry (8 bytes video_id + 8 bytes count + overhead) gives ~120 GB for the all-time table across a modest cluster. Exact per-hour counts are worse, because the cardinality of "videos viewed this hour" is enormous and changes every hour.

Approximate algorithms (CMS, Space-Saving, HyperLogLog for distinct counts) trade bounded error for dramatic memory savings and simpler scaling. CMS for a billion-video population fits in a few hundred MB per window; Space-Saving at 10K slots uses a few MB. The question to ask the interviewer: "Is being off by 0.1% on view counts acceptable if it lets us serve the top-K in tens of milliseconds at any scale?" For a trending page the answer is almost always yes; for a creator's ad-revenue dashboard it is no.

A hybrid model works well in practice: approximate counts drive the real-time trending UI with sub-minute freshness, and an offline exact pipeline (Spark batch over event logs in S3) reconciles the numbers daily for billing, analytics, and cold-storage rollups. The two pipelines share the same raw event stream; only their consumers differ. This is effectively the Lambda architecture — the speed layer (streaming, approximate) handles latency requirements, and the batch layer (Spark, exact) handles correctness requirements.

### 7. Fault Tolerance and Exactly-Once

The pipeline has three failure axes:

- **Ingest**: Kafka replication (RF=3) and producer acks=all make event loss unlikely. Idempotent producers plus event IDs dedupe retries at the Kafka layer. Kafka's built-in log compaction and configurable retention mean events are recoverable even if the stream processor crashes and needs to replay from an earlier offset.
- **Stream processing**: Flink checkpoints state to durable storage (S3/HDFS) at configurable intervals. On restart it replays Kafka from the offset corresponding to the last successful checkpoint, and reprocesses events in between. Combined with transactional sinks (Kafka exactly-once output, or idempotent upserts with a deduplication key) this achieves end-to-end effectively-once semantics. The key word is "effectively" — you get idempotent processing such that the observable state is as if each event was processed once, not literal single delivery.
- **Serving**: If the cache is cold (after a restart or eviction), the API falls back to the rollup store directly. If the rollup store is unavailable, the last good cached top-K is served with a stale `generated_at` timestamp and a `"stale": true` flag in the response body — this lets clients display "updated 5 minutes ago" rather than showing an error. Request coalescing during cache fills (one goroutine fetches; others wait on a shared promise) prevents thundering herd when the cache expires.

Checkpoint interval is a practical tuning knob: shorter intervals mean less replay on restart but more I/O overhead during steady state. A 60-second checkpoint is a common default; for a freshness SLA of 1 minute, you want checkpoint interval to be well under that.

### 8. Sharding Strategy

Partition by `video_id` at every layer — Kafka, stream processor state, rollup store. This keeps all events for a given video on one physical path and turns aggregation into an embarrassingly parallel per-partition job. The shard key should be a consistent hash of `video_id` so that adding or removing shards requires only partial resharding.

Top-K queries require a fan-out: query each shard for its local top-K, merge the partial lists on the coordinator. This is the classic MapReduce top-K pattern. You need to request at least K results from each shard (more is safer if you expect imbalance); the merge step sorts `K * num_shards` items and returns the global top-K. At 100 shards and K=1000, the merge processes 100K items — trivially fast on a single node.

Hot videos — a Mr. Beast launch going viral — can create hot partitions. A single video driving millions of events per second will saturate the Kafka partition and the Flink task that owns its key. Mitigations:

- **Key salting for writes**: split the hot video's events across `N` sub-keys (`video_id:0`, `video_id:1`, ...). Each sub-key lands on a different partition and gets its own Flink task. At read time, sum the N sub-key counters to reconstruct the total. The tradeoff is that point queries for that video now require N lookups.
- **Two-tier aggregation**: each Flink task pre-aggregates locally before the keyed shuffle, reducing per-event coordination. Combine this with a brief time buffer (aggregate for 100ms before emitting) to batch bursts.
- **Dedicated celebrity path**: the top 0.01% of videos (known viral content, major channel launches) can be routed to an oversized dedicated path with pre-provisioned capacity, bypassing the general sharding scheme. Detection can be reactive (promote to celebrity path when a video's event rate exceeds a threshold) or predictive (based on subscriber count or scheduled premiere metadata).

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

**Failure mode**: Flink's RocksDB state for the monthly window starts blowing past the local disk budget on the largest tasks. Hot video keys cause one partition's throughput to lag the fleet, creating per-partition freshness skew. The rollup store's write amplification from per-video upserts becomes the next bottleneck. The Redis ZSET for the monthly window holding millions of video IDs starts consuming tens of GB — see Insider Tips for why this breaks.

### Stage 4: 100K to 1M Events/sec

**Goal**: Bound memory with approximate algorithms. Mitigate key skew. Tier the rollups.

**Architecture**: Swap exact counters for a **Count-Min Sketch + Space-Saving** pair inside the Flink operator state. Memory drops from tens of GB per task to a few hundred MB with bounded error. Add key salting for the top 0.01% of videos — split their event streams across multiple sub-keys, then merge at read. Introduce tiered aggregation: per-minute → per-hour → per-day → per-month, where each tier is fed by the tier below. Move the rollup store to a real-time OLAP engine (Druid, Pinot, or ClickHouse) that natively supports ingestion-time rollups. Put a CDN or regional cache in front of the top-K API because reads vastly outnumber writes. The Redis ZSET now holds only the top ~10K candidates — not the full frequency table — keeping its footprint well under 1 GB.

**What you skip**: No cross-region replication yet. No per-region top-K (still global). All-time counts still use an exact path because they are small and authoritative.

**Failure mode**: A single Kafka cluster and a single region become the bottleneck. Cross-Atlantic event latency pushes the freshness SLA. The coordinator doing the top-K merge across hundreds of shards becomes a bottleneck for `K=1000` queries.

### Stage 5: 1M+ Events/sec (Hyperscale)

**Goal**: Multi-region ingest. Hierarchical top-K. Graceful degradation under any failure.

**Architecture**: Deploy the ingest pipeline per region. Each region runs its own Kafka + Flink + rollup store, producing regional top-K lists. A global aggregation layer periodically merges regional results into a world top-K using the same MapReduce-style fan-in. Use a gossip or pub-sub channel for regions to exchange their heavy-hitter candidates so global merges do not miss videos that are medium-hot in every region but top-K nowhere. Tier storage: recent windows in Redis/memory, older rollups in ClickHouse/Pinot, raw events archived to object storage after 30–90 days. Async reconciliation jobs (Spark on S3 event logs) run nightly to fix approximate drift. The API gracefully falls back to "last known good" top-K during any partial outage and surfaces staleness to the client.

**What you skip**: Nothing, but there is always more: ML-driven anomaly detection for view fraud, personalized trending, real-time A/B testing of the trending algorithm itself.

**Failure mode**: At this scale you are no longer scaling a system; you are running a product. Failures become organizational rather than technical — data quality regressions, schema migrations across dozens of services, coordinating rollouts across regions. The architecture is fundamentally capable of another 10x, but each 10x requires care, not invention.

---

## Insider Tips and Tricks

### Count-Min Sketch Always Overestimates — This Is Acceptable
Count-Min Sketch (CMS) stores a 2D array of counters (d rows × w columns). Each item is hashed to one counter per row; the estimated count is the minimum across all rows. Hash collisions cause overcounting — you might count "cat videos" 5 instead of 3. CMS never undercounts. For top-K ranking, overcounting is safer than undercounting (you might promote a slightly less popular video, never miss the actual #1). Width w and depth d control accuracy: w=2000, d=5 gives <1% error rate for typical workloads.

### A Redis Sorted Set Cannot Hold 1 Billion Items
Redis sorted set (ZSET) stores scores in a skip list: O(log N) per operation, ~128 bytes per member. 1B videos × 128 bytes = 128GB in a single Redis instance — impractical. The correct approach: aggregate counts in CMS or approximate counters, then only promote the top ~10K candidates to the sorted set. The sorted set holds the leaderboard (top-K), not the full frequency table.

### "Heavy Hitters" and "Top-K" Are Different Problems
Heavy hitters: find all items whose frequency exceeds a threshold (e.g., >1% of all views). These exist regardless of relative ranking. Top-K: find the K items with the highest frequency — even if none is a "heavy hitter." Heavy hitter detection uses threshold-based algorithms (e.g., Misra-Gries). Top-K requires maintaining a min-heap of size K. Conflating them in an interview loses points; separating them shows depth.

### Space-Saving Algorithm Gives Exact Top-K with Bounded Error
The Space-Saving algorithm maintains exactly K counters. When a new item arrives: if it's already tracked, increment its counter; if not, replace the item with the smallest counter (incrementing by 1). The guarantee: the true top-K items will always be in the tracked set (no false negatives for truly popular items). This is stronger than CMS for top-K because CMS can promote non-top-K items due to overcounting.

### Tumbling vs Sliding vs Session Windows — Each Answers a Different Question
Tumbling window ("top videos in the last hour"): fixed-size, non-overlapping. Simple to implement; results jump at window boundaries. Sliding window ("top videos in the last 60 minutes, updated every minute"): overlapping windows. Smoother results; more computationally expensive. Session window ("top videos per user session"): gaps in activity define window boundaries. For global trending, tumbling hourly windows with sub-minute micro-batch processing is the standard approach.

### Late-Arriving Events Require Watermarks
A view event can arrive at the aggregator 5 minutes after it happened (mobile client was offline). Without handling late arrivals, the view is attributed to the wrong time window (or dropped). Stream processors (Flink, Kafka Streams) use watermarks — a timestamp that moves forward as events arrive, with a configurable allowed lateness. Events arriving after the watermark deadline are either dropped or sent to a "late data" side output for separate reconciliation.

### Aggregate at Multiple Levels Before Merging
Global top-K from 1B events/day cannot be computed in one place. The architecture: edge nodes aggregate into per-DC counts, regional aggregators merge DC counts, a global aggregator merges regional counts. Each level reduces data volume by 100-1000×. The global aggregator receives pre-aggregated summaries, not raw events. This is the map-reduce pattern applied to streaming.

### "Trending" Measures Rate of Change, "Popular" Measures Absolute Count
The top-10 most-viewed videos of all time is a "popular" query. The top-10 fastest-growing videos in the last hour is a "trending" query. They need different metrics: popularity uses raw count, trending uses delta count (or count in recent window divided by count in older window). Most "trending" features want the latter — a video with 10K views this hour that had 100 views last hour is more "trending" than a video with 1M views this hour that had 900K last hour.

### The Final Top-K List Must Be Eventually Consistent
Requiring strong consistency (every reader sees the exact same top-K at the same instant) requires distributed locking or a single-writer, both of which are bottlenecks. At YouTube scale, a 1-minute lag in the trending list is unnoticeable to users. Design the system for eventual consistency: background aggregation job runs every 1-5 minutes, writes results to a read-optimized store (Redis or CDN-cacheable API), readers always get the last computed result. This eliminates any read-path synchronization.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What the interviewer expects |
|---|---|---|
| **Mid-level (E4/L4)** | ~80% breadth, 20% depth | End-to-end correct design at modest scale. Clear API, reasonable data model, identifies at least one scaling pinch point (e.g., "this query will get slow"). Can name Kafka and Redis but may not reason about partitioning or exactly-once. Interviewer drives the deep dives. |
| **Senior (E5/L5)** | ~60% breadth, 40% depth | Near-optimal topology. Proactively reaches for stream processing and pre-aggregation without prompting. Can explain tumbling vs sliding windows, watermarks, and why partitioning by `video_id` matters. Discusses cache invalidation and request coalescing. Comfortable with one approximate algorithm (CMS or Space-Saving) and knows when to apply it. |
| **Staff+ (E6+/L6+)** | ~40% breadth, 60% depth | Drives the conversation into hyperscale trade-offs unprompted. Compares multiple approximate algorithms, discusses hot-key mitigation, fault tolerance with exactly-once semantics, multi-region aggregation, and tiered storage. Can quantify error bounds and memory footprints. Draws on production experience: "we ran into this at X, here is what broke and why." Minimal interviewer steering; interviewer is mostly probing for gaps. |
