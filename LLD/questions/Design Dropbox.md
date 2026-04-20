# Design Dropbox

> **Pattern**: File Storage / Sync
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/dropbox)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [DD1: Supporting Very Large Files (up to 50 GB)](#dd1-supporting-very-large-files-up-to-50-gb)
   - [DD2: Resumable Uploads and Deduplication](#dd2-resumable-uploads-and-deduplication)
   - [DD3: Fast Downloads via CDN and Range Requests](#dd3-fast-downloads-via-cdn-and-range-requests)
   - [DD4: Cross-Device Sync (Push + Pull Hybrid)](#dd4-cross-device-sync-push--pull-hybrid)
   - [DD5: Delta Sync via Content-Defined Chunking](#dd5-delta-sync-via-content-defined-chunking)
   - [DD6: Conflict Resolution](#dd6-conflict-resolution)
   - [DD7: Security, Signed URLs, and Access Control](#dd7-security-signed-urls-and-access-control)
   - [DD8: Compression and Encryption Ordering](#dd8-compression-and-encryption-ordering)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Dropbox is a file hosting and synchronization service. Users upload files from any device, download them from any other device, share them with other users, and expect changes to propagate automatically. The interesting engineering problems live at the intersection of "large blobs that must not be lost" and "many clients that must stay in sync without a central editor."

### Functional Requirements

**Core:**
- A user can upload a file from any device.
- A user can download any of their files from any device.
- A user can share a file with other users, and those users can read it.
- Files automatically sync across all of a user's devices when the file changes.

**Out of scope (below the line):**
- In-place file editing (Google Docs style collaborative editing).
- In-browser preview of content without a full download.
- Explicit multi-version history / time-travel restore.
- Virus or malware scanning.

### Non-Functional Requirements

**Core:**
- Availability is prioritized over strict consistency. Users across regions tolerate a few seconds of delay before a change appears on another device; they do not tolerate a dead service.
- Individual files can be very large, up to 50 GB.
- Durability and recovery: once an upload is acknowledged, the bytes must not be lost.
- Low latency for upload, download, and sync propagation.

**Out of scope:**
- Per-user storage quotas.
- Full versioning semantics.
- Advanced threat scanning.

The availability-over-consistency choice is load-bearing: it is what lets us lean on asynchronous sync, eventual propagation via change feeds, and CDN caches without having to coordinate global writes.

---

## Core Entities

Three entities are enough to reason about everything else:

1. **User** - Identity, auth credentials, device list.
2. **File** - The raw bytes living in a blob store. Not stored in a relational DB.
3. **FileMetadata** - Logical record describing a file: `fileId`, `ownerId`, `name`, `size`, `mimeType`, `fingerprint` (hash of contents), `chunks[]` (each with id, offset, hash, status, ETag), overall `status` (uploading / uploaded), timestamps.

A fourth table, **SharedFiles**, maps `(userId, fileId, permission)` and answers "which files can this user see?" It is deliberately separate from `FileMetadata` so that granting access does not require rewriting the file record.

---

## API Design

The API is deliberately thin because the heaviest byte transfers happen directly between the client and the blob store via presigned URLs, bypassing the application servers.

```
# Request a presigned URL to upload (single-shot or multipart init)
POST /files/presigned-url
Body: { name, size, mimeType, fingerprint }
Returns: { fileId, uploadId?, presignedUrls[] }

# Client uploads bytes directly to blob storage
PUT {presignedUrl}
Body: <raw chunk bytes>

# Client reports chunk completion (server verifies against S3)
PATCH /files/{fileId}/chunks
Body: { chunkId, eTag, status }

# Finalize multipart upload after all chunks complete
POST /files/{fileId}/complete

# Request a signed CDN URL to download
GET /files/{fileId}/presigned-url
Returns: { url, expiresAt }

# Share a file
POST /files/{fileId}/share
Body: { userIds[], permission }

# Pull changes since a watermark (used for sync)
GET /files/changes?since={cursor}
Returns: { events[], nextCursor }
```

Critical detail: the presigned-URL endpoint does not call S3. Presigning is a local cryptographic operation using the S3 account credentials, so it stays fast and does not create an S3 rate-limit coupling.

---

## High-Level Design

The architecture is a classic "control plane vs data plane" split.

**Client layer:**
- **Uploader** - Watches the local filesystem via OS events (FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify on Linux), chunks changed files, computes hashes, drives uploads.
- **Downloader** - Listens for change notifications, fetches updated metadata, pulls changed chunks from the CDN, reassembles the file locally.

**Edge / API layer:**
- **Load balancer + API gateway** - TLS termination, auth, rate limiting, routing.
- **File service** - Creates FileMetadata, signs URLs, records chunk state, verifies completion against S3, serves the change feed.
- **Notification service** - Maintains a WebSocket (or SSE) connection per device and pushes change events.

**Storage layer:**
- **Metadata DB** - Something like DynamoDB or PostgreSQL. Holds FileMetadata, SharedFiles, Users. Small rows, indexed by `ownerId`, `fileId`, and a per-user change cursor.
- **Blob store (S3)** - Holds raw chunks. Source of truth for bytes.
- **CDN (CloudFront or equivalent)** - Fronts S3 for reads.

**Data flow, upload:**
1. Client hashes the file, splits into chunks, asks the file service for presigned URLs.
2. Client PUTs chunks directly to S3 in parallel.
3. On each chunk's success, client PATCHes the file service with `(chunkId, ETag)`.
4. Server verifies by calling S3 `ListParts`; if ETags match, marks chunk uploaded.
5. When all chunks are in, server calls `CompleteMultipartUpload`, flips file status to `uploaded`, and writes a change event.

**Data flow, download:**
1. Client asks for a signed URL; server checks ACL via SharedFiles and signs.
2. Client hits the CDN; edge either serves cached bytes or pulls from S3 and caches.

**Data flow, sync:**
1. A write on device A produces a change event in the metadata DB.
2. The notification service pushes the event to every live device of every user who can see that file.
3. Each device fetches the new metadata and pulls only the changed chunks.

---

## Deep Dives

### DD1: Supporting Very Large Files (up to 50 GB)

**Problem.** A single HTTP PUT does not survive a 50 GB upload. API gateways cap payload size (AWS API Gateway caps at 10 MB), reverse proxies time out, mobile networks flap, and if anything fails the whole transfer restarts. You also cannot stream 50 GB through the application tier without burning memory and bandwidth on both sides.

**Solution.** Chunk on the client, upload chunks directly to S3 via presigned URLs, and use S3 multipart upload underneath.
- Chunk size 5-10 MB. Small enough to retry cheaply, big enough that TCP window scaling and parallelism pay off.
- Client computes SHA-256 per chunk and per whole file; the whole-file hash is the `fingerprint`.
- Client calls `CreateMultipartUpload` (via the file service), receives an `uploadId`, and then a presigned URL per part.
- Parts upload in parallel, each returns an ETag from S3.
- After all parts land, server calls `CompleteMultipartUpload`, which atomically assembles the object.

Bypassing the app tier for bytes is the single biggest win: the servers only touch small metadata, so a $0.01 box can orchestrate gigabyte transfers.

### DD2: Resumable Uploads and Deduplication

**Problem.** On a flaky connection, a 40 GB upload that fails at 39 GB is a disaster. Separately, re-uploading a file the user (or another user) already uploaded wastes bandwidth and storage.

**Solution.** Fingerprint-based resumability plus content-addressed dedup.
- Before starting, the client sends the file fingerprint. If the server already has a completed blob with that fingerprint, it just links the user's new FileMetadata row to the existing object. Zero bytes transferred.
- If there is an in-progress upload with that fingerprint, the server returns the per-chunk status map: `[uploaded, uploaded, uploading, not-uploaded, ...]`. The client resumes only the missing chunks.
- **Trust but verify.** The client's `PATCH /chunks` call is a hint, not authority. The server calls S3 `ListParts` and checks the ETag it was told against the ETag S3 reports. A malicious client cannot mark a chunk complete with bytes it did not actually upload.

This also gives the progress bar a cheap source of truth: completed-chunks / total-chunks, updated as PATCHes land.

### DD3: Fast Downloads via CDN and Range Requests

**Problem.** Users are globally distributed; a single-region S3 bucket adds 100-300 ms of latency per request and fat-pipe streams cost real money at egress. And big files want parallel, resumable reads on the client side too.

**Solution.**
- Put a CDN in front of S3. First read for a file in a region is an origin fetch, everything after is edge-cached.
- Cache-Control headers on immutable chunks (which are content-addressed) can be aggressive; metadata responses are not cached.
- HTTP Range requests let the client pull chunks in parallel and resume interrupted downloads without re-fetching already-retrieved bytes.
- Download URLs are short-lived signed URLs so a cache hit still respects authorization at request time.

### DD4: Cross-Device Sync (Push + Pull Hybrid)

**Problem.** If device A saves a file, device B should see it within seconds. Pure polling wastes battery and money; pure push is unreliable when the WebSocket drops mid-event.

**Solution.** WebSocket (or SSE) for the happy path, periodic pull as a safety net.
- Each device holds one WebSocket to the notification service. The server pushes events: `{fileId, changeType, newMetadataVersion}`.
- Every few minutes, the client also calls `GET /files/changes?since={cursor}`. If the socket dropped or a message was lost, the pull fills the gap. The cursor is stored per device.
- Local filesystem changes are driven by OS events on the uploader side so we do not need a scan loop to detect local edits.

The server is the source of truth; clients never sync peer-to-peer.

### DD5: Delta Sync via Content-Defined Chunking

**Problem.** If the user edits 1 KB near the start of a 1 GB file using fixed-size chunking, every single chunk boundary shifts and every chunk's hash changes. We would re-upload and re-download 1 GB for a 1 KB edit. That defeats "fast sync."

**Solution.** Content-defined chunking with a rolling hash (Rabin fingerprint).
- Chunk boundaries are chosen where the rolling hash over a sliding window hits a target pattern, not at fixed byte offsets.
- An insert near the start only disturbs the chunk containing the edit; downstream boundaries realign after a few bytes and produce the same chunks as before.
- The client diffs the new chunk hash list against the server's last known list and only uploads the chunks whose hashes are new.

The cost is more CPU on the client, but client CPU is cheap compared to repeated gigabyte uploads on a mobile hotspot.

### DD6: Conflict Resolution

**Problem.** Device A and device B both edit the same file while offline. When both reconnect, which wins?

**Solution.** Last-write-wins, keyed by server-observed timestamp of the finalize step.
- It is simple, matches users' mental model for a file sync product, and sidesteps the complexity of operational transforms (which we do not need because in-place collaborative editing is explicitly out of scope).
- A more careful implementation keeps the loser as a "conflicted copy" file rather than discarding it, so no edit is silently lost. This is how real Dropbox behaves and is worth mentioning.

### DD7: Security, Signed URLs, and Access Control

**Problem.** Presigned URLs are bearer tokens: whoever has the URL can download. Also, we must not serve a file to a user who was not granted access.

**Solution.**
- Authorization check happens at URL-signing time, against the SharedFiles table. No valid signature, no URL.
- Signatures expire in ~5 minutes. Short enough that a leaked link is not a permanent compromise, long enough that a slow client can still complete the download.
- Signatures can bind to the client IP for additional constraint where practical.
- TLS everywhere in transit; S3 SSE (server-side encryption) at rest with keys stored separately from the bucket. An attacker who steals the bucket still has ciphertext.

### DD8: Compression and Encryption Ordering

**Problem.** Big text files (logs, CSVs, source archives) compress well; media files do not. Naive "encrypt then compress" kills compression because ciphertext is high-entropy.

**Solution.**
- Compress before encrypt, on the client.
- Skip compression for already-compressed formats (media, zips, existing archives) where the savings would not pay for the CPU.
- Zstandard is a good default for client-side work: fast enough not to bottleneck uploads, strong ratios. Brotli and gzip are acceptable fallbacks where Zstd is unavailable.

---

## Scaling Journey: 0 to Infinity

This section is the author's own analysis, tailored to the file-sync shape of the problem: how the storage tier, sync fanout, chunking strategy, and metadata store evolve as load grows.

### Stage 1: 0-100 Users (MVP)

**Goal.** Prove the product: a user can drop a file into a folder on one machine and find it on another. Nothing else matters.

**Architecture.**
- One monolith (Node/Go/Python, whatever the team knows) behind a single load balancer.
- One managed Postgres instance for Users, FileMetadata, SharedFiles.
- S3 as the blob store from day one; do not try to build storage yourself.
- Direct uploads through the monolith (multipart form) - no presigned URLs yet.
- Clients poll `GET /files/changes?since=` every 30 seconds. No WebSockets.
- No CDN. S3 direct reads.

**What you skip.**
- Chunking. Files are uploaded whole, capped at maybe 100 MB so nobody learns a painful lesson.
- Content-defined chunking, delta sync, dedup - all deferred.
- Real-time push. Polling is fine at this scale.
- Multi-region anything.

**Failure mode that pushes to next stage.** Someone uploads a 2 GB video. The request streams through the monolith, eats memory, times out at the load balancer's 60-second limit, and the user loses the upload. The app box is now the bottleneck.

### Stage 2: 100-1,000 Users

**Goal.** Get large blobs off the application servers. Start supporting multi-GB files.

**Architecture.**
- Introduce **presigned URLs**. The monolith no longer touches bytes; it only signs.
- Introduce **fixed-size chunking** (10 MB) with S3 multipart upload.
- Add a chunk-status table; add the `PATCH /chunks` endpoint with server-side ETag verification via `ListParts`.
- Keep Postgres as the single metadata DB. Add read replicas for the change-feed query.
- Still no CDN. S3 direct reads are fine for 1K users.
- Still polling for sync, but reduce interval to 10 seconds because the change feed is cheap.
- Add fingerprint-based dedup: if a file with the same SHA-256 already exists, link to it.

**What you skip.**
- Content-defined chunking (fixed chunks are good enough; most files are written once).
- WebSocket push (polling at 10s is acceptable latency).
- Sharding the metadata DB.
- CDN.

**Failure mode that pushes to next stage.** International users complain about 500ms+ download latency. Also, the poll interval trade-off starts to bite: 10 seconds feels laggy for sync, 1 second hammers the DB. And a single writer Postgres is starting to show replication lag on the change feed.

### Stage 3: 1K-100K Users

**Goal.** Make reads fast globally and make sync feel real-time.

**Architecture.**
- Put a **CDN** (CloudFront or equivalent) in front of S3. Signed URLs now point to the CDN, not S3 directly. First-region-fetch populates the edge; everyone after gets sub-100ms downloads.
- Introduce a dedicated **notification service** with **WebSockets** (or SSE). One persistent connection per active device. The file service publishes a change event to a message broker (Kafka or a managed pub/sub); the notification service fans out to connected sockets.
- Keep periodic polling as a safety net (now every 5 minutes instead of 10 seconds), so a dropped socket does not cause silent desync.
- Split the monolith into **file service** (metadata + signing) and **notification service** (WebSocket fanout). They have very different scaling profiles: file service is CPU-bound request/response, notification service holds many idle long-lived connections.
- Move metadata DB from a single Postgres to Postgres with partitioned tables by `ownerId`, or migrate to DynamoDB if query patterns are truly key-value.

**What you skip.**
- Delta sync / content-defined chunking. Most files are whole-file writes; the complexity cost is not yet justified.
- Multi-region writes. All writes still land in one region.
- Horizontal sharding of the blob store namespace (S3 handles this for you).

**Failure mode that pushes to next stage.** Two things hit at once. First, power users syncing large files that change a lot (video edits, database exports) saturate their uplinks repeatedly because fixed chunking re-uploads every chunk after an insert. Second, the single write region is now 200ms from users in APAC for every metadata write, and the metadata DB is hot on the top 1% of shares.

### Stage 4: 100K-10M Users

**Goal.** Make sync efficient for large, frequently-edited files. Start thinking globally.

**Architecture.**
- Introduce **content-defined chunking** (Rabin fingerprints). Clients only upload chunks whose rolling-hash-identified boundaries changed. Re-uploads on small edits drop by 1-2 orders of magnitude.
- Introduce a **storage tiering policy**: hot chunks (accessed in last 30 days) stay in S3 Standard, cold chunks move to S3 Infrequent Access or Glacier Instant Retrieval. Dedup already paid for itself; now tiering does.
- **Regional metadata DBs** with a primary region per user, replicated read-only to other regions. A user's writes always go home; reads can be served locally. Accept the availability-over-consistency trade-off explicitly here.
- **Shard the metadata DB** by `ownerId`. DynamoDB if not already. The SharedFiles table is sharded by `userId` (the reader), not `fileId`, because the dominant query is "what can this user see?"
- **Regional notification services.** A device connects to its nearest region; cross-region change events flow through the message broker.
- Aggressive **CDN tuning**: pre-warm for popular shared files, bump TTLs on immutable content-addressed chunks (they cannot change by definition).

**What you skip.**
- Global strong consistency on writes. Still last-write-wins.
- Custom blob storage. S3 keeps working.
- Per-user rate limiting beyond basic abuse prevention.

**Failure mode that pushes to next stage.** At this scale, two new classes of problem appear. The message broker fans out change events at O(shares) and starts to melt on viral shared folders (one file shared with 50,000 users produces 50,000 push events per edit). Separately, the metadata DB's change-feed queries become the hottest path in the system and need their own infrastructure.

### Stage 5: 10M+ Users

**Goal.** Survive viral fanout, team folders with tens of thousands of members, and keep per-user cost sane.

**Architecture.**
- **Dedicated change-feed service** built on a log (Kafka, Pulsar) rather than DB polling. Each user has a logical change-log cursor. The notification service consumes the log and pushes to sockets; clients fall back to reading the log directly via the change-feed API if reconnecting.
- **Fanout optimizations.** For shared folders with huge membership, switch from push-per-member to "publish once, each connected client pulls on next poll or next interaction." This is the classic Twitter fanout-on-read trade-off, applied to files.
- **Separation of metadata vs blob store scaling** becomes explicit: metadata tier scales on write QPS and index size; blob tier scales on bytes stored and egress. They are sized and budgeted independently.
- **Chunk-level dedup across all users** with a global content-addressed store. A movie that a million users upload is stored once. Requires careful reference counting and a GC that is safe under concurrent deletion.
- **Adaptive chunk sizing** based on observed network conditions per client: mobile 4G gets 2 MB chunks for retry cheapness, fiber connections get 32 MB chunks for throughput.
- **Regional active-active** for metadata, with conflict resolution via last-write-wins on a hybrid logical clock. Acceptable because file metadata conflicts are rare in practice; the typical case is a single user editing from one device at a time.
- **Tiered storage policy driven by ML**: predict access patterns and pre-promote cold chunks to warm tiers before the user asks for them (e.g., a morning re-open of yesterday's project folder).
- **Dedicated abuse / fraud / quota service** now that spam uploads, credential stuffing, and copyright takedown volume all demand real engineering.

**What you skip (even at this scale).**
- Strong global consistency. Still not worth it for file sync.
- Peer-to-peer client sync. Tempting for bandwidth savings, but the security and ACL story gets miserable.
- Building your own blob storage. S3 or an internal equivalent continues to be the right call; the economics of rolling your own only pencil out past hyperscaler volume.

---

## Expected Depth by Level

| Dimension | Mid (E4) | Senior (E5) | Staff+ (E6+) |
|---|---|---|---|
| Breadth vs depth | 80 / 20 | 60 / 40 | 40 / 60 |
| API + data model | Must produce a clean one | Must produce one quickly, move on | Sketch and move on; not where time is spent |
| Presigned URLs | OK to not know; reason to it when asked | Expected to propose unprompted | Assumed baseline |
| Chunking + multipart | Discuss if guided | Drive the conversation: chunk size, ETag verification, resumability | Discuss content-defined chunking, rolling hashes, adaptive sizing |
| Sync mechanism | Polling is acceptable | Propose WebSocket + polling fallback | Discuss fanout trade-offs, change-feed as a log, viral-folder fanout-on-read |
| Conflict resolution | "Last write wins" is fine | Discuss conflicted copies, edge cases | Compare against OT/CRDT and justify why it is out of scope here |
| Storage tiering | Not expected | Mention hot/cold awareness | Drive tiering + dedup + GC discussion |
| Proactivity | Interviewer drives | Shared driving | Candidate drives; interviewer only redirects |
| Trade-off articulation | Identify one side | Identify both sides with a reason | Nuanced, often from production experience |
