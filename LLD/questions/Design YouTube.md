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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Imagine the cable TV broadcast network meets a public library. Anyone walking in can record a "show" (upload a video), and the system somehow makes that show watchable on dozens of different screens — big TVs, tiny phones, slow rural internet — while keeping millions of recordings on the shelves indefinitely. Anyone, anywhere, can walk up and request any show at any time. That's YouTube.

A better picture for what happens during upload: a massive Blockbuster Video where every aisle is also a printing press. When you drop off your tape, the store doesn't just shelve it. It duplicates your tape into 10 different sizes — 480p, 720p, 1080p, 4K — so a phone, a laptop, and a 4K TV can each pick the version that fits. That duplication step is **video transcoding**, and it's the most expensive part of the whole operation.

For playback, picture a pizza delivery network where every pizzeria mirrors the menu of every other one. When you order, the nearest pizzeria serves you — they don't bake from scratch because the pizza was already prepared in California and copied to every shop on the planet. That's the **CDN**: edge servers in Tokyo, Berlin, and São Paulo each holding cached copies so nobody has to fetch from the original kitchen.

The hard parts:

- **Upload pipeline**: a 4K video is 10GB. Pushing it through a web server is wasteful — it'd hog memory and bandwidth for hours. Instead, your client uploads directly to cloud storage (S3), and a separate system processes it asynchronously into all the variants.
- **Transcoding ladder**: one upload becomes many — different bitrates for different connection speeds. Like printing the same novel in hardcover, paperback, and large-print.
- **Adaptive bitrate streaming (HLS/DASH)**: your phone watches in 720p on WiFi, drops to 480p when you walk into a tunnel, and you don't notice. The video is sliced into 2-second chunks and each chunk can come in any quality.
- **CDN distribution**: instead of streaming from California to Tokyo, the video is cached at a Tokyo edge. Faster, cheaper, less congested.

### When the analogy breaks down

Real YouTube serves billions of hours per day, handles live streaming, runs copyright detection (Content ID) on every upload, monetizes with ads, fails over across multiple CDN providers when one degrades, and runs a recommendation engine that drives roughly 70% of all watch time. None of that fits in a Blockbuster.

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

**Why presigned URLs, not API-proxied uploads**

Routing video bytes through the API server is a critical mistake at scale. Every concurrent upload monopolizes server memory and outbound bandwidth. The correct model: the API server issues short-lived presigned PUT URLs for S3 multipart parts and then steps out of the data path entirely. Video bytes flow client → S3 directly; the API only handles lightweight metadata RPCs.

**Upload flow in detail**

- Client splits the file into ~5-10 MB chunks and computes a SHA-256 per chunk.
- `upload-init` creates a `VideoMetadata` row in status `UPLOADING` plus an `UploadSession` listing every chunk and its intended S3 part number. The API returns presigned PUT URLs for each part.
- Client uploads parts directly to S3. S3 returns an ETag per part; the client reports each successful ETag back via `PATCH /upload-status`, which persists the ETag into the `UploadSession` row.
- If the connection drops, the client re-fetches `UploadSession` on reconnect and only re-uploads the chunks missing an ETag — skipping all confirmed parts entirely.
- When all parts are acknowledged, the client calls `complete`, which issues `CompleteMultipartUpload` to S3. S3 then fires an `ObjectCreated` event consumed by the transcoding orchestrator.

**Integrity and edge cases**

- Per-chunk hashes allow the server to reject a corrupted part without invalidating the whole upload.
- Presigned URLs expire; if the client is slow, `upload-init` should batch-issue URLs and the client should refresh them rather than failing mid-upload.
- Aborted uploads leave orphan S3 parts. A daily sweeper queries `UploadSession` rows stuck in `UPLOADING` beyond a TTL and calls `AbortMultipartUpload` to reclaim storage.
- For uploads that begin while the user is still recording (e.g., a live capture), pipelining is possible: the client streams already-captured chunks to S3 while recording continues, and the transcoder can begin processing completed segments before the upload finishes.

### 2. Transcoding DAG

The pipeline is a directed acyclic graph, not a linear queue. This matters because transcoding is the dominant cost and the steps have clean parallelism boundaries.

**Why eager, not on-demand, transcoding**

On-demand transcoding — transcode when a viewer requests a specific quality — sounds efficient but collapses under load. The first viewer at 1080p waits minutes for a job to complete. With 1,000 simultaneous first viewers, 1,000 identical jobs fan out for the same video. Pre-transcode all target resolutions and codecs eagerly at upload time. A 10-minute video across five resolutions costs roughly 800 MB of storage at ~$0.02/GB/month — negligible compared to per-request CPU at scale.

