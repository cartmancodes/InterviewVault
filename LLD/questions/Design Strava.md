# Design Strava

> **Pattern**: Time-series / Geospatial
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/strava)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. GPS Ingest Pipeline](#1-gps-ingest-pipeline)
   - [2. Offline-First Recording on the Phone](#2-offline-first-recording-on-the-phone)
   - [3. Segment Matching](#3-segment-matching)
   - [4. Leaderboards](#4-leaderboards)
   - [5. Global Heatmaps](#5-global-heatmaps)
   - [6. Friend Activity Feed and Realtime Sharing](#6-friend-activity-feed-and-realtime-sharing)
6. [Scaling Journey: 0 to infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Strava records an athlete's run or ride as a time-ordered stream of GPS samples, stitches them into an activity with aggregate metrics (distance, pace, elevation gain), and exposes both personal history and social features (friend feeds, segment leaderboards, global heatmaps) on top of that corpus. The hard parts are not CRUD; they are (1) ingesting bursty, occasionally offline, multi-million-concurrent GPS streams without dropping points, (2) matching each new track against millions of community-defined road/trail segments to compute effort times, and (3) keeping per-segment leaderboards and global heatmaps fresh on top of an ever-growing time-series corpus.

### Functional Requirements

**In scope:**
1. An athlete can start, pause, resume, stop, and save a run or ride; the phone records GPS + timing throughout.
2. During the activity the athlete sees live local stats — current pace, distance, elapsed time, elevation, route trace on a map.
3. After save, the athlete can view their own completed activities with full map trace, splits, elevation profile, and segment efforts.
4. An athlete can view their friends' recent activities in a feed.

**Out of scope:**
1. Friend management (adding / removing / blocking).
2. Authentication and authorization (assumed handled upstream).
3. Social engagement — likes, comments, kudos, photos.
4. Training plans, subscriptions, billing.
5. Device integrations beyond the phone (Garmin, Wahoo, Apple Watch sync) — architecturally similar but out of scope here.

### Non-Functional Requirements

1. **Scale:** 10M concurrent in-progress activities at peak (e.g., Saturday morning worldwide).
2. **Availability >> consistency:** a recording in progress must never be lost because the server is unreachable. Eventual consistency on feeds, leaderboards, and segment matches is acceptable.
3. **Offline-tolerant recording:** GPS capture must continue in remote areas with no network; upload when connectivity returns. The "truth" of an activity lives on the device until it is acknowledged by the server.
4. **Live local accuracy:** on-device stats (distance, pace, elevation) must update each second against the fresh GPS sample — no round-trip to the server required.
5. **Ingest throughput:** at 1 Hz sampling, 10M concurrent activities = 10M points/sec sustained. With ~50 bytes/point, ~500 MB/sec of raw ingest.
6. **Storage growth:** a 1-hour run at 1 Hz is 3,600 points ≈ 180 KB raw. 10M activities/day × 180 KB ≈ 1.8 TB/day of raw GPS, before indexes and aggregates.
7. **Latency targets:** activity save → visible in own history in seconds; friend feed visible in tens of seconds; segment leaderboard refreshed within minutes of the activity upload.

---

## Core Entities

| Entity | Fields | Notes |
|---|---|---|
| **User** | `user_id` (PK), `display_name`, `home_region`, `weight`, `ftp`, `privacy_default`, `created_at` | Athlete profile. Weight/FTP feed derived metrics like calories and power zones. |
| **Activity** | `activity_id` (PK), `user_id` (FK), `type` (run/ride/hike), `started_at`, `ended_at`, `total_distance_m`, `moving_time_s`, `elevation_gain_m`, `avg_hr`, `status` (uploading/processed/failed), `visibility`, `gps_blob_ref` | The immutable record of a completed effort. Aggregates are denormalized so the activity detail page doesn't need to rescan the GPS stream. |
| **GPSTrace** (the stream) | `activity_id`, `ts`, `lat`, `lon`, `alt`, `speed`, `hr` (optional), `cadence` (optional) | 1 Hz time series. Belongs to exactly one activity. Stored as a compressed blob (e.g., GPX / FIT / custom delta-encoded format) in object storage for cheap cold access, and/or in a time-series DB for hot analytical queries. |
| **Segment** | `segment_id` (PK), `creator_id`, `name`, `activity_type`, `polyline` (ordered list of `(lat, lon)`), `start_point`, `end_point`, `length_m`, `bounding_box`, `geohash_cells[]` | A community-defined named stretch of road or trail. Immutable once created. Indexed spatially so a new track can be checked against nearby segments in O(relevant-area) instead of O(all-segments). |
| **SegmentEffort** | `effort_id` (PK), `segment_id` (FK), `activity_id` (FK), `user_id` (FK), `started_at`, `elapsed_s`, `moving_time_s`, `rank_overall`, `rank_in_gender`, `rank_in_age_group` | One athlete's one attempt at one segment. The unit record that feeds leaderboards. |
| **Leaderboard** (derived) | `segment_id`, `scope` (all-time/yearly/this-year-for-me/following), `entries: [(user_id, effort_id, elapsed_s, rank)]` | Not a source-of-truth table; a materialized view over `SegmentEffort` kept in Redis sorted sets for O(log n) insert and O(1) top-K read. |
| **HeatmapTile** (derived) | `zoom`, `x`, `y`, `activity_type`, `counts` (pixel grid of activity pass-counts) | A precomputed map tile aggregating anonymized activity density. Rebuilt periodically from the GPS corpus. |
| **FeedEntry** (derived) | `owner_id`, `activity_id`, `created_at` | Fan-out-on-write entry so `GET /feed` is a cheap range scan, not a join across friends. |

---

## API Design

```http
# Start a new activity (client mostly records locally; this reserves an ID)
POST /activities
{
  "type": "run",
  "started_at": "2026-04-20T14:00:00Z",
  "client_activity_uuid": "a1b2-..."   // idempotency key from the phone
}
200 OK
{ "activity_id": "9f3..." }

# Stream GPS points while recording (batched, resumable)
POST /activities/{activity_id}/points
{
  "batch_id": 42,
  "points": [
    { "ts": 1713621600, "lat": 47.6062, "lon": -122.3321, "alt": 56, "speed": 3.2, "hr": 142 },
    ...
  ]
}
202 Accepted
{ "last_acked_batch_id": 42 }

# Finalize and request server-side processing (segment match, aggregates)
POST /activities/{activity_id}/complete
{
  "ended_at": "2026-04-20T15:02:17Z",
  "client_summary": { "distance_m": 12050, "moving_time_s": 3737, "elevation_gain_m": 148 }
}
200 OK
{ "activity_id": "9f3...", "status": "processing" }

# Read own activity detail
GET /activities/{activity_id}
200 OK
{ "activity_id": "...", "summary": {...}, "segment_efforts": [...], "trace_url": "https://cdn/..." }

# Friend feed
GET /feed?cursor=...&limit=20
200 OK
{ "items": [ { "activity_id": "...", "user": {...}, "summary": {...} } ], "next_cursor": "..." }

# Segment leaderboard
GET /segments/{segment_id}/leaderboard?scope=all-time&gender=M&age=30-34&top=100
200 OK
{ "entries": [ { "rank": 1, "user": {...}, "elapsed_s": 214, "activity_id": "..." } ] }

# Heatmap tile (served via CDN)
GET /heatmap/{type}/{z}/{x}/{y}.png
200 OK (image/png, Cache-Control: public, max-age=86400)
```

**Idempotency:** both `POST /activities` (`client_activity_uuid`) and point batches (`batch_id` monotonic per activity) are idempotent so a phone with flaky connectivity can safely retry without creating duplicates or gaps.

**Writes are client-authoritative until completion.** The phone owns the in-progress activity. The server's job during recording is only to durably stage whatever has been uploaded so far — if the phone dies, whatever made it up is recoverable, but that's a best-effort nicety, not the primary promise.

---

## High-Level Design

```
                     RECORD-TIME (live, 10M concurrent)
 Phone (local store + UI) --batched POST /points--> API Gateway
                                                       |
                                                       v
                                              Ingest Service (stateless)
                                                       |
                                                       v
                                               Kafka (topic: gps.raw)
                                                       |
                         +-----------------------------+------------------------------+
                         v                             v                              v
                Time-Series Store (hot)       Object Storage (cold blob        Stream Processor
                e.g., Timescale / Influx      GPX/FIT per activity, S3)        (e.g., Flink)
                         |                                                             |
                         |                                                             v
                         |                                                 Segment Matcher (async)
                         |                                                             |
                         |                                                             v
                         |                                                 Leaderboard Updater
                         |                                                 (Redis sorted sets)
                         |                                                             |
                         v                                                             v
                  Activity Service <------- reads ------- Feed Service    Leaderboard Service

                     READ-TIME
 Client --GET /activities/{id}--> Activity Service --> Postgres (metadata) + S3 (trace blob via CDN)
 Client --GET /feed--------------> Feed Service -----> Redis (feed timeline) + Activity Service
 Client --GET /leaderboard-------> Leaderboard Service -> Redis sorted sets
 Client --GET /heatmap tile-----> CDN ----------------> Object storage (precomputed PNG/MVT tiles)
```

Three distinct paths with different SLAs:

1. **Hot ingest** (live recording) — optimized for throughput and survivability, not query. Goal: accept the point, durably log it, ack the client. No synchronous work on the request path.
2. **Async enrichment** — Kafka consumers compute aggregates, match segments, update leaderboards, fan out feed entries. Failures are retried from Kafka offsets; nothing here is on a user's request path.
3. **Read** — every read hits a purpose-built store (Postgres for activity metadata, S3+CDN for the trace polyline, Redis for feeds and leaderboards, tile CDN for heatmaps). The GPS stream is never rescanned on the read path.

The time-series store and the object store hold the same data at different tiers: time-series for analytical queries on recent activity, S3 for the canonical cheap long-term copy. Older activities age out of the time-series store; the blob in S3 remains forever.

---

## Deep Dives

### 1. GPS Ingest Pipeline

**Problem:** 10M concurrent activities at 1 Hz = 10M points/sec sustained. Writing each point synchronously to a durable relational DB would require ~10M write IOPS, which is not achievable on a single primary and wasteful (each point is tiny and almost never read individually). Meanwhile, phones have spotty connectivity and will retry in bursts, so instantaneous peaks can be 5-10x the sustained rate.

**Solution:**

1. **Batched upload from the phone.** The phone samples at 1 Hz locally and flushes in batches (e.g., every 30-60 seconds, or on wifi reappearance). Each batch has a monotonic `batch_id` per activity so the server can detect duplicates and gaps.
2. **Stateless ingest service.** The service does the minimum work: validate shape, attach `user_id` and `activity_id`, and produce the batch to Kafka. No DB write, no segment match, no aggregate update on the hot path. This is what lets one fleet handle millions of concurrent streams on modest hardware.
3. **Kafka as the durable buffer.** Partition the `gps.raw` topic by `activity_id` so all points for one activity land on one partition in order. Retention is long enough (hours-to-days) that downstream consumers can reprocess on failure without re-asking the phone.
4. **Downstream consumers fan out:**
   - **Time-series writer** writes each point into Timescale / Influx for recent-activity analytical queries.
   - **Blob assembler** buffers the stream per activity and, on `complete`, writes a single compressed GPX/FIT blob to S3. That blob is the canonical long-term copy.
   - **Stream processor (Flink / Kafka Streams)** maintains rolling aggregates per activity (distance, elevation gain) so the activity detail page has summary fields populated even before the blob is fully written.

**Tradeoff:** end-to-end latency from phone sample to "queryable on server" is seconds-to-tens-of-seconds, not milliseconds. That's acceptable because the live UX is served by on-device computation — the server doesn't need to be fresh to keep the athlete's phone displaying correct pace.

**Why not write each point to Postgres directly?** The per-point write amplification (WAL, index maintenance, replication) would cost orders of magnitude more than the information content is worth. Time-series stores are column-oriented with compression tuned for this shape and get 10-50x better per-byte and per-IOP economics.

### 2. Offline-First Recording on the Phone

**Problem:** The hardest requirement — "must work in remote areas without network" — means the server is not the source of truth during a recording. Any design that requires round-trips to the server per sample, or even per minute, breaks as soon as the athlete enters a canyon.

**Solution:** Treat the phone as the authoritative store for in-progress activities.

- GPS samples are written to a local append-only log (SQLite WAL, flat file, or similar) as they arrive from the OS location provider.
- Live stats (pace, distance, elevation gain) are computed entirely on-device from the local log. No server dependency.
- A background uploader drains the log in batches when network is available, tagging each batch with a monotonic `batch_id` and the `client_activity_uuid`.
- On `complete`, the phone sends the `ended_at` plus a client-computed summary. The server reconciles: it already has most batches, will request any missing ranges, and then kicks off async processing.
- If the phone dies before `complete`, the server still has every batch that was successfully uploaded and can "recover" the activity on next login.

**Tradeoff:** duplicate effort. The phone computes aggregates, and so does the server (because the phone's numbers aren't trustworthy — clock skew, paused-while-uploading mid-point, tampering). The server's numbers are canonical for leaderboards; the phone's numbers are canonical for live UX. They are allowed to disagree by small amounts.

### 3. Segment Matching

**Problem:** When a new activity completes, determine which of the millions of community segments the athlete traversed, and for each, the time spent. Naive approach — compare the new polyline against every segment — is O(segments) per activity; at millions of segments × 10M daily activities it's catastrophic.

**Solution:** Spatial pre-filter, then geometric match.

1. **Bounding-box index of segments** stored in a spatial index (R-tree in PostGIS, or S2/H3/geohash cells). At segment-creation time each segment's bounding box and the set of geohash cells its polyline crosses are indexed.
2. **Pre-filter by cell overlap.** For a new activity, compute the geohash cells its polyline crosses (typically dozens to hundreds at an appropriate precision) and fetch only the segments that share at least one cell. This drops the candidate set from millions to typically hundreds.
3. **Geometric match.** For each candidate segment, walk the activity's GPS points and look for (a) the point closest to the segment's `start_point` within a tolerance (e.g., 10 m), then (b) a continuous sub-path through the activity that tracks the segment's polyline within tolerance to `end_point`. Record the elapsed time between those two moments as a `SegmentEffort`.
4. **Run asynchronously.** The matcher consumes from Kafka after the blob assembler has the complete trace. Results are written to the `SegmentEfforts` table and forwarded to the Leaderboard Updater.

**Why not match live during the activity?** It's wasteful — the athlete may abandon, pause, or go off-route. It also requires streaming segment data to the phone, which bloats the install. Post-hoc matching on the server is simpler and runs once against the final polyline.

**Tradeoff: correctness vs cost.** Tolerance is a tuning knob. Too tight and real efforts get missed (a GPS blip pushes a point 15m off the trail). Too loose and a runner on a parallel trail gets credited for a different segment's effort. Strava tunes this per activity type (bike tolerances are looser than run because bikes deviate less from roads).

**Technology:** PostGIS with GiST index on segment bounding boxes, or Uber's H3 / Google's S2 hex-cell indexes for more uniform cell sizes than geohash. H3 is especially nice here because cell neighbors are well-defined and resolution is explicit.

### 4. Leaderboards

**Problem:** For each segment, serve top-K efforts across multiple slices — all-time, this year, this month, by gender, by age group, by "people you follow" — with low read latency and fresh updates as new efforts arrive. Efforts arrive at ~the rate of completed activities (100s/sec at scale); leaderboards are read at orders-of-magnitude-higher rates (every segment view hits them).

**Solution:** Precomputed, incrementally updated materialized views in Redis.

1. **Redis Sorted Set per (segment, scope).** Key like `lb:{segment_id}:alltime:M:30-34`, member = `user_id`, score = `elapsed_s`. `ZADD` on new effort is O(log n); `ZRANGE 0 99` for top-100 is O(log n + k).
2. **Write path.** When the Segment Matcher produces a `SegmentEffort`, the Leaderboard Updater publishes to all relevant sorted sets: the all-time board, the this-year board, the this-month board, the gender-partitioned boards, and the age-group boards. Each update is a single `ZADD`, so the fanout cost is bounded (constant number of scope sets per effort).
3. **"People you follow" leaderboards** cannot be precomputed per (segment, user) — combinatorial explosion. Instead, compute on read: fetch the viewing user's follow list (small, bounded by product limit e.g. 1000), then `ZINTERSTORE` or application-side merge their efforts on this segment. Acceptable because this view is read rarely compared to the global one.
4. **Yearly / monthly boards** live on per-period keys (`lb:{segment_id}:2026`) so they naturally expire via TTL or get swept at period rollover.
5. **Cheater / private effort filtering.** Leaderboard entries are "logical" — on read, the service hydrates entries with current privacy/flagging state from Postgres and filters. A user who goes private disappears from the visible top-K without needing to re-sort the set.

**Tradeoff:** storage. Each segment carries ~dozens of sorted sets. Millions of segments × dozens of scopes × thousands of entries = non-trivial Redis footprint. Mitigate by only materializing "active" segments (ones with efforts in the last N months) and rebuilding cold ones lazily on first read.

**Why not just query Postgres?** A `SELECT ... ORDER BY elapsed_s LIMIT 100 WHERE segment_id = ? AND year = 2026 AND gender = 'M'` works functionally but every leaderboard view is a sort, and at read-heavy scale that's the bottleneck. Redis sorted sets move the sort to write time (once) and make reads O(1)-ish.

### 5. Global Heatmaps

**Problem:** Render a world map where pixel brightness reflects how many activities have passed through that location. Across all Strava users, the corpus is billions of GPS points. Rendering this live per request is impossible; even the data volume involved exceeds what one viewport can pull.

**Solution:** Offline tile pipeline.

1. **Quantize points to map tiles.** Every GPS point is mapped to a pixel inside a (zoom, x, y) tile at some set of zoom levels (e.g., 3-15). For zoom 14 at equator, one tile covers ~2.4 km per side at 256 px — roughly 10 m/pixel.
2. **Aggregate pass-counts per pixel.** A batch job (Spark / Flink) reads the GPS corpus from S3 and produces, per (activity_type, zoom, x, y), a 256×256 grid of counts. Each point contributes +1 to the pixel it hits; line-drawing between successive points ensures segments between samples count too.
3. **Colorize and emit tile images.** Apply a log-scale colormap (heatmap brightness) and write a PNG (or vector MVT) tile to object storage. The CDN fronts these tiles with long cache TTLs.
4. **Refresh cadence.** Full global rebuild is expensive; do it weekly. Incremental updates (just the last week's activities, merged into last-good tiles) can run daily or hourly for regions with heavy activity.
5. **Privacy.** Only activities marked public contribute. Additionally, "start/end obfuscation zones" around homes are excised — any point within N meters of a user's declared home coordinate is dropped before aggregation, so the heatmap never reveals where individuals live.

**Why pre-render tiles instead of vector overlays?** At global zoom levels, sending raw point data to the client is gigabytes. PNG tiles are tiny (~10s of KB) and the CDN handles scale.

**Tradeoff:** freshness vs cost. Tiles are hours-to-days stale. That's fine — the heatmap is an aggregate view, not a live tracker.

### 6. Friend Activity Feed and Realtime Sharing

**Problem:** Show a user's friends' recent activities in a chronological feed. Each activity's completion must reach every follower's feed within seconds-to-tens-of-seconds, at 10M+ DAU scale.

**Solution:** Fan-out on write, with a fallback for celebrity fan-out.

1. **On activity `complete`,** publish an `activity.completed` event to Kafka.
2. **Feed Fanout Service** consumes the event, looks up the poster's followers in a follow-graph store, and writes one `FeedEntry` row per follower to a per-user feed store (Redis list / sorted set by timestamp, or a Cassandra partition per user).
3. **Read** is then a cheap range scan against a single key: `LRANGE feed:{user_id} 0 N`.
4. **Celebrity exception.** For users with very large follower counts (pro athletes with millions of followers), per-follower fanout is expensive and mostly wasted — most followers never open the app that day. For these, skip fanout and merge-on-read: `GET /feed` fetches the viewer's fanned-out entries plus pulls recent activities for any celebrities they follow. Small constant-size union at read time.
5. **Realtime push** (optional): when a follower's device is active, a WebSocket channel pushes new feed entries as they're fanned out, so the feed updates without polling. Falls back to pull on reconnect.

**Tradeoff:** fanout-on-write trades write amplification (O(followers) writes per activity) for cheap reads. It's the right choice when reads vastly outnumber writes, which they do for a social product.

---

## Scaling Journey: 0 to infinity

### Stage 1: 0-100 Users (MVP)

**Goal:** prove the loop — phone records a run, server stores it, the athlete can view it later with a map.

**Architecture:** Single server running the API + Postgres on the same box. One table per core entity: `users`, `activities`, and a `gps_points(activity_id, ts, lat, lon, alt)` table. The phone uploads the entire GPX blob at activity end (no live streaming); the server parses it, inserts summary into `activities`, and stores the raw GPX as a file on local disk (or a `bytea` column if really lazy). Map rendering uses an off-the-shelf tile provider (Mapbox, OSM).

**What you skip:** Kafka, S3, Redis, segment matching, leaderboards, heatmaps, friend feed. Don't even have "complete vs in-progress" — the activity materializes on upload.

**Failure mode that pushes to Stage 2:** the `gps_points` table grows by a row every second per activity and becomes the dominant storage footprint within weeks. Index maintenance on a relational table with millions of 50-byte rows is wasteful, and the activity detail page starts taking seconds to render the polyline because it's pulling thousands of rows per view.

### Stage 2: 100-1,000 Users (Early Growth)

**Goal:** stop abusing the relational DB for raw time-series data, and separate the athlete-visible metadata from the bulk GPS bytes.

**Architecture:**
- Keep Postgres for `users`, `activities` (metadata only), and `segments`.
- Move raw GPS traces out: the phone uploads a compressed GPX/FIT blob at `complete`, and the server stores it in **object storage (S3)**, keeping only a `gps_blob_ref` URL in the `activities` row.
- Activity detail page streams the blob via S3 + CDN, not through the API server.
- Introduce a simple async job (a cron or SQS worker) that, on new activity, recomputes aggregates from the blob and updates the `activities` summary columns.
- Still one app server, still no live ingest during the run.

**What you skip:** time-series DB, Kafka, segment matching in real time, Redis, multi-region. Postgres + S3 handles hundreds of activities per day easily.

**Failure mode that pushes to Stage 3:** segment matching is now product-critical (athletes demand leaderboards), and doing it per-activity in a cron job against every segment in a Postgres `segments` table does not scale — and running the matcher on the API server starves the live request path. Also, athletes want live-updating stats in the app that reconcile with server data, so upload-at-end stops feeling modern.

### Stage 3: 1K-100K Users (Product-Market Fit)

**Goal:** split the write path from the analytical path, introduce live streaming ingest, and stand up asynchronous enrichment.

**Architecture:**
- **Ingest Service** as its own fleet behind the load balancer. Accepts batched GPS point uploads during active activities and writes them to **Kafka** (`gps.raw`, partitioned by `activity_id`).
- **Blob Assembler** consumer buffers per-activity streams and, on `complete`, writes the canonical GPX blob to S3. This is the same object store as Stage 2 — the entry point just changed.
- **Segment Matcher** consumer: on `complete`, pulls the blob, runs the spatial pre-filter + geometric match against segments stored in **PostGIS** with a GiST R-tree index on bounding boxes, and writes `SegmentEffort` rows.
- **Leaderboard Service** with Redis sorted sets for top-K per (segment, scope). Segment efforts get `ZADD`ed as they're produced.
- **Feed Service** with fan-out-on-write into a per-user Redis feed list.
- Postgres primary + read replica for `users`, `activities` metadata, `segments`, `segment_efforts`.

**What you skip:** tiered hot/cold storage (everything's "hot" at this size), multi-region, edge CDN compute, heatmaps (still out of scope or built as a naive weekly batch).

**Failure mode that pushes to Stage 4:** two things converge. (1) The `gps_points` data (still referenced for some analytical queries like "show me my pace graph") no longer fits comfortably in Postgres — tens of millions of activities × thousands of points each. (2) Kafka consumers doing per-activity segment matching are CPU-bound during Saturday-morning spikes, and the queue backs up to tens of minutes, violating the "leaderboard fresh within minutes" target.

### Stage 4: 100K-10M Users (Scale-Out)

**Goal:** separate hot analytical time-series from cold blob storage, horizontally scale the stream processors, and introduce precomputed heatmaps.

**Architecture:**
- **Time-series database (Timescale or InfluxDB)** becomes the hot analytical store for recent activities' GPS streams. The Ingest pipeline writes there in addition to S3. Timescale gives you columnar compression and time-range queries 10-100x faster than row-oriented Postgres.
- **Tiered GPS storage:**
  - Hot tier (last ~90 days): in Timescale, indexed by `activity_id` + time, supports fast per-activity playback and aggregation queries.
  - Cold tier (older): only in S3 as the GPX blob. Retrieval is still cheap for individual activity views; bulk analytical queries over cold data go through a Spark/Athena job, not a live request.
- **Stream processor (Flink)** replaces ad-hoc Kafka consumers for rolling aggregates and segment matching. Horizontally scales by partition; checkpoints to S3 so a crashed worker resumes from the last committed offset without reprocessing.
- **Heatmap pipeline** runs as a weekly Spark batch over S3 GPX blobs, producing tiles at zoom 3-15 for each activity type into a `heatmap/` bucket behind the CDN. Incremental daily updates merge the last day's tiles into the baseline.
- **Redis Cluster** (not a single instance) hosts leaderboards and feeds, sharded by `segment_id` and `user_id` respectively so no single key is hot.
- **Postgres** is sharded vertically by concern: one cluster for users/activities metadata, one for segments/efforts (with PostGIS). Both have read replicas.

**What you skip:** full multi-region active-active — still single-region with CDN fronting reads. Cross-region replication of Kafka and Postgres is a Stage 5 problem.

**Failure mode that pushes to Stage 5:** 10M concurrent activities worldwide means a single-region ingest fleet sees 500 MB/sec from Asia at Asia's peak while us-east-1 is asleep, and the cross-Pacific WAN latency during Asian peak hurts phone upload reliability. Also, the heatmap is stale by a week, which is visible to the product team.

### Stage 5: 10M+ Users (Hyperscale)

**Goal:** regionalize ingest, push read paths to the edge, and push enrichment freshness down to sub-minute.

**Architecture:**
- **Multi-region active-active ingest.** Ingest Services in us-east, eu-west, ap-south, each writing to a regional Kafka cluster. Activity records carry a `home_region` and stay there; cross-region replication (MirrorMaker 2, or a managed equivalent) copies the Kafka topic to other regions for consumers (heatmap, global leaderboard builder) that need the world's data.
- **Regional blob stores,** with S3 cross-region replication for disaster recovery but reads going to the user's home region bucket.
- **Regional Redis Clusters** for feeds and leaderboards. Global leaderboards for a segment need a single authoritative Redis shard per segment — route segment updates from all regions to the segment's home region (decided by hash), tolerating the cross-region write latency because leaderboard writes are async anyway.
- **Edge-cached heatmap tiles** via the CDN (Cloudflare, CloudFront) with purge-on-publish when a new tile batch lands. Tile generation moves from weekly to daily-incremental, and hot regions (urban centers, popular trails) update more frequently.
- **Flink segment-matching job** parallelized enough to keep end-to-end lag (phone completes -> leaderboard updated) under 60 seconds at p99 even during Saturday-morning peak.
- **Cold storage tier for old activities:** blobs older than N years move from S3 Standard to Glacier. Activity detail pages for ancient activities may take a second longer on first view (retrieval from Glacier), but the `activities` row stays in Postgres so listing still works.
- **Abuse detection pipeline:** anomalous speed profiles (motorcycle-paced "runs") flagged during segment matching and excluded from public leaderboards.
- **Operational maturity:** regional failover runbooks, cross-region Kafka lag dashboards, per-shard Redis capacity alerts, chaos drills on ingest with simulated phone retry storms.

Beyond this, scaling is mostly cost and operational engineering — renegotiate CDN and object-storage pricing, tune Timescale retention against query patterns, and push the heatmap pipeline onto spot / preemptible compute.

---

## Expected Depth by Level

| Area | Mid | Senior | Staff+ |
|---|---|---|---|
| **Requirements** | Captures record + view; asks about scale when prompted. | Proactively names offline-tolerance and availability-over-consistency as load-bearing; quantifies 10M concurrent and ingest bandwidth. | Frames the whole design around "phone is source of truth during recording" and derives the ingest/async-enrichment split from that. |
| **GPS ingest** | Uploads the full GPX at end. | Batched upload during activity, Kafka as durable buffer, idempotent batch IDs. | Explicit partitioning strategy on `activity_id`, tradeoff between time-series DB and blob store with tiering; reasoning about write amplification. |
| **Offline recording** | Says "retry on network." | Designs a local append-only log with monotonic batch IDs and server reconciliation. | Reconciles client-computed vs server-computed aggregates; articulates the two-truth model and which is canonical for which surface. |
| **Segment matching** | Mentions checking GPS against segments. | Spatial pre-filter via geohash / R-tree, then geometric match; knows it's async post-complete. | H3 vs S2 vs geohash tradeoffs, tolerance tuning per activity type, handling GPS drift, out-of-order late-arriving points. |
| **Leaderboards** | Queries a table ordered by time. | Redis sorted sets per (segment, scope), `ZADD` on effort, O(log n) reads. | Scope combinatorics (all-time / year / gender / age / following), follower-scoped on-read merging, privacy filtering on hydration, cold-segment lazy materialization. |
| **Heatmaps** | Not expected. | Offline batch producing map tiles; CDN serves them. | Pixel aggregation pipeline, log colormap, privacy obfuscation zones, incremental vs full rebuild, vector (MVT) vs raster tradeoffs. |
| **Feed** | Pull from friends' activity table. | Fan-out-on-write per follower, Redis per-user feed list. | Celebrity fan-out exception, merge-on-read fallback, realtime WebSocket push with pull reconcile. |
| **Storage tiering** | One database holds everything. | Separates GPS blob (S3) from metadata (Postgres). | Hot time-series DB + cold S3 + Glacier for ancient; reasoning about per-tier $ / query patterns. |
| **Failure modes** | "Server goes down." | Phone retry, Kafka consumer restart from offset, Redis failover. | Cross-region Kafka lag, segment-matcher backpressure on Saturday peak, heatmap pipeline cost blowout, follower fanout storms on celebrity posts. |
| **Geo / regional** | Not expected. | Single region + CDN for static and tiles. | Active-active ingest, regional Kafka with MirrorMaker, segment-home-region routing for leaderboards, Glacier tier for cold blobs. |
