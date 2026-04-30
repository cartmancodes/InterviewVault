# Design Instagram

> **Pattern**: Media + Feed
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/instagram)

---

## Table of Contents

- [Understanding the Problem](#understanding-the-problem)
  - [Functional Requirements](#functional-requirements)
  - [Non-Functional Requirements](#non-functional-requirements)
- [Core Entities](#core-entities)
- [API Design](#api-design)
- [High-Level Design](#high-level-design)
- [Deep Dives](#deep-dives)
  - [1. Photo Upload, Processing and CDN Delivery](#1-photo-upload-processing-and-cdn-delivery)
  - [2. Feed Generation: Pull vs Push vs Hybrid](#2-feed-generation-pull-vs-push-vs-hybrid)
  - [3. Stories and 24-Hour Ephemeral Storage](#3-stories-and-24-hour-ephemeral-storage)
  - [4. Consistent Feed Rendering and Pagination](#4-consistent-feed-rendering-and-pagination)
- [Scaling Journey: 0 → ∞](#scaling-journey-0--)
  - [Stage 1: 0 – 100 Users](#stage-1-0--100-users)
  - [Stage 2: 100 – 1,000 Users](#stage-2-100--1000-users)
  - [Stage 3: 1K – 100K Users](#stage-3-1k--100k-users)
  - [Stage 4: 100K – 10M Users](#stage-4-100k--10m-users)
  - [Stage 5: 10M+ Users](#stage-5-10m-users)
- [Insider Tips and Tricks](#insider-tips-and-tricks)
- [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Instagram is a photo- and video-sharing social network. A user uploads rich media with a caption, follows other users, and opens the app to a reverse-chronological feed of posts from everyone they follow. The design challenge blends two hard problems: **large-object media pipelines** (upload, encode, deliver via CDN) and **fan-out feed aggregation** at social-network scale, where follower counts range from zero to hundreds of millions.

### Functional Requirements

**In scope:**
1. Users can create posts containing photos or videos with a caption.
2. Users can follow other users.
3. Users can view a chronological feed of posts from accounts they follow.

**Out of scope:** likes and comments, hashtag/user/location search, stories and Reels (stories are revisited as a deep dive), live streaming, DMs, ranking.

### Non-Functional Requirements

1. **Scale**: ~500M DAU, ~100M posts per day, read-heavy.
2. **Latency**: feed loads in under 500ms end-to-end; media starts rendering near-instantly on good networks.
3. **Media limits**: photos up to ~8MB, videos up to ~4GB.
4. **Availability > strong consistency**: a few seconds of staleness (a freshly-posted photo appearing late in a follower's feed) is acceptable.
5. **Durability**: uploaded media must never be silently lost.

---

## 🧒 Layman's Explanation

Imagine a **yearbook of your friends' photos that updates every minute** as everyone keeps adding new pictures. Instead of waiting until June for the printed copy, every time you flip it open, the latest snapshots from the people you care about have already been pasted in. That is what your Instagram feed is — a living yearbook, assembled fresh each time you pull down to refresh.

Or picture a **magic refrigerator door** that auto-organizes photos by who took them and when. You stick a photo on it, and tiny invisible hands sort it onto the right shelves for everyone you've shared it with, newest at the top. You never have to file anything yourself.

Or think of a **photo album shop with infinite albums on infinite shelves**. There is a conveyor belt running through the shop, arranged in chronological order, that grabs only the albums belonging to people you follow and shows them to you in the order they were posted.

Behind the scenes, four little machines do the work. The first is the **photo upload pipeline** — when you tap "share," your photo flies straight into a giant warehouse called S3, then a workshop resizes it into thumbnail, medium, and large copies and stamps them onto a worldwide delivery network (the CDN) so anyone, anywhere, gets the right size fast. The second is the **feed assembler**, which gathers recent posts from everyone you follow.

There are two ways the assembler can work. For most people, the system uses **push** — the moment you post, it stuffs a copy of your post into each follower's mailbox so opening the app is just "read my mailbox." But pushing to a celebrity's 100 million followers would melt the mailroom, so for famous accounts the system uses **pull** — your feed grabs their posts on the fly when you open the app, mixing them with your already-stuffed mailbox. Normal users get push, celebrities get pull.

A third machine handles **stories**, the 24-hour ephemeral posts whose readers all show up in the first few hours like a flash mob, then vanish. And the fourth trick is **cursor pagination** — instead of saying "give me page 2," your phone holds a bookmark pointing to the exact post you last saw, so even as new posts pile up at the top, your scroll position stays glued in place and you never see duplicates or skips.

### When the analogy breaks down

The yearbook metaphor falls apart fast at real scale. Instagram has roughly **500 million daily active users** posting around 100M times a day — no actual yearbook, magic fridge, or album shop comes close. The feed isn't really chronological anymore: an **ML ranking model** reorders posts by predicted engagement, so the "conveyor belt" is actually a smart recommender that demotes posts you'll skip and promotes ones you'll linger on. The platform isn't just photos either — **Reels** (short-form video competing with TikTok), **live streaming**, in-app **shopping** with checkout, and **end-to-end encrypted DMs** all share the same app but have radically different storage, latency, and trust models. And the "delivery network" is a globe-spanning system of regional data centers, edge POPs, ML inference clusters, and integrity systems for spam, copyright, and safety — none of which fit on a fridge door.

---

## Core Entities

| Entity | Description |
|---|---|
| **User** | Profile with `userId`, handle, bio. |
| **Post** | Caption + metadata + reference to one or more media assets. Authored by a `userId`. |
| **Photo / Media Asset** | The binary blob plus its multiple resolution variants. Stored separately from the `Post` row because it lives in object storage, not the primary DB. |
| **Follow** | Directed edge `followerId → followeeId`. Asymmetric (unlike friendship). |
| **Like** | (Noted for completeness even though out of scope.) Edge `userId → postId`. |
| **Feed Entry** | A materialized row in a per-user timeline cache: `userId, postId, createdAt`. Exists only in the push/hybrid designs. |

---

## API Design

```
POST   /posts
  body: { caption, mediaIds: [...] }
  → { postId }

POST   /media/upload-url
  body: { contentType, sizeBytes }
  → { mediaId, uploadUrl, expiresAt }   # presigned S3 URL

PUT    /users/{id}/follow
  → 200 OK                              # idempotent

GET    /feed?pageSize=20&cursor=<opaque>
  → { posts: [...], nextCursor }
```

Media upload is a two-step flow: the client first asks the API for a presigned URL, `PUT`s bytes directly to object storage, then calls `POST /posts` referencing the returned `mediaId`. This keeps large-object bytes off the application tier.

Feed pagination is **cursor-based** using the oldest post's timestamp (or an opaque encoded cursor) so the page window stays stable as new posts arrive at the top.

---

## High-Level Design

```
  Mobile / Web Client
          │
          ▼
     API Gateway  ── AuthN/AuthZ, rate limit
          │
   ┌──────┼─────────────────────────────────────┐
   ▼      ▼            ▼            ▼           ▼
 Post    User/        Feed       Media       Follow
 Svc     Profile      Svc        Svc         Svc
   │       │            │          │           │
   │       │            │          │           │
   ▼       ▼            ▼          ▼           ▼
 Posts   Users        Feed       Object      Graph
  DB      DB          Cache     Storage       DB
                    (Redis)      (S3)    (sharded by user)
                                  │
                                  ▼
                            Encoding Pipeline
                            (resolution variants,
                             transcoding)
                                  │
                                  ▼
                                 CDN
                              (edge POPs)
```

Key ideas:
- **Object storage (S3/equivalent)** holds the large binary media. The Posts DB only stores small metadata (caption, `mediaId`, `authorId`, `createdAt`).
- An **encoding pipeline** (triggered by S3 object-created events onto a queue) derives multiple resolution variants per photo and multiple bitrates/segments per video. Outputs are written back to S3.
- A **CDN** fronts S3 so that reads hit edge POPs close to the user.
- The **Feed Service** is the hot path: it assembles a user's timeline either by pulling followees' recent posts on demand, or by reading a precomputed per-user feed list.

---

## Deep Dives

### 1. Photo Upload, Processing and CDN Delivery

**Flow:**
1. Client calls `POST /media/upload-url` with content type and size. The Media Service generates a `mediaId`, builds an S3 object key like `media/{userId}/{mediaId}/original.jpg`, and returns a short-lived presigned `PUT` URL.
2. Client uploads the bytes directly to S3. The app tier never sees the file body, which saves bandwidth and keeps request sizes small.
3. S3 emits an `ObjectCreated` event onto a queue (SQS / Kafka).
4. A pool of **encoding workers** consumes the event and produces variants:
   - Photos: thumbnail (150px), small (320px), medium (640px), large (1080px). EXIF metadata (GPS coordinates, device serial numbers, shooting timestamps) is stripped before re-encoding — this is both a privacy requirement and a correctness one, since EXIF data can expose sensitive user information the uploader never intended to share publicly. Variants are re-encoded as WebP/JPEG.
   - Videos: HLS segments at 480p / 720p / 1080p, plus a poster frame. To reduce perceived processing delay, the first 10 seconds of video are encoded synchronously at the lowest bitrate (~1–2s of encoding time), emitting a `partial_ready` status so the client can begin streaming immediately. Full-ladder encoding for all bitrates continues asynchronously in the background.
5. Variants are written back under **deterministic S3 keys** (e.g. `media/{userId}/{mediaId}/1080.webp`). Deterministic naming is essential for CDN cache predictability: a CDN edge node can cache a variant indefinitely by URL, and there is no cache-invalidation thundering herd if the same key is re-requested. The `media` row is updated to `status=ready`.
6. The client then calls `POST /posts` with `mediaIds`. The Post Service refuses to accept media not in `ready` state, or writes the post but hides it until ready.

**Delivery:** reads go through the CDN (CloudFront / Akamai). The CDN caches each variant at edge POPs keyed by object URL. URLs are versioned so that replacing a variant invalidates cleanly. The client picks a variant based on device pixel density and viewport — critically, the original upload bytes are **never served to end users**. Serving the original would expose unstripped EXIF metadata and impose 8–20 MB payloads on mobile clients; all user-facing traffic flows through CDN-cached derived variants only.

**Why this design:**
- Direct-to-S3 uploads shield the API tier from 8MB+ bodies.
- Async encoding decouples upload latency from transcode cost.
- EXIF stripping at encode time is a privacy and safety control, not optional.
- The first-10-seconds synchronous encoding trick eliminates the "processing" spinner users see on video posts, dramatically improving perceived upload quality.
- Multi-resolution variants let mobile clients on slow networks get a small image quickly, then progressively load higher resolutions.
- CDN keeps origin read load bounded even when a post goes viral.

### 2. Feed Generation: Pull vs Push vs Hybrid

**Naive pull (fan-out on read):**
When a user opens the app, query "give me the last N posts from every user I follow, merge sorted by `createdAt`". This is simple and writes are cheap, but a user who follows 500 accounts triggers a scatter-gather over 500 shards on every feed load. Feed latency blows past the 500ms budget.

**Push (fan-out on write):**
When a user posts, enqueue a fan-out job. For each follower, prepend `(postId, createdAt)` to a per-follower Redis list (`feed:{userId}`). Feed reads become a single `LRANGE`. Latency is excellent. The catch: a celebrity with 100M followers generates 100M writes per post, which is infeasible and creates thundering-herd write storms.

**Hybrid (the production answer):**
- Normal users (under some follower threshold) use **push**. Their posts are fanned out to each follower's precomputed feed list. The threshold itself is **not a fixed constant** — it is a dynamic, per-account value computed from measured write amplification and queue depth. During viral events an account can grow from 5K to 500K followers in hours; the routing flag must update automatically without manual ops intervention. If fan-out workers are overloaded, raising the threshold temporarily reduces write pressure; the system monitors that feedback loop continuously.
- Celebrities / high-fan-out accounts use **pull**. Their posts are *not* fanned out. Instead, at feed-read time, the Feed Service:
  1. Reads the precomputed list (captures posts from normal followees).
  2. Separately queries recent posts from the user's celebrity followees (a small set — typically dozens, not millions).
  3. Merges the two lists in memory, sorts, returns.

This bounds the worst case on both sides: write amplification is capped by the threshold, and read amplification is capped by how many celebrities any one user follows. The feed list is cached in Redis with a bounded length (e.g. latest 1000 entries) and backed by durable storage for rebuilds.

**Edge cases:**
- New follow: backfill the follower's precomputed feed with the followee's recent posts.
- **Unfollow:** do *not* attempt to synchronously remove entries from the Redis feed list — scanning a 1,000-entry list for all posts by `authorId` is O(N) and adds latency to what users expect to be an instant action. Instead, filter at read time: when assembling a feed page, check whether each entry's `authorId` is still in the user's follow set; silently skip entries from unfollowed accounts. A periodic background reconciliation job rebuilds stale feed lists to remove accumulated dead entries.
- **Celebrity pagination:** when the hybrid feed merges the precomputed list with a live celebrity query, the celebrity query window must be snapped at page 0. If the celebrity query is re-run on every paginated request, new posts will inject into the middle of the feed mid-scroll, breaking the user's reading context. On the first page request, record the upper-bound timestamp and encode it in the cursor; subsequent pages pass that timestamp as a `before=` parameter so the celebrity window stays frozen for the duration of the scroll session.
- Celebrity demoted / user gains followers past the threshold: migrate them at a quiet time and update their routing flag.

### 3. Stories and 24-Hour Ephemeral Storage

Stories are short-lived media that expire 24 hours after posting. They have very different access patterns from feed posts:
- Extremely write-heavy relative to reads (most stories get few views).
- Reads are bursty: a story's viewers mostly show up in the first few hours.
- Each story has a hard TTL.

**Storage model:**
- Story media itself lives in the same S3 pipeline as posts — same encoding workers, same CDN. The only difference is an `expiresAt` tag on the object, and an **S3 lifecycle policy** on the bucket that physically deletes objects 25+ hours after creation. Physical deletion is handled entirely by the lifecycle policy — the application layer does not need to issue delete calls per-expiry.
- Story metadata lives in a separate table `stories(userId, storyId, mediaId, createdAt, expiresAt)` with a TTL index (DynamoDB TTL or a sweeper job on a SQL table).
- The **active stories index** is a per-user Redis sorted set `stories:{userId}` scored by `createdAt`. On read, `ZRANGEBYSCORE` with `min = now - 86400` returns only live stories. Entries are **not eagerly deleted from the sorted set on expiry** — eager deletion adds write pressure at exactly the moment (24h after posting) that is least predictable and would create write spikes. Instead, the system relies on lazy read-time filtering via `ZRANGEBYSCORE` plus a background sweeper that removes entries older than 25h, aligned with the S3 lifecycle window.

**Read path:** "whose stories should I see?" pulls the list of followees, fans out reads to each `stories:{userId}` sorted set, filters to those with any entry newer than 24h, and returns the tray. Because stories are scoped to followees and bounded to the last 24h, the working set is small enough to cache aggressively.

**Why stories are deliberately not fanned out:** write fan-out cost would completely dominate read cost here. Stories are discovered by walking the followee list on open because the set of live stories is tiny (hours of content, not years), bounded to the last 24h, and per-followee lookups are cheap sorted-set reads. Fan-out would require writing to every follower's timeline on every story post — for a user with millions of followers, this is the same infeasible write amplification as the celebrity feed problem, but for content that expires in 24h. The read path is cheap enough that the savings never justify the write cost.

### 4. Consistent Feed Rendering and Pagination

Naive pagination (`LIMIT 20 OFFSET N`) breaks as new posts arrive at the top: items shift down, a user scrolls, and they see duplicates or skips. Instagram-style feeds use **cursor-based pagination**:

- The server returns a `nextCursor` that encodes the composite `(createdAt, postId)` of the oldest item on the page. Using both fields matters: `createdAt` alone is not unique (two posts can share the same millisecond timestamp), so `postId` serves as a tiebreaker to make the cursor fully deterministic.
- Subsequent requests pass that cursor; the server applies `WHERE (created_at, post_id) < (:cursor_ts, :cursor_id)` to return items strictly older than the cursor, using the same composite ordering.
- New posts arriving at the top don't disturb already-paginated pages.

**Consistency within a session:** when the feed is assembled from a Redis precomputed list plus a live celebrity query, the celebrity query window is snapped to the first-page cursor's upper bound (a timestamp encoded in the cursor). All subsequent pages pass that timestamp as a `before=` constraint to the celebrity query, so no new celebrity posts inject into the middle of an ongoing scroll session. The cursor is opaque to the client — it is base64-encoded JSON containing `{ "ts": <epoch_ms>, "postId": "<id>", "celeb_before": <epoch_ms> }`.

**Read-your-writes:** if a user just posted, they expect to see it on their own profile immediately. Profile reads go straight to the Posts DB (the write primary or a synchronous replica), not the feed cache, which gives strong consistency for the self-view. The Posts DB is the source of truth; the feed cache is an eventually-consistent derived view. For the feed of their followers, the slight fan-out delay (seconds) is acceptable and within the stated NFR of eventual consistency.

---

## Scaling Journey: 0 → ∞

This section is an original walkthrough of how an Instagram-shaped system is realistically built up as the user base grows. The key tension throughout is the dual axis: **media bytes** (storage and bandwidth) and **feed reads** (latency under fan-out).

### Stage 1: 0 – 100 Users

**Goal:** ship a working prototype. Prove people will upload photos and scroll a feed.

**Architecture:**
- Single monolithic app server (Node/Rails/Django).
- One Postgres instance holding `users`, `follows`, `posts` with a `media_url` column.
- Media uploaded through the app server to local disk or a single S3 bucket.
- Feed is a single SQL query: `SELECT * FROM posts WHERE author_id IN (SELECT followee_id FROM follows WHERE follower_id = :me) ORDER BY created_at DESC LIMIT 20`.
- No CDN, no encoding pipeline, just serve `original.jpg` directly.

**What you skip:** caching, sharding, async jobs, variants, metrics beyond basic logs.

**Failure mode → next stage:** as photos accumulate, the app server bandwidth becomes the bottleneck. Uploading a single 8MB photo over slow networks blocks a worker for seconds, starving other requests.

### Stage 2: 100 – 1,000 Users

**Goal:** get the app server out of the media path, and handle mobile clients on weak networks.

**Architecture:**
- Move media to **S3 with presigned uploads**: client `PUT`s directly to S3, app server only handles metadata.
- Put a CDN (CloudFront) in front of the media bucket. Even at this scale the edge-cache hit rate is meaningful because each photo is viewed by many followers.
- Introduce a minimal **async encoding worker** (one process, one queue) that generates a thumbnail + a 1080px variant on upload. S3 event → SQS → worker.
- Still one Postgres instance, still the pull-based feed SQL.

**What you skip:** multi-resolution video, feed precomputation, Redis.

**Failure mode → next stage:** the feed SQL starts to be the slow query. Users who follow more accounts see feed loads creeping past 300ms. The `posts` table grows fast enough that `ORDER BY created_at DESC LIMIT 20` with a join on `follows` needs a better plan.

### Stage 3: 1K – 100K Users

**Goal:** sub-500ms feeds, and a media pipeline that handles videos properly.

**Architecture:**
- Split the monolith into **Post Service**, **User/Follow Service**, **Media Service**, **Feed Service**. They share Postgres but own distinct tables.
- Add **Redis** in front of feed reads. On first load, fall back to SQL and cache the result by `(userId, cursor)` with a short TTL.
- Introduce a **per-user precomputed feed** (push fan-out) for users with < 10K followers. When someone posts, enqueue fan-out; each follower's `feed:{userId}` Redis list gets the new `postId` prepended. Celebrity handling is deferred.
- Encoding pipeline gains **full resolution ladder** for photos (150 / 320 / 640 / 1080) and basic HLS ladder for videos (480p / 720p / 1080p) using a worker pool.
- Client chooses variants based on viewport and network.

**What you skip:** hybrid celebrity handling, cross-region replication, stories.

**Failure mode → next stage:** a user with a million followers signs up and posts. Fan-out jobs flood the queue, Redis lists balloon, and normal users' feed writes back up behind the celebrity's. Meanwhile Postgres is now hot on the write side from the post firehose.

### Stage 4: 100K – 10M Users

**Goal:** handle the follower-count long tail, and stop treating posts as a single-DB problem.

**Architecture:**
- Implement the **hybrid feed** described in the deep dive. Users above a follower threshold are flagged as `high_fanout = true`; their posts are not fanned out on write. Feed reads merge precomputed list + live query across the user's high-fanout followees.
- **Shard the Posts DB by `authorId`** (consistent hashing). Writes scale horizontally; reads for a single author stay on one shard.
- **Shard the Follow graph** by `followerId` so "who do I follow" lookups stay local.
- Redis feed cache becomes a **Redis cluster**, sharded by `userId`.
- Add **multi-region CDN** for media; origin is still a single S3 region but edge POPs handle 90%+ of read bytes.
- Introduce **stories**: the separate pipeline from Deep Dive 3 with TTL-tagged S3 objects and per-user active-stories sorted sets.
- Add a **metrics and tracing stack** — feed p99 is now a board-level metric.

**What you skip:** global writes in multiple regions, ML ranking, dedicated video origin.

**Failure mode → next stage:** CDN egress and S3 storage costs explode. A single region's S3 becomes a write bottleneck during peak hours. Celebrity posts still cause read hot spots because their posts rows get slammed. Encoding workers can't keep up with the video backlog.

### Stage 5: 10M+ Users

**Goal:** operate at Instagram scale — 500M DAU, 100M posts/day, global presence.

**Architecture:**
- **Multi-region active-active** for metadata: Posts DB and Follow graph replicated across regions, with region-local writes and async cross-region replication. Feed cache is region-local (each region has its own Redis cluster, populated by region-local fan-out).
- **Geo-partitioned object storage**: media uploaded in region X lives in region X's bucket primarily, with lazy cross-region replication for global viewers. CDN routes origin pulls to the nearest origin.
- **Tiered storage for media**: hot bytes (recent posts) on SSD-backed S3 standard, cold bytes (years-old posts) moved to S3 IA or Glacier with CDN long-TTL caching to hide the retrieval latency.
- **Dedicated video pipeline** separate from photo encoding, with per-codec / per-bitrate parallelism and a priority queue so stories and live content jump ahead of batch re-encodes.
- **Celebrity-aware read path**: celebrity posts get their own hot-key cache tier (in-process on the Feed Service plus Redis), so a viral post is served from memory on every feed node.
- **Write-path sharding for fan-out workers** by `authorId` so that a single celebrity's fan-out doesn't starve others.
- Stories and feed share pipelines and CDN but have independent capacity planning: stories are bursty, feeds are steady-state.
- Heavy investment in **chaos testing, capacity autoscaling, and per-region failover** — the system must survive losing a whole region.

**What you skip (deliberately):** nothing architectural; from here the work is in ML ranking, integrity systems, cost optimization, and ad delivery — all of which are separate design problems.

**Failure modes at this scale** are no longer architectural; they're operational: hot-key storms, cross-region replication lag during network events, CDN origin shield failures. The architecture is stable; the game becomes observability and capacity.

---

## Insider Tips and Tricks

### Never Serve the Original Upload Bytes to End Users

Raw uploads contain EXIF metadata — GPS coordinates, device serial numbers, shooting timestamps — that users don't expect to expose publicly. Beyond privacy, a raw 12MP JPEG from a modern phone is 8–20 MB, which creates unacceptable load times on mobile. Always serve a derived variant (EXIF-stripped, re-encoded, sized for the viewport). The original upload lives in cold storage only for DRM and DMCA takedown workflows.

### The Celebrity Threshold Is a Continuously Tuned Knob, Not a Fixed Number

The fan-out-on-write vs. fan-out-on-read threshold (e.g., "10K followers") is not a single constant. It should be dynamic, computed per-account based on measured write amplification and queue depth. During viral events, an account can grow from 5K to 500K followers in hours — you need the routing flag to update without manual ops. Similarly, if your fan-out workers are overloaded, raising the threshold temporarily reduces write pressure; monitoring that feedback loop is part of operating the system at scale.

### Feed List Bounded Size Means You Must Handle Cache Rebuilds

Each user's precomputed Redis feed list is capped (e.g., 1,000 entries). If a user is inactive for months and their list expires or is evicted, their first feed request triggers a cold rebuild: query all followees' recent posts, merge-sort by timestamp, populate Redis. For a user following 2,000 accounts this can be 2,000 DB queries or a large fan-out read — enough to spike DB latency. The production pattern is asynchronous pre-warming: detect the stale list during the request, return the freshly built feed, and asynchronously repopulate Redis before the user scrolls to the second page.

### Cursor Pagination Must Snap the Celebrity Query Window at Page 0

The hybrid feed merges a precomputed list (for normal followees) with live queries against celebrity accounts. If the celebrity query is re-run on every paginated request, new posts from celebrities will keep injecting into the middle of the feed mid-scroll — breaking the user's reading context. On the first page request, snapshot the celebrity query's upper bound (a timestamp) and encode it in the cursor. Subsequent pages pass that timestamp to the celebrity query as a `before=` parameter, so the celebrity window stays frozen for the duration of that scroll session.

### Unfollow Doesn't Clean Up Feed Entries Synchronously

When a user unfollows someone, their precomputed Redis feed list still contains that person's posts. Removing them synchronously on unfollow would require scanning the entire list for entries by `authorId`, which is O(N). Instead, filter at read time: when assembling the feed page, check if the `authorId` for each `postId` is still in the follower's follow set. If not, skip the entry. Periodically run a background reconciliation job that rebuilds the feed list to remove stale entries.

### Video HLS Segmenting Strategy Affects Startup Latency

For video, the first few HLS segments need to be available before the client can start playback. If encoding is fully asynchronous, there's a window where the post exists but the video cannot play. The production trick: encode just the first 10 seconds at the lowest bitrate synchronously (fast, ~1–2s), emit a `partial_ready` status, and let the client start streaming immediately. Full-ladder encoding continues in the background. This dramatically reduces the perceived "processing" delay for video uploads.

### Stories Sorted Set Must Filter on Read, Not on Write

A user's active stories are stored in a Redis sorted set `stories:{userId}` scored by `createdAt`. On read, `ZRANGEBYSCORE` with `min = now - 86400` returns only live stories. Do not delete entries from the sorted set on expiry eagerly — it adds write load at the exact time (24h after posting) that is least predictable. Instead, rely on lazy read-time filtering plus a periodic background sweeper that removes entries older than 25h. The S3 lifecycle policy handles physical object deletion independently.

### Perceptual Hashing Catches Re-Uploaded Content That Byte-Hashing Misses

A simple SHA-256 of the media bytes will not catch a re-upload of the same photo that has been slightly cropped, had a filter applied, or was re-saved at a different JPEG quality. Perceptual hashing (pHash or dHash) generates a fingerprint based on the visual content — two near-duplicate images produce hashes with a Hamming distance under a threshold (typically < 10 bits for strong similarity). Instagram uses perceptual hashing for copyright enforcement and to prevent ban evasion by reuploading removed content with minor edits.

---

## Expected Depth by Level

| Area | Mid-Level (IC4) | Senior (IC5) | Staff (IC6+) |
|---|---|---|---|
| **Requirements** | States functional requirements clearly, picks a reasonable scale number. | Derives storage and bandwidth math from DAU and post volume; names the read/write ratio. | Pushes back on scope, frames the media + feed duality as the core tension, calls out failure domains early. |
| **Core entities & API** | Correct entities, cursor-based pagination. | Two-phase media upload with presigned URLs; separate `media` and `post` lifecycle. | Discusses API contracts for partial failure (post created but media not ready), idempotency for follow/post, versioned media URLs. |
| **Media pipeline** | S3 + CDN, single resolution. | Async encoding worker, multi-resolution variants, client-driven variant selection. | End-to-end pipeline ownership: queue backpressure, encoding priority tiers, cross-region replication, cost per GB per tier. |
| **Feed generation** | Knows pull vs push at a high level, picks one. | Implements hybrid with a follower threshold, explains Redis list structure and fan-out worker design. | Handles migration of users across the threshold, bounded cache size with warm rebuild, celebrity hot-key mitigation, read-your-writes consistency model. |
| **Stories** | Mentions TTL. | Separate storage path, per-user active-stories sorted set, S3 lifecycle for physical deletion. | Distinguishes story access pattern from feed, justifies why stories are *not* fanned out, reasons about the bursty read curve. |
| **Scaling** | Handwaves "we'd shard it." | Picks shard keys (authorId for posts, followerId for follows), sizes Redis. | Describes a realistic 0 → hyperscale evolution with explicit triggers, trade-offs, and what is deliberately deferred at each stage. |
| **Operations** | — | Mentions metrics, p99 latency. | Capacity planning, regional failover, chaos testing, cost model, on-call ergonomics. |