**Stages**

1. **Probe** the source (duration, codec, resolution, audio streams). Reject unsupported formats early.
2. **Segment** the source into small chunks of a few seconds each. Boundaries align with GOP (group-of-pictures) boundaries so each segment decodes independently — critical for seeking and parallel encoding.
3. **Transcode** each segment into a matrix of (codec × container × resolution × bitrate) variants. Standard ladder: 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p, encoded in H.264 for broad compatibility plus VP9/AV1 for better compression on capable clients.
4. **Audio**: a separate track processed once and muxed into every video variant, avoiding redundant audio encoding.
5. **Package**: emit per-variant media manifests and a master manifest listing all variants with codec, resolution, and bitrate metadata.
6. **Auxiliary**: generate thumbnails at fixed offsets, run speech-to-text for captions, extract the first few segments for CDN pre-warming.

**Why a DAG helps**

- Segments are independent, so step 3 fans out across hundreds of workers with no cross-talk. A 30-minute video at 6 resolutions becomes ~2,160 independent tasks.
- Workers read and write through S3 via signed URLs; the orchestrator carries no video bytes. This keeps orchestration memory footprint small and makes retries cheap.
- A failed segment retries in isolation — no need to restart the whole video.
- Priority lanes: small videos from verified creators jump ahead of 12-hour uploads in the work queue.
- Temporal (or similar) handles idempotency: if a worker dies mid-job, the orchestrator re-queues the segment and the result is the same.

**Codec economics**

H.264 encoding is fast (near real-time on a modern CPU) but produces larger files. VP9 is 30-40% smaller at equivalent quality but encodes ~5× slower. AV1 shaves another 20-30% but encodes 20-50× slower, requiring GPU or ASIC acceleration to be cost-effective. At hyperscale, the CDN egress savings from AV1 dwarf the extra encode cost; at smaller scale, H.264-only is the right default.

### 3. Adaptive Bitrate Streaming (HLS/DASH)

The goal is to never stall. The system ships many variants and lets the client pick in real time.

**Protocol fundamentals**

Both HLS and DASH are adaptive bitrate (ABR) protocols that divide video into small segments (typically 2-10 seconds) served over plain HTTP. The distinction matters in practice:

- **HLS** (HTTP Live Streaming) is Apple-native and mandatory for iOS/Safari. Uses `.m3u8` manifest files.
- **DASH** (Dynamic Adaptive Streaming over HTTP) is codec-agnostic and an international standard. Uses `.mpd` manifest files. YouTube uses DASH for most clients and HLS for iOS.

The ABR quality-selection logic runs entirely in the client player, not on the server. The server is a dumb file server; all intelligence lives at the edge.

**Manifest structure**

- **Master manifest** lists every available variant with its codec, resolution, and bitrate. The client downloads this once at the start of playback.
- **Media manifest** for each variant lists segment URLs in order with their durations. For VOD, all segments are listed upfront. For live streams, the manifest is a sliding window that the client polls every segment-duration seconds.

**Client ABR loop**

1. Start at a conservative variant (often 480p) for fast time-to-first-frame — avoid the temptation to start at max quality.
2. Measure the download time of each segment to estimate current throughput.
3. If measured throughput exceeds the next rung's bitrate with a safety margin (typically 1.2-1.5×), step up.
4. If the buffer drops below a low-watermark threshold (e.g., 5 seconds), step down aggressively, skipping rungs if necessary.
5. Never let the buffer drain to zero — a stall is always worse than a quality drop.

**Segment length tradeoff**

Smaller segments (2 seconds) allow faster quality switching when bandwidth drops, at the cost of more HTTP requests and higher CDN cache-pressure. Larger segments (10 seconds) reduce request overhead but react slowly to sudden bandwidth changes. YouTube uses ~5-second segments as a balance. The manifest file lists all segment URLs; the player downloads and parses it once to bootstrap playback.

**Low-latency extensions**

LL-HLS and CMAF chunked transfer cut glass-to-glass latency for near-live content from ~30 seconds down to ~3-5 seconds by splitting each segment into sub-second "parts" that the server pushes before the full segment is complete.

### 4. CDN Distribution and Cache Hierarchy

Object storage alone cannot serve 100M plays a day at acceptable latency. The CDN is a mandatory architectural layer, not an optimization.

