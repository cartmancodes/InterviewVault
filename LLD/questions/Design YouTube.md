# Design YouTube

> **Pattern**: Video Storage / Streaming
> **Difficulty**: Hard
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/youtube)

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Resumable Chunked Upload](#1-resumable-chunked-upload)
   - [2. Transcoding DAG](#2-transcoding-dag)
   - [3. Adaptive Bitrate Streaming (HLS/DASH)](#3-adaptive-bitrate-streaming-hlsdash)
   - [4. CDN Distribution and Cache Hierarchy](#4-cdn-distribution-and-cache-hierarchy)
   - [5. Storage Tiering (Hot / Warm / Cold)](#5-storage-tiering-hot--warm--cold)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

YouTube is the canonical large-blob streaming system. The design exercise focuses on two core user flows: uploading a video (which can be tens of GBs) and watching one (which must start fast and play smoothly across devices with varying bandwidth).

### Functional Requirements

**In scope**
- A user can upload a video from a client device. Uploads must survive network interruption (resumable).
- A user can watch a video. Playback should start quickly and adapt to the viewer's available bandwidth.
- A user can retrieve video metadata (title, description, thumbnail, duration, available formats).

**Out of scope (declared up front)**
- View counts, watch analytics, trending feeds.
- Search, comments, likes, subscriptions.
- Recommendations, monetization, ads.
- Moderation and copyright detection.

### Non-Functional Requirements

- **Scale**: roughly 1M uploads/day and 100M watch sessions/day. Catalog grows by ~365M videos/year.
- **File sizes**: individual source files can reach tens of GB (4K, long form).
- **Availability over consistency**: a few seconds of staleness on metadata is fine; a broken playback is not. Target 99.99% availability on the watch path.
- **Latency**: time-to-first-frame under ~2 seconds on broadband, graceful degradation on mobile.
- **Global reach**: viewers sit in every region and on every class of network, so streaming must work over long-haul links with packet loss.
- **Durability**: source files and transcoded variants must never be lost (11 nines of durability on blob storage).

---

## Core Entities

| Entity | Purpose | Notes |
|---|---|---|
| `User` | Uploader or viewer identity | Auth concerns only touched at the edges |
| `Video` | Logical handle for a piece of content | Has an immutable `videoId` |
| `VideoMetadata` | Title, description, uploader, duration, status, manifest URL, transcript URL | The row that clients fetch before playback |
| `VideoSegment` | A few-second slice of encoded video | Stored as blobs in object storage, referenced by the manifest |
| `UploadSession` | Tracks chunk list, ETags, and per-chunk status for a resumable upload | Allows the client to resume where it left off |
| `WatchSession` (optional) | Per-user resume position | Needed only if "continue watching" is in scope |

---

## API Design

Keep the surface small. The heavy bytes never flow through the application servers.

```
POST /videos/upload-init
  body: { title, description, fileHash, totalBytes, chunks: [{ index, size, hash }] }
  returns: { videoId, uploadSessionId, presignedUrls: [{ index, url }] }

PATCH /videos/{videoId}/upload-status
  body: { chunkIndex, etag, status }
  // Called by the client after each successful chunk PUT to S3

POST /videos/{videoId}/complete
  // Finalizes the multipart upload and kicks off transcoding

GET  /videos/{videoId}
  returns: VideoMetadata {
    videoId, title, description, duration, status,
    manifestUrl,        // master manifest (HLS .m3u8 or DASH .mpd)
    thumbnailUrl,
    transcriptUrl
  }
```

Authentication rides on a bearer token in the `Authorization` header. The presigned URLs are short-lived (minutes) and scoped to a single object key and HTTP method.

---

## High-Level Design

```
  Client                                              
    |                                                 
    |-- upload-init -------------------->  Video API  -->  Metadata DB (Cassandra)
    |                                          |           partitioned by videoId
    |-- PUT chunks (presigned) ----->  Object Storage (S3)
    |                                          |
    |                                          v
    |                                 S3 ObjectCreated event
    |                                          |
    |                                          v
    |                                 Transcoding Orchestrator (Temporal)
    |                                          |
    |                             +------------+------------+
    |                             v            v            v
    |                         Segmenter   Transcoder    Packager
    |                         (workers on GPU/CPU fleet, exchanging blobs via S3)
    |                                          |
    |                                          v
    |                                 S3: variants + manifests
    |
    |-- GET /videos/{id} -------------->  Video API  -->  Metadata DB + Cache
    |                                          |
    |-- GET manifest --------------------->  CDN edge  -->  S3 origin
    |-- GET segments --------------------->  CDN edge  -->  S3 origin
```

- **Video API**: stateless HTTP service. Issues presigned URLs, writes metadata rows, reads them back for playback. Horizontally scaled behind a load balancer.
- **Object storage (S3 or GCS)**: the source of truth for every byte of video. Multipart upload on the write path; range requests on the read path.
- **Metadata DB (Cassandra)**: partitioned by `videoId` for uniform load. Leaderless writes, tunable consistency, good match for an availability-first workload.
- **Transcoding orchestrator**: a DAG engine (Temporal, Airflow, or a bespoke queue-based system) that fans segmentation and transcoding jobs across a worker pool.
- **CDN**: holds manifests and segments at edge POPs so bytes travel the last mile instead of across an ocean.
- **Metadata cache**: Redis in front of Cassandra for the long tail of popular videos.

---

## Deep Dives

### 1. Resumable Chunked Upload

A 20 GB upload over a flaky hotel Wi-Fi will fail. The design must assume that.

- Client splits the file into ~5-10 MB chunks and computes a content hash per chunk.
- `upload-init` creates a `VideoMetadata` row in status `UPLOADING` plus an `UploadSession` listing every chunk and its intended S3 part number. The API returns presigned PUT URLs for each part.
- Client uploads parts directly to S3 (bypassing the API server so we do not pay egress through our compute tier). S3 returns an ETag per part; the client reports each successful ETag back via `PATCH /upload-status`.
- If the client drops and reconnects, it re-fetches `UploadSession` and only replays the chunks that are missing an ETag.
- When all parts are acknowledged, the client calls `complete`, which issues `CompleteMultipartUpload` to S3. S3 then fires an `ObjectCreated` event that triggers the transcoding pipeline.
- Integrity: the per-chunk hash lets the server reject a corrupted part without invalidating the whole upload.

### 2. Transcoding DAG

The pipeline is a directed acyclic graph, not a linear queue. This matters because transcoding is the dominant cost and the steps have clean parallelism boundaries.

**Stages**
1. **Probe** the source (duration, codec, resolution, audio streams).
2. **Segment** the source into small chunks of a few seconds each. Segment boundaries align with GOP (group-of-pictures) boundaries so that each segment decodes independently.
3. **Transcode** each segment into a matrix of (codec x container x resolution x bitrate) variants. Common ladder: 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p, encoded with H.264 for broad compatibility plus VP9/AV1 for better compression on capable clients.
4. **Audio**: separate track processed once and referenced by every video variant.
5. **Package**: emit media manifests (one per variant) and a master manifest that lists them.
6. **Auxiliary**: generate thumbnails at fixed offsets, run speech-to-text for captions.

**Why a DAG helps**
- Segments are independent, so step 3 fans out across hundreds of workers with no cross-talk.
- Workers never ship bytes to each other directly; they read and write through S3 using signed URLs. Orchestration stays lightweight.
- A failed segment retries on its own without restarting the whole video.
- Priority lanes: small videos from known creators jump ahead of 12-hour uploads.

### 3. Adaptive Bitrate Streaming (HLS/DASH)

The goal is to never stall. The system ships many variants and lets the client pick.

- **Master manifest** (`.m3u8` for HLS, `.mpd` for DASH) lists every variant with its codec, resolution, and bitrate.
- **Media manifest** for each variant lists the URLs of its segments in order.
- **Client ABR loop**:
  1. Start at a conservative variant (often 480p) for fast time-to-first-frame.
  2. Measure download time of each segment to estimate throughput.
  3. If throughput sustains above the next rung's bitrate with a safety margin, step up.
  4. If the buffer drops below a threshold, step down aggressively.
- **Segment length tradeoff**: 2-4 second segments give fast adaptation but more manifest overhead; 6-10 second segments give better compression but slower reaction to bandwidth drops.
- **Low-latency variants** (LL-HLS, CMAF chunks) cut glass-to-glass latency for near-live content from ~30s down to ~3-5s.

### 4. CDN Distribution and Cache Hierarchy

Object storage alone cannot serve 100M plays a day at acceptable latency. The CDN is a mandatory layer.

- **Edge POPs** terminate TLS close to the viewer and cache segments keyed by URL. Segment URLs include the variant and segment index, so caches are content-addressed.
- **Origin shield**: a mid-tier cache layer between edge POPs and S3. Without it, a cold-cache request for a popular video at every POP would stampede the origin. The shield collapses these into a single origin fetch.
- **Cache keys and TTLs**: segments and manifests are immutable once written, so TTLs can be long. Invalidation is by versioned URL rather than purge.
- **Tiered caching**: L1 = POP, L2 = regional shield, L3 = origin (S3). Most bytes are served from L1. A single-digit percent miss rate at L1 becomes trivial traffic at origin.
- **Manifest caching**: shorter TTL than segments because future edits to the variant ladder must propagate.
- **Pre-warming**: for scheduled premieres, push segments to every POP ahead of release.

### 5. Storage Tiering (Hot / Warm / Cold)

Not every variant of every video deserves premium storage. Access patterns follow a power law: a tiny fraction of the catalog drives the bulk of views, and the rest tails off sharply after the first few days.

- **Hot (edge/CDN + S3 Standard)**: new uploads, viral content, anything trending. Lowest latency, highest cost per GB.
- **Warm (S3 Standard-IA or equivalent)**: videos older than ~30 days with modest but non-trivial traffic. Cheaper per GB, slightly higher retrieval cost.
- **Cold (Glacier Instant Retrieval or similar)**: long-tail content. Retrieval in seconds, much cheaper storage. A request may pay a one-time latency cost as the variant is promoted back to warm.
- **Source file**: always retained, often in cold storage after processing is complete, so that re-encoding with a new codec (e.g., AV1 rollout) is possible without asking the uploader to re-upload.
- **Tier transitions**: driven by lifecycle policies keyed on last-access time. Promotion back to hot happens when view rate crosses a threshold.

---

## Scaling Journey: 0 to Infinity

This section is original analysis, not a rehash of the source. It walks the design through five regimes, each defined by the failure that kicks it into the next.

### Stage 1: 0-100 Users (MVP)

**Goal**: prove that someone can upload an mp4 and someone else can play it back.

**Architecture**
- Single region, single app server (Node or Go) behind a basic load balancer.
- Videos uploaded straight to the server's local disk or a single S3 bucket.
- One encoding format: H.264 mp4 at 720p. No transcoding pipeline.
- Playback is a direct `GET` of the mp4 with HTTP range requests, so the browser can seek.
- Metadata in Postgres. Two tables: `users`, `videos`.

**What you skip**
- Transcoding, adaptive bitrate, manifests, CDN, resumable uploads, caching.
- Multiple resolutions. If the user has a bad connection, they wait.

**Failure mode that pushes to next stage**
- A 4 GB upload over a hotel connection fails at 80% and the user has to restart. App server memory balloons when multiple users upload concurrently. First complaint lands: "the video keeps buffering on my phone."

### Stage 2: 100-1,000 Users

**Goal**: stop losing uploads and stop pinning the app server to 100% CPU on video I/O.

**Architecture**
- Switch uploads to presigned S3 multipart with ~8 MB chunks. The app server only issues URLs and stores chunk state in an `upload_sessions` table.
- Add a single background worker that runs `ffmpeg` to produce two extra renditions (360p and 1080p) so mobile and desktop users each get something reasonable.
- Store the three mp4 variants in S3. Playback URL points to whichever variant the client requested from a dropdown.
- Put a CDN in front of the S3 bucket (CloudFront or Cloudflare) so popular videos do not repeatedly hit origin.
- Move metadata reads through a small Redis cache.

**What you skip**
- True adaptive bitrate. The viewer picks the rendition manually.
- DAG orchestration. One worker, one queue, good enough.
- Multi-region anything.

**Failure mode**
- Transcoding queue backs up during upload spikes because a single worker cannot keep up with more than a handful of concurrent 1080p jobs. Users in Europe and Asia complain that playback from a US-only bucket is slow even with a CDN because the cache is cold for their region.

### Stage 3: 1K-100K Users

**Goal**: automate transcoding into a real pipeline and make playback adapt to bandwidth.

**Architecture**
- Introduce a proper transcoding service: SQS (or Kafka) as the work queue, an auto-scaled fleet of ffmpeg workers on spot instances. Orchestration via Temporal so retries and failures are first-class.
- Segment source files into ~4-second chunks and transcode each chunk in parallel. The DAG from the deep dive lives here.
- Emit HLS manifests and segments. The client switches from "choose a resolution" to ABR, automatically picking from a ladder of 360p/480p/720p/1080p.
- CDN now caches both manifests and segments. Cache keys are content-addressed and long-TTL.
- Metadata DB migrates from Postgres to Cassandra once row counts cross ~100M, partitioned by `videoId`.
- Metadata cache (Redis) sits in front of Cassandra.

**What you skip**
- AV1/VP9 encodings. Still H.264 only, because the encoder cost does not yet pay off.
- Origin shielding. A single regional origin behind the CDN is still fine.
- Cold storage tiering. Everything lives in S3 Standard.

**Failure mode**
- A viral video makes every POP simultaneously miss its cache and slam the single origin bucket. Transcoding costs explode because every new upload runs H.264 at six resolutions. Staff in three regions complain that Cassandra tail latency spikes whenever a single partition goes hot.

### Stage 4: 100K-10M Users

**Goal**: absorb viral spikes, cut bandwidth cost, and serve every region with local-POP latency.

**Architecture**
- **Origin shielding**: a regional mid-tier cache sits between edge POPs and S3. A viral miss stampede collapses into one origin fetch per shield, not one per POP.
- **Multi-region object storage**: cross-region replication for the top percentile of videos so that a POP in Sao Paulo fetches from a regional origin, not from us-east-1.
- **Codec ladder expansion**: add VP9 and begin rolling out AV1 for capable clients. Trade extra encode cost (often 10-20x slower for AV1) for a 30-50% bitrate reduction, which pays for itself many times over in CDN egress.
- **Storage tiering**: lifecycle policy moves videos older than 30 days to Standard-IA, and old long-tail content to Glacier Instant Retrieval. Source masters go to deep cold storage after processing.
- **Metadata hot partitions**: per-video read cache with short TTL, and a client-side jittered retry policy to absorb cache-miss stampedes on trending content.
- **Upload pipeline optimization**: the client can begin uploading chunks while the user is still recording, and the transcoder can begin processing segments before the upload completes ("pipelined" processing). Aborted uploads leave orphan segments that a sweeper cleans up.

**What you skip**
- P2P-assisted delivery.
- Per-user personalized edge caches.
- Custom silicon for encoding.

**Failure mode**
- At tens of millions of concurrent viewers for a live premiere, even a multi-POP CDN saturates specific transit links. Encoder fleet cost becomes a top-three line item on the infra bill. Regulators in a handful of countries require data residency, which cross-region replication alone does not solve.

### Stage 5: 10M+ Users (Hyperscale)

**Goal**: match YouTube's operating envelope.

**Architecture**
- **Custom edge fleet**: run your own POPs rather than renting CDN capacity, because at this scale owning the boxes is cheaper and gives you more control over cache policy, connection coalescing, and TLS termination.
- **P2P-assisted delivery** on mobile and desktop web where viewers in the same ISP's network share segments with each other, reducing last-mile egress for premieres and live events.
- **Per-video optimal encoding**: instead of a fixed bitrate ladder, run a perceptual-quality analysis per video and pick a ladder tuned to that content's complexity (animation needs less bitrate than sports). Saves another 20-30% egress.
- **Custom transcoding silicon**: ASIC-based encoders (Google's VCU, similar) replace general-purpose CPUs and cut transcode cost by an order of magnitude.
- **Data-residency-aware placement**: videos uploaded in restricted regions pin their source and serving copies to in-region storage; metadata is partitioned along the same axis.
- **Predictive pre-positioning**: signals from the recommendation system push segments to POPs in the regions where a video is about to trend, so the first view at each POP is already warm.
- **Chaos-tested failover**: any single region can be drained in minutes; the watch path must survive the loss of a whole cloud region without visible degradation.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What the interviewer wants to see |
|---|---|---|
| Mid-Level | ~80% breadth, ~20% depth | Clean API, reasonable data model, recognizes presigned S3 uploads and segment-based playback. Can go deep on one topic when pushed. Interviewer drives the stage transitions. |
| Senior | ~60% breadth, ~40% depth | Drives the design without hand-holding. Confidently explains multipart + resumable uploads and a real transcoding pipeline. Articulates tradeoffs (e.g., segment length, codec choice, consistency vs availability). Proactively names bottlenecks and proposes mitigations. |
| Staff+ | ~40% breadth, ~60% depth | Speaks from operational experience. Picks the deep dives that matter and redirects away from ones that do not. Discusses origin shielding, codec ladders, tiered storage, and egress economics. Peer-level conversation about tradeoffs with real numbers. Minimal prompting needed. |
