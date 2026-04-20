# Design FB Live Comments

> **Pattern**: Real-time Broadcast / Fanout
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/fb-live-comments)

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Push vs Pull: Picking the Transport](#1-push-vs-pull-picking-the-transport)
   - [2. Horizontal Scaling of Realtime Servers](#2-horizontal-scaling-of-realtime-servers)
   - [3. Handling Mega-Streams](#3-handling-mega-streams)
   - [4. Reconnection, Catch-Up, and Ordering](#4-reconnection-catch-up-and-ordering)
   - [5. Choice of Pub/Sub Broker](#5-choice-of-pubsub-broker)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Facebook Live Comments is the stream of chat that floats over a live video while the broadcast is in flight. The broadcast itself (video encode/transcode/delivery) is out of scope; we only design the comment plane. The hard part is that this is a **read-heavy, fanout-shaped** workload: one writer spawns tens or hundreds of thousands of reads, all of which want their comment within ~200 ms.

### Functional Requirements

**In scope:**
- A viewer can post a comment on a specific live video.
- All concurrent viewers of that live video see new comments in near-real-time.
- A viewer joining mid-stream can load historical comments posted before they arrived.

**Explicitly out of scope:**
- Threaded replies to comments.
- Reactions / likes / emoji taps on a comment.
- Moderation, spam filtering, profanity masking.
- Authoring of the live video itself (ingest, transcode, playback).

### Non-Functional Requirements

- **Scale**: millions of concurrent live videos, thousands of comments per second on a single popular stream, tens of millions of simultaneous viewers in aggregate.
- **Latency**: end-to-end comment delivery under ~200 ms on typical networks; this is the human threshold where interaction still feels "live." Mega-streams may degrade to 1–2 s (documented below).
- **Availability over consistency**: dropping the rare comment is acceptable; freezing the chat is not. Eventual ordering is fine.
- **Durability of history**: comments should be persisted so late joiners can backfill.
- **Fan-out asymmetry**: reads dominate writes by several orders of magnitude; the design should optimize for the broadcast path.

---

## Core Entities

| Entity | Fields | Notes |
|---|---|---|
| **User** | `userId`, `displayName` | Reused from auth; identity attached via JWT, never trusted from the body. |
| **LiveVideo** | `liveVideoId`, `broadcasterId`, `startedAt`, `status` | Owned by the Live Video team; we only reference the id. |
| **Comment** | `commentId` (monotonic / snowflake), `liveVideoId`, `userId`, `message`, `createdAt`, `eventId` | `eventId` is the monotonic counter used for SSE `Last-Event-ID` resumption. |

A `Viewer` is not a first-class DB entity; it is a live SSE/WebSocket session tracked in memory on a realtime server.

---

## API Design

**Post a comment**
```
POST /v1/live/{liveVideoId}/comments
Authorization: Bearer <jwt>
Content-Type: application/json

{ "message": "Let's goooo" }
```
The server derives `userId` from the JWT to prevent spoofing. Returns the created `Comment` with its assigned `commentId`.

**Backfill historical comments (cursor-paginated)**
```
GET /v1/live/{liveVideoId}/comments?cursor={commentId}&limit=50&order=desc
```
Cursor over `commentId` (not offset) so inserts during scroll do not shift pages.

**Subscribe to live comments (push channel)**
```
GET /v1/live/{liveVideoId}/stream
Accept: text/event-stream
Last-Event-ID: <eventId>   // optional, set by browser on auto-reconnect
```
Response is an SSE stream where each event carries a `Comment` JSON payload and an `id:` header equal to `eventId`.

---

## High-Level Design

```
 Commenter ──POST──► API Gateway ──► Comment Service ──► Comments DB (DynamoDB)
                                           │
                                           ▼
                                       Pub/Sub Broker  (channel keyed by liveVideoId)
                                           │
                                           ▼
                                   Realtime Fanout Servers (SSE)
                                           │
                                           ▼
                                        Viewers
```

1. Commenter POSTs. The Comment Service writes to DynamoDB (or a similar KV/NoSQL store; the schema is `PK=liveVideoId, SK=commentId`).
2. After the write succeeds, the service publishes the comment onto a broker channel keyed by `liveVideoId`.
3. Realtime Fanout Servers that have subscribers for that `liveVideoId` receive the event and push it down the open SSE connections to the viewers.
4. A late-joining viewer first calls `GET /comments` to backfill, then opens the SSE stream to receive new events.

Why DynamoDB: the access pattern is `by liveVideoId, ordered by time`, writes are append-only, and we want elastic horizontal scale without relational joins.

---

## Deep Dives

### 1. Push vs Pull: Picking the Transport

**Problem.** Viewers need sub-200 ms delivery. Pull-based polling either wastes bandwidth (most polls return empty) or cannot hit the latency target (you would have to poll every ~50 ms).

**Solution.** Push. Two real options:

- **WebSockets**: full-duplex, persistent TCP-ish channel. Overkill here because the workload is asymmetric—one rare POST, continuous downstream events. Every viewer would hold a bidirectional socket they barely use upstream.
- **Server-Sent Events (SSE)**: one-way server-to-client over plain HTTP/1.1 chunked transfer, with a standardized `Last-Event-ID` reconnection protocol baked into browsers. Matches the read-heavy shape exactly, passes through most HTTP infra, and costs roughly half the per-connection bookkeeping of WebSockets.

Comments are still *posted* with a plain POST (one request, done), so we do not need the upstream half of a WebSocket. **Pick SSE** for the viewer stream.

Gotchas: some proxies buffer chunked responses (disable with `X-Accel-Buffering: no` on NGINX), and browsers cap ~6 SSE connections per origin over HTTP/1.1—use HTTP/2 so multiplexing removes that cap.

### 2. Horizontal Scaling of Realtime Servers

**Problem.** A single process cannot hold 10 M open sockets. We must shard viewers across many Realtime Servers. But if two viewers of the same `liveVideoId` land on different servers, each server must somehow receive that video's comments.

**Solution (viewer co-location + partitioned pub/sub).**
- Layer-7 load balancer (Envoy / NGINX) routes `/stream` connections by **consistent hash on `liveVideoId`**, so viewers of the same stream cluster on the same (small) set of servers.
- Broker channels are partitioned by `hash(liveVideoId) % N`. Each Realtime Server subscribes only to the partitions containing videos it currently has viewers for.
- As videos go viral and break a single server, the server sheds by asking the LB to spill new connections for that `liveVideoId` to a sibling in the hash ring.

**Alternative: Dispatcher Service.** Invert the model—keep a central dispatcher that maintains a `liveVideoId -> [serverId...]` map (stored in Zookeeper/etcd). The Comment Service POSTs new comments to the dispatcher, which pushes them only to servers that actually need them. Saves broker bandwidth but adds a coordination component that must stay hot during viral spikes.

### 3. Handling Mega-Streams

**Problem.** At 5 000 comments/sec, a comment is on screen for ~4 ms before scrolling off. Pushing every comment to every viewer is both useless (humans cannot read it) and wasteful. It is also the case where fan-out amplification is worst: one comment × 1 M viewers = 1 M push events.

**Solution (tiered delivery).**
1. **Sampling.** When comment velocity exceeds a threshold (say 200/sec), switch to representative sampling: pick a bounded N per second, biasing toward comments from followed accounts, verified users, or the broadcaster. The UI still feels alive without the firehose.
2. **CDN snapshots.** For the truly massive streams, maintain a ring buffer of the last ~200 comments per `liveVideoId` in Redis. A worker flushes a snapshot JSON to the CDN every 1 s. Viewers on mega-streams poll `GET /cdn/live/{id}/snapshot` instead of holding an SSE connection. Trades 1–2 s of latency for near-zero origin cost and arbitrary read scale.
3. **Mode switching.** Clients are told by the server which mode to use (`"mode": "sse"` vs `"mode": "cdn-poll"`). Use hysteresis—do not flap modes on every second—switch up at 500 viewers/sec and back only when sustained below 200 viewers/sec for 30 s.

### 4. Reconnection, Catch-Up, and Ordering

**Problem.** Mobile clients background, networks blip, and viewers scrub. We must not drop comments or show duplicates.

**Solution.**
- Every comment carries a monotonic `eventId` emitted as the SSE `id:` field. On disconnect the browser reconnects with `Last-Event-ID: N`; the server replays events `> N` from the broker's recent backlog (or a small Redis list per stream) and resumes.
- Clients also persist the last seen `commentId` locally. On cold open they hit `GET /comments?since=<id>&limit=100` to bridge the gap before opening SSE.
- Cap replay at the last ~5 minutes; beyond that, just show "live" and skip the deluge.
- **Deduplication** on the client: keep a small set of recently-seen `commentId`s and drop duplicates where HTTP backfill and SSE overlap.

### 5. Choice of Pub/Sub Broker

**Problem.** We need a broker that supports many short-lived channels (one per `liveVideoId`), dynamic subscription (viewers wander between streams), and fire-and-forget delivery (the database is already durable).

**Solution.**
- **Redis Pub/Sub** is the default: sub-ms latency, cheap channel creation, trivially handles subscribers coming and going. No durability guarantee is fine because comments are already persisted in DynamoDB.
- **Kafka** is wrong here: topics are heavyweight, dynamic subscription is awkward, and replay semantics are about offsets per partition rather than per-channel backlog.
- For very large deployments, shard Redis by `hash(liveVideoId) % M` across a cluster. If you need cross-region delivery, run a regional Redis per datacenter and bridge via a replication worker, or move to a purpose-built broker (e.g., NATS with JetStream) that handles multi-region natively.

---

## Scaling Journey: 0 to Infinity

This is the original progression I would walk through if asked "how does this evolve?" The inflection points are real operational breakpoints, not arbitrary numbers.

### Stage 1: 0–100 Viewers per stream (MVP)

- **Goal.** Ship something that works end-to-end so broadcasters can try it.
- **Architecture.** Single monolith behind an ALB: one process handles `POST /comments` and serves a dumb `GET /comments?since=...` that clients poll every 2 seconds. Writes go to a single Postgres table `(live_video_id, comment_id, user_id, message, created_at)` with an index on `(live_video_id, comment_id)`.
- **What you skip.** No push channel, no pub/sub, no CDN, no sharding. Authentication is a stub JWT check.
- **Failure mode that pushes to next stage.** Once a broadcaster hits ~500 concurrent viewers, polling becomes the bottleneck: 500 × 0.5 QPS = 250 read QPS per stream, and latency feels chunky (avg 1 s behind). You are also doing a database scan per poll.

### Stage 2: 100–1,000 Viewers

- **Goal.** Remove polling; give viewers a true push feed; stop scanning the DB on every tick.
- **Architecture.** Introduce a single **Realtime Server** process. It holds an SSE connection per viewer in memory. When the Comment Service writes a comment, it makes an in-process call (still a monolith) to broadcast onto the matching in-memory channel. Add a read-through cache: the last 200 comments per live video live in a local LRU, so late joiners rarely touch Postgres.
- **What you skip.** No pub/sub broker yet—everything is in one process, so publishing is just a Go channel / Node event emitter. No sharding of Realtime Servers.
- **Failure mode that pushes to next stage.** A single process tops out around 20–50 K concurrent SSE connections (file descriptors, GC pressure, TCP memory). Before that, you also realize you cannot deploy without dropping every viewer, which is a product problem.

### Stage 3: 1K–100K Viewers

- **Goal.** Scale Realtime Servers horizontally without breaking the per-stream fanout.
- **Architecture.**
  - Split the monolith: **Comment Service** (writes) and a fleet of **Realtime Servers** (SSE).
  - Introduce **Redis Pub/Sub** as the broker. Channel name = `live:{liveVideoId}`.
  - Layer-7 LB routes `/stream/{liveVideoId}` by **consistent hash on `liveVideoId`** so same-video viewers cluster on the same Realtime Server(s). This minimizes the number of servers that need to subscribe to any given Redis channel.
  - Each Realtime Server subscribes lazily: on the first SSE connection for a `liveVideoId`, it `SUBSCRIBE live:{id}`; on the last disconnect, it unsubscribes.
  - Comments still land in Postgres (or migrate to DynamoDB here if write volume justifies it).
- **What you skip.** Still one Redis. No regional replication. No CDN fallback. Mega-stream handling is an aspiration, not yet implemented.
- **Failure mode that pushes to next stage.** At ~100 K viewers on one stream, two things break: (1) the handful of Realtime Servers holding that stream burn CPU fanning out thousands of events × tens of thousands of sockets; (2) Redis Pub/Sub on one node starts buckling on egress bandwidth, since each published comment is delivered N times across the subscriber fleet.

### Stage 4: 100K–1M Viewers

- **Goal.** Survive viral streams; make mega-stream fanout sublinear in viewer count.
- **Architecture.**
  - **Shard Redis** by `hash(liveVideoId) % M` across a cluster. Each Realtime Server connects only to the shards it needs.
  - Introduce a **CDN snapshot path**. A per-stream snapshotter writes a `snapshot.json` containing the last ~200 comments to S3/CloudFront every 1 second, keyed by `liveVideoId`. When a stream's comment velocity crosses a threshold, the server tells clients to switch from SSE to CDN polling. Fanout cost collapses to the CDN's free-lunch distribution.
  - **Sampling** kicks in on the server side: at >200 comments/sec on a stream, downsample the published events (bias toward verified / followed users) so the SSE path never gets blasted.
  - Replay buffer for reconnection moves from per-server memory to a per-stream Redis list (`LRANGE live:{id}:recent 0 200`), so `Last-Event-ID` recovery works across reconnects that land on a different server.
- **What you skip.** Still single-region. No hierarchical fanout. Client-side dedup is still the simple hash-set approach.
- **Failure mode that pushes to next stage.** Streams with global audiences push too much cross-region traffic through one region's Redis/Realtime fleet, and latency to distant viewers climbs above 200 ms just from speed-of-light RTT. Redis Pub/Sub, even sharded, starts to look thin when you need durable replay across minutes.

### Stage 5: 1M+ Viewers (Hyperscale)

- **Goal.** Twitch / Facebook Live scale: one stream with millions of concurrent viewers across the planet, no single-region bottleneck, graceful degradation.
- **Architecture.**
  - **Regional Realtime fleets** in every PoP. Viewers connect to the nearest edge.
  - **Hierarchical fanout tree.** The origin publishes once. A per-region aggregator subscribes on behalf of the region and re-publishes to that region's Realtime Servers. Fanout fan-out ratio becomes `O(regions) + O(servers_per_region)` instead of `O(total_servers)`. This is the same shape as multicast trees / CDN origin-edge.
  - **Dispatcher service** (Zookeeper/etcd-backed map) so the Comment Service knows which regions currently have viewers for a given `liveVideoId` and only ships events there.
  - **Broker swap where needed.** Redis Pub/Sub stays for the low-latency in-region hop; a durable broker (NATS JetStream or a tuned Kafka) handles region-to-region replication with replay.
  - **Mode manager with hysteresis.** Per-stream controller watches velocity and viewer count, moves streams between `sse`, `sampled-sse`, and `cdn-poll` modes without flapping.
  - **Isolation / bulkheading.** A handful of mega-streams runs on a dedicated pool so one viral event cannot starve the long tail of small streams.
  - **Observability.** Per-stream dashboards for publish QPS, fanout amplification factor, SSE connection count, p99 delivery latency, and mode state.
- **What you skip.** Nothing structural—this is the target state. Ongoing work is tuning, cost reduction, and pushing more logic to the edge (for example, running the snapshotter on the CDN edge itself).
- **Failure mode.** From here, problems are operational, not architectural: broker hot-spotting on a single viral `liveVideoId`, slow-loris SSE clients eating connection slots, and multi-region consistency during broker failover.

---

## Expected Depth by Level

| Area | Mid-Level | Senior | Staff+ |
|---|---|---|---|
| Clarifying requirements | Lists core FRs with prompting. Names 200 ms target when asked. | Drives FR/NFR exchange. Calls out read/write asymmetry unprompted. | Frames the whole problem as a fanout amplification problem up front and sets the scaling goalposts. |
| API design | Produces reasonable REST endpoints; uses offset pagination unless corrected. | Uses cursor pagination and derives `userId` from JWT without prompting. | Designs the SSE contract, `Last-Event-ID` semantics, and mode-switch signaling end-to-end. |
| Transport choice | Realizes polling is bad with a nudge. Proposes "websockets" as the generic answer. | Compares SSE vs WebSocket vs long-poll and picks SSE with reasoning about the asymmetric workload. | Argues SSE + HTTP/2, details proxy buffering pitfalls, and specifies per-connection resource budgets. |
| Horizontal scaling | Draws a load balancer and more servers. Needs hints that same-video viewers must co-locate. | Arrives at consistent-hash routing on `liveVideoId` and partitioned pub/sub independently. | Additionally discusses dispatcher pattern, Zookeeper-backed routing maps, and spill-over strategies during viral spikes. |
| Pub/sub choice | Says "Kafka" by default and is corrected. | Picks Redis Pub/Sub and justifies with dynamic subscription + fire-and-forget. | Discusses Redis sharding, cross-region brokering, and when to graduate parts of the system to NATS JetStream or equivalent. |
| Mega-streams | May not raise the problem without a prompt. | Raises the issue, proposes sampling or CDN snapshots, explores tradeoffs. | Designs the full tiered delivery with mode manager, hysteresis, bulkheading, and per-stream isolation. |
| Reconnection / ordering | Mentions "store last id and retry." | Uses `Last-Event-ID` natively and explains dedup across backfill and SSE. | Specifies replay window, server-side replay buffer location, and client dedup data structures. |
| Time budget | 80% breadth, 20% depth. Usually stalls in the scaling deep dive. | 60% breadth, 40% depth. Leads the scaling discussion. | 40% breadth, 60% depth. Interviewer steers topics, not the design. |