**Why CDN is non-negotiable**

S3 is designed for durability and moderate throughput, not for serving millions of concurrent range requests with sub-50ms TTFB globally. Without a CDN, every viewer fetches across the public internet from a single-region bucket. Latency spikes, throughput craters, and S3 request costs become punishing at scale.

**Tiered cache hierarchy**

- **L1 — Edge POPs**: terminate TLS close to the viewer; cache segments keyed by URL. Segment URLs include variant and segment index, making them content-addressed. Cache miss rates of 5-15% for the long tail, effectively 0% for popular content.
- **L2 — Origin shield**: a mid-tier cache node per geographic region sitting between all edge POPs in that region and S3. Without shielding, a cold cache event for a popular video at 100 POPs triggers 100 simultaneous origin fetches. With shielding, all 20 POPs in a region funnel through one regional shield, which fetches from S3 once. The shield absorbs the thundering herd; S3 sees one request per region per cache miss, not one per POP. This reduces origin traffic by 90%+ for popular content.
- **L3 — Origin (S3)**: the immutable source. Only the shield tier ever fetches from here for a given video.

**Cache keys, TTLs, and invalidation**

Segments and manifests are immutable once written — a segment URL for variant `1080p`, segment `0042` never changes. TTLs can therefore be very long (days to weeks). Invalidation is never needed for segments; it is handled by versioned manifest URLs when the variant ladder changes. Media manifests for live streams have short TTLs (one segment duration) because they slide forward as new segments are appended.

**Pre-warming for scheduled premieres**

For live events and scheduled releases, the transcoding pipeline proactively pushes the first few segments to CDN edge nodes ahead of the go-live time, rather than relying on the first viewer to warm the cache. This eliminates the origin stampede that occurs when millions of viewers hit play simultaneously on a cold cache.

### 5. Storage Tiering (Hot / Warm / Cold)

Not every variant of every video deserves premium storage. Access patterns follow a power law: a small fraction of the catalog drives the bulk of views, and traffic tails off sharply after the first few days.

**Why keep the original source file forever**

After transcoding to H.264/VP9/AV1 at multiple resolutions, the source might seem redundant. It is not. When a better codec is released (AV1 in 2018, future codecs in 2030), you must re-transcode the entire catalog. Without the original, you re-transcode from an already-lossy encode, compounding quality loss with each generation. Cold/archival storage costs ~$0.004/GB/month; the cost of re-uploading from users or accepting quality degradation is far higher. YouTube stores all originals in cold/archival storage indefinitely.

**Tier definitions**

- **Hot (CDN edge + S3 Standard)**: new uploads, viral content, anything trending. Lowest latency, highest cost per GB. Segment retrieval is sub-50ms at the edge.
- **Warm (S3 Standard-IA or equivalent)**: videos older than ~30 days with modest but sustained traffic. Cheaper per-GB storage; slightly higher per-retrieval cost. Suitable for the middle tier of the catalog.
- **Cold (Glacier Instant Retrieval or similar)**: long-tail content with infrequent views. Retrieval in milliseconds to seconds, much cheaper storage. A first request may pay a one-time promotion cost as the variant is warmed back to Standard.
- **Archive (Glacier Deep Archive or tape)**: source masters and variants that have seen no traffic in 180+ days. Retrieval in hours; only triggered by re-encode jobs or legal holds.

**Tier transitions**

Lifecycle policies keyed on last-access time automate demotion. Promotion back to hot happens when the view rate for a video crosses a threshold — for example, when a creator's video is featured in a trending playlist, its variants are eagerly promoted before the traffic spike arrives.

**Cost model intuition**

S3 Standard runs ~$0.023/GB/month; Glacier Deep Archive runs ~$0.00099/GB/month — a 23× difference. For a 10-minute video at five resolutions totaling 800 MB, the annual cold-storage cost is under $0.01. The CDN egress cost to serve that video once at 1080p (~800 MB transfer) is orders of magnitude larger than its storage cost, which is why codec efficiency and tiered egress pricing matter more than storage pricing at scale.

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

## Insider Tips and Tricks

### Transcode at Upload Time, Not on Demand

On-demand transcoding (transcode when a viewer requests a specific quality) sounds efficient but is disastrous: the first viewer at 1080p triggers a transcoding job that takes minutes, during which they wait. More critically, 1,000 simultaneous first viewers could trigger 1,000 transcoding jobs for the same video. Transcode all target resolutions/codecs eagerly at upload time. Storage cost (a 10-minute video × 5 resolutions ≈ 800MB) is far cheaper than per-request CPU cost.

### HLS vs DASH: Know the Difference

Both are adaptive bitrate (ABR) streaming protocols using small segments (2-10 seconds). HLS (HTTP Live Streaming) is Apple-native; required for iOS/Safari. DASH (Dynamic Adaptive Streaming over HTTP) is codec-agnostic and an international standard. YouTube uses DASH for most clients, HLS for iOS. The ABR logic (choosing quality tier based on measured bandwidth) runs in the client player, not the server — the server just serves segment files.

### Segment Size Is a UX vs Efficiency Tradeoff

Smaller segments (2 seconds) allow faster quality switching when bandwidth drops — client switches quality every 2 seconds. Larger segments (10 seconds) reduce the number of HTTP requests and CDN cache pressure. YouTube uses ~5-second segments as a balance. The manifest file (`.m3u8` for HLS, `.mpd` for DASH) lists all available segments and quality tiers; the player downloads and parses it to start playback.

### Upload Must Go Directly to Object Storage via Presigned URL

Routing a 4K video upload through your API server saturates the server's outbound network bandwidth for every concurrent upload. The correct architecture: client requests a presigned S3/GCS upload URL from your API (a lightweight metadata call), then uploads bytes directly to S3. The API server is never in the data path for video bytes. Use S3 multipart upload for files >100MB to support resumable uploads.

### CDN Origin Shielding Reduces Origin Traffic by 90%+

Without shielding, every CDN edge PoP (point of presence) fetches uncached content directly from origin. For a popular video with 100 edge PoPs and a cache miss, origin receives 100 simultaneous requests. With origin shielding: each geographic region has one "shield" node that is the only one that fetches from origin. All 20 PoPs within a region fetch from the regional shield. The shield absorbs the thundering herd; origin sees 1 request per region per cache miss, not 100.

### Always Store the Original Upload — Forever

After transcoding to H.264/VP9/AV1 at multiple resolutions, you might think the source file is redundant. It's not. When a better codec is released (AV1 in 2018, future codecs in 2030), you need to re-transcode. Without the original, you're forced to transcode from an already-lossy encode, compounding quality loss. Storage is cheap (~$0.02/GB/month on cold storage); re-uploading from users is not an option. YouTube stores originals in cold/archival storage indefinitely.

### "First Byte Latency" Determines Abandonment Rate

Users abandon a video stream if the first frame doesn't appear within ~3 seconds. This means the first 2-3 video segments must be in CDN cache before the viewer hits play. For live videos, segments are pushed to CDN proactively as they're created. For VOD, the first few segments of popular videos should be pre-positioned to CDN edge nodes during the upload processing pipeline, not fetched on first viewer request.

### View Count Is Approximate in Real-Time, Exact in Batch

Incrementing a counter in a DB for every view would create a hot-key write bottleneck for popular videos (millions of increments/second on one row). Production approach: approximate counts in real-time via HyperLogLog or streaming aggregation (counts are shown as "1.2M views" with rounding), reconciled to exact counts via a nightly batch job. The exact count is used for creator analytics and ad billing; the rounded count is shown in the UI.

### Comments and Likes Are Separate Services with Different Scaling Profiles

Video serving is read-heavy and latency-critical (sub-100ms). Comments are write-heavy and have moderate latency tolerance (1-2 seconds to post is fine). Likes require idempotency (double-click should count as one like). Mixing these in one service forces you to optimize for all three simultaneously — impossible. Separate services with separate databases allow independent scaling and optimization.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What the interviewer wants to see |
|---|---|---|
| Mid-Level | ~80% breadth, ~20% depth | Clean API, reasonable data model, recognizes presigned S3 uploads and segment-based playback. Can go deep on one topic when pushed. Interviewer drives the stage transitions. |
| Senior | ~60% breadth, ~40% depth | Drives the design without hand-holding. Confidently explains multipart + resumable uploads and a real transcoding pipeline. Articulates tradeoffs (e.g., segment length, codec choice, consistency vs availability). Proactively names bottlenecks and proposes mitigations. |
| Staff+ | ~40% breadth, ~60% depth | Speaks from operational experience. Picks the deep dives that matter and redirects away from ones that do not. Discusses origin shielding, codec ladders, tiered storage, and egress economics. Peer-level conversation about tradeoffs with real numbers. Minimal prompting needed. |
