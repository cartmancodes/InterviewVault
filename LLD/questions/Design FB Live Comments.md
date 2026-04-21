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
   - [6. Connection-Tier Cost and WebSocket Server Architecture](#6-connection-tier-cost-and-websocket-server-architecture)
   - [7. Backpressure and Slow Subscribers](#7-backpressure-and-slow-subscribers)
   - [8. Thundering Herd on Stream Start and Reconnect](#8-thundering-herd-on-stream-start-and-reconnect)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

**Problem.** Viewers need sub-200 ms delivery. Pull-based polling either wastes bandwidth (most polls return empty) or cannot hit the latency target (you would have to poll every ~50 ms, generating 500 M requests/hour for 1 M viewers).

**Solution.** Push. Two real options:

- **WebSockets**: full-duplex, persistent TCP-ish channel. Overkill here because the workload is asymmetric—one rare POST, continuous downstream events. Every viewer would hold a bidirectional socket they barely use upstream. WebSocket also requires an HTTP upgrade handshake, is not always handled correctly by corporate proxies, and does not have a standardized reconnection protocol (you must implement that yourself).
- **Server-Sent Events (SSE)**: one-way server-to-client over plain HTTP/2, with a standardized `Last-Event-ID` reconnection protocol baked into browsers. Matches the read-heavy shape exactly, passes through most HTTP infra, and costs roughly half the per-connection bookkeeping of WebSockets. Auto-reconnect is handled by the browser with no application code required.

Comments are still *posted* with a plain POST (one request, done), so we do not need the upstream half of a WebSocket. **Pick SSE** for the viewer stream.

**Concrete tradeoff table:**

| Dimension | SSE | WebSocket |
|---|---|---|
| Direction | Server → client only | Bidirectional |
| Protocol overhead | HTTP/2 stream (no upgrade) | Upgrade handshake required |
| Proxy compatibility | Works everywhere | Some proxies break WS upgrades |
| Reconnection | Built into browser spec | Must implement manually |
| Right for this problem | Yes | No — comments only flow one way |

Gotchas: some proxies buffer chunked responses (disable with `X-Accel-Buffering: no` on NGINX), and browsers cap ~6 SSE connections per origin over HTTP/1.1—use HTTP/2 so multiplexing removes that cap.

### 2. Horizontal Scaling of Realtime Servers

**Problem.** A single process cannot hold 10 M open sockets. We must shard viewers across many Realtime Servers. But if two viewers of the same `liveVideoId` land on different servers, each server must somehow receive that video's comments.

**Solution (viewer co-location + partitioned pub/sub).**
- Layer-7 load balancer (Envoy / NGINX) routes `/stream` connections by **consistent hash on `liveVideoId`**, so viewers of the same stream cluster on the same (small) set of servers.
- Broker channels are partitioned by `hash(liveVideoId) % N`. Each Realtime Server subscribes only to the partitions containing videos it currently has viewers for.
- As videos go viral and break a single server, the server sheds by asking the LB to spill new connections for that `liveVideoId` to a sibling in the hash ring.

**Why consistent hashing specifically:** a naive modulo assignment would require remapping all connections whenever a server is added or removed. Consistent hashing remaps only `1/N` of streams on a topology change, which is essential for rolling deploys without mass disconnects.

**Alternative: Dispatcher Service.** Invert the model—keep a central dispatcher that maintains a `liveVideoId -> [serverId...]` map (stored in Zookeeper/etcd). The Comment Service POSTs new comments to the dispatcher, which pushes them only to servers that actually need them. Saves broker bandwidth but adds a coordination component that must stay hot during viral spikes. Worth it at hyperscale; premature at Stage 3.

**Failure mode to call out:** if the consistent-hash ring reassigns a stream during a viral surge, all viewers of that stream disconnect and reconnect simultaneously. This is the thundering herd problem (covered in Deep Dive 8). Mitigate by keeping the hot stream on its current server and adding new servers only for *new* connections.

### 3. Handling Mega-Streams

**Problem.** At 10 000 comments/sec (1 M viewers at 1% engagement), pushing every comment to every viewer is both useless (humans cannot read a comment that is on screen for <1 ms) and technically catastrophic: 10 000 events × 1 M connections = 10 B push operations per second. The fanout cost is O(comments × viewers), which is unsustainable at scale.

**Solution (tiered delivery).**
1. **Sampling.** When comment velocity exceeds a threshold (say 200/sec), switch to representative sampling: pick a bounded N per second, biasing toward comments from followed accounts, verified users, or the broadcaster. This is not a performance shortcut—it is a product decision. YouTube Live shows roughly 1–2% of comments on popular streams. The UI still feels alive without the firehose. Random sampling with a small bias toward highly-reacted comments is sufficient.
2. **CDN snapshots.** For the truly massive streams, maintain a ring buffer of the last ~200 comments per `liveVideoId` in Redis. A worker flushes a snapshot JSON to the CDN every 1 s. Viewers on mega-streams poll `GET /cdn/live/{id}/snapshot` instead of holding an SSE connection. Trades 1–2 s of latency for near-zero origin cost and arbitrary read scale.
3. **Mode switching.** Clients are told by the server which mode to use (`"mode": "sse"` vs `"mode": "cdn-poll"`). Use hysteresis—do not flap modes on every second—switch up at 500 viewers/sec and back only when sustained below 200 viewers/sec for 30 s.
4. **Slow mode (write-path rate limiting).** Allow the broadcaster to enable "slow mode": a per-user rate limiter keyed by `(userId, streamId)` with a configurable TTL (e.g., 30 seconds) stored in Redis. A user who posted within the TTL window gets a 429 response. This reduces write volume before it reaches the broker at all. Critically, slow mode must be enforced at write time—not by dropping comments after they are already published.

**Numbers to anchor the argument:** a 1 M-viewer stream at 1% engagement produces 10 K comments/sec. At 100 bytes per comment, that is 1 MB/sec of comment data. Fanned out to 1 M viewers, that is 1 TB/sec of egress—clearly impossible without sampling or CDN offload.

### 4. Reconnection, Catch-Up, and Ordering

**Problem.** Mobile clients background, networks blip, and viewers scrub. We must not drop comments or show duplicates. Additionally, with comments arriving from millions of clients across multiple regions with variable network latency, total ordering (every viewer sees comments in the exact same sequence) is not achievable without a centralized sequencer—which becomes a single point of failure and a bottleneck.

**Solution.**
- Every comment carries a monotonic `eventId` emitted as the SSE `id:` field. On disconnect the browser reconnects with `Last-Event-ID: N`; the server replays events `> N` from the broker's recent backlog (a Redis `LRANGE live:{id}:recent 0 200`) and resumes. Storing the replay buffer in Redis (rather than per-server memory) means reconnects that land on a different server still get correct catch-up.
- Clients also persist the last seen `commentId` locally. On cold open they hit `GET /comments?since=<id>&limit=100` to bridge the gap before opening SSE.
- Cap replay at the last ~5 minutes; beyond that, just show "live" and skip the deluge.
- **Deduplication** on the client: keep a small set of recently-seen `commentId`s (a fixed-size ring buffer or a bloom filter for memory efficiency) and drop duplicates where HTTP backfill and SSE overlap.
- **Ordering guarantee:** per-stream partial ordering is the correct target. Comments from the same Kafka partition (keyed by `streamId`) are ordered. Across partitions or across regions, ordering is best-effort. Two viewers may see slightly different comment sequences. This is a deliberate, correct tradeoff—not a bug. Advertising total ordering would require a centralized sequencer that cannot scale.

### 5. Choice of Pub/Sub Broker

**Problem.** We need a broker that supports many short-lived channels (one per `liveVideoId`), dynamic subscription (viewers wander between streams), and fire-and-forget delivery (the database is already durable).

**Solution.**

**Redis Pub/Sub** is the right default: sub-ms latency, zero-cost channel creation, trivially handles subscribers coming and going, and fire-and-forget semantics match (comments are already persisted in DynamoDB before publish). The key question is not "Redis vs Kafka" but "which Redis topology."

**Why Kafka is wrong here:**
- Kafka topics are heavyweight (each topic/partition maps to files on disk). Creating one topic per `liveVideoId` would generate millions of topics.
- Dynamic subscription is awkward: consumers must seek to an offset, and short-lived subscriptions (a viewer watches for 10 minutes then leaves) leave consumer group state to clean up.
- Kafka excels at durable, ordered, replayable streams consumed by a small number of well-known consumer groups—not at ephemeral fan-out to millions of transient subscribers.

**Kafka does belong in the write path** as the event bus between the Comment Service and the Realtime fleet—one Kafka topic with `streamId` as the partition key gives you durability, replay for region-to-region replication, and ordered delivery within a stream. The Realtime Servers then use Redis Pub/Sub for the final hop to individual SSE connections.

**Scaling Redis Pub/Sub:**
- Shard by `hash(liveVideoId) % M`. Each Realtime Server connects only to the shards containing its streams.
- For cross-region delivery, run a regional Redis per datacenter. A replication worker (or a purpose-built broker like NATS JetStream) bridges regions with replay semantics.
- At hyperscale, NATS JetStream handles multi-region natively with subject-based routing and durable consumers—worth evaluating when Redis sharding becomes operationally expensive.

### 6. Connection-Tier Cost and WebSocket Server Architecture

**Problem.** At 1 M concurrent viewers, raw connection cost becomes the binding constraint before any application logic runs. This is the infrastructure reality that drives the separation of concerns in the Realtime tier.

**The math:**
- Each SSE/WebSocket connection consumes ~64 KB of kernel socket buffer (send + receive, default Linux `tcp_wmem` and `tcp_rmem`).
- 1 M connections × 64 KB = 64 GB RAM just for socket buffers, before any heap allocation, application state, or OS overhead.
- A single 256 GB server can hold ~3 M connections in theory; in practice, other memory pressure brings this closer to 1–1.5 M.

**Architecture implication:** dedicate a **connection tier** (stateless WebSocket/SSE servers whose sole job is holding connections and forwarding events) separate from **application servers** (Comment Service, auth, business logic). Connection servers are scaled purely on connection count; application servers are scaled on request rate. The two have very different scaling curves.

**Connection state:** kept in-memory on the connection server (which `liveVideoId` each socket is subscribed to). Comment delivery is pushed via internal pub/sub (Redis channel per `liveVideoId`). The connection server holds no business logic—it is a dumb multiplexer between Redis channels and open sockets.

**Why companies like Twitch use regional connection servers:** speed-of-light latency from a viewer in Tokyo to an origin in us-east-1 is ~150 ms one way—over the 200 ms budget before the first byte arrives. Regional connection servers at the network edge cut RTT to <20 ms for most viewers.

### 7. Backpressure and Slow Subscribers

**Problem.** If a WebSocket/SSE client consumes events slowly (slow network, CPU-bound browser tab), the server's send buffer fills. Without backpressure handling, the server accumulates unbounded in-memory queues for that client, eventually causing OOM.

**The failure mode:** a single slow client on a high-velocity stream (10 K comments/sec) buffers 10 K × 100 bytes = 1 MB/sec. After 60 seconds, that is 60 MB for one client. With thousands of slow clients on the same server, this OOMs the process.

**Solution:** comments are ephemeral—a viewer missing 10 comments during a network lag is acceptable. The correct policy is **drop, not block**:

1. **Bounded send channel:** each client connection has a bounded channel (e.g., 512 events deep). If the channel is full when a new event arrives, drop the oldest event (ring buffer semantics) or drop the new event.
2. **Close on overflow:** if the buffer exceeds a threshold for more than N seconds, close the connection with a specific close code (`4001: slow consumer`). The client reconnects, gets a catch-up replay, and resumes. This is better than silently accumulating lag.
3. **Never block the producer:** the goroutine/thread receiving from Redis Pub/Sub and fanning out to clients must never block waiting for a slow client's send to complete. Use non-blocking channel sends with immediate drop on full.

The key principle: **producers must never be slowed by consumers**. The comment pipeline from write to delivery is a broadcast—if one viewer's network is slow, it should not delay delivery to all other viewers on the same server.

### 8. Thundering Herd on Stream Start and Reconnect

**Problem.** Two distinct thundering herd scenarios arise:

1. **Stream start:** when a popular streamer goes live, millions of clients receive a push notification simultaneously and attempt connections within a narrow time window (seconds).
2. **Mass reconnect:** a brief server restart, deploy, or network partition drops all existing connections at once. All clients attempt to reconnect simultaneously.

Both produce a spike of connection attempts that can overwhelm the connection tier and the upstream services it depends on (auth, Redis, DynamoDB for backfill).

**Mitigations:**

- **Exponential backoff with jitter on client reconnect:** the standard fix. Without jitter, all clients back off to the same retry time and produce a second synchronized storm. Full jitter (`sleep(random() * min(cap, base * 2^attempt))`) desynchronizes retries. This is a client-side change but is the most impactful mitigation.
- **Connection admission control:** the connection tier enforces a maximum new-connections-per-second rate. Connections beyond the limit receive an HTTP 503 with a `Retry-After` header. Clients respect it and retry with backoff.
- **Pre-scaling for scheduled streams:** for streams with a known start time (a scheduled concert, a sports event), pre-scale the connection tier 10–15 minutes before the announced start. Autoscaling reacts to load; pre-scaling anticipates it. This requires integration with the Live Video scheduling system to emit a `stream.scheduled` event that triggers the scaling workflow.
- **Staggered connection acceptance:** during a mass reconnect, the newly-restarted server accepts connections in batches (e.g., 10 K new connections per second) rather than all-at-once. Combined with connection queuing, this smooths the reconnect spike into a ramp.
- **Graceful deploys:** avoid simultaneous connection drops by using rolling restarts with connection draining. The load balancer marks a server as draining; it stops accepting new connections while existing ones migrate (client reconnects naturally when the server eventually closes). No synchronized disconnect storm.

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
  - **Bounded send channels** and drop-on-overflow added to Realtime Servers to handle slow subscribers without OOM.
  - **Slow mode** rate limiting added to the write path: Redis key `slowmode:{userId}:{streamId}` with TTL, enforced in the Comment Service before writing to DynamoDB.
- **What you skip.** Still single-region. No hierarchical fanout. Client-side dedup is still the simple hash-set approach.
- **Failure mode that pushes to next stage.** Streams with global audiences push too much cross-region traffic through one region's Redis/Realtime fleet, and latency to distant viewers climbs above 200 ms just from speed-of-light RTT. Redis Pub/Sub, even sharded, starts to look thin when you need durable replay across minutes.

### Stage 5: 1M+ Viewers (Hyperscale)

- **Goal.** Twitch / Facebook Live scale: one stream with millions of concurrent viewers across the planet, no single-region bottleneck, graceful degradation.
- **Architecture.**
  - **Regional Realtime fleets** in every PoP. Viewers connect to the nearest edge.
  - **Hierarchical fanout tree.** The origin publishes once. A per-region aggregator subscribes on behalf of the region and re-publishes to that region's Realtime Servers. Fanout fan-out ratio becomes `O(regions) + O(servers_per_region)` instead of `O(total_servers)`. This is the same shape as multicast trees / CDN origin-edge.
  - **Dispatcher service** (Zookeeper/etcd-backed map) so the Comment Service knows which regions currently have viewers for a given `liveVideoId` and only ships events there.
  - **Broker split:** Redis Pub/Sub stays for the low-latency in-region hop; a durable broker (NATS JetStream or a tuned Kafka) handles region-to-region replication with replay. Kafka partition key is `streamId` to preserve intra-stream ordering across regions.
  - **Mode manager with hysteresis.** Per-stream controller watches velocity and viewer count, moves streams between `sse`, `sampled-sse`, and `cdn-poll` modes without flapping.
  - **Isolation / bulkheading.** A handful of mega-streams runs on a dedicated pool so one viral event cannot starve the long tail of small streams.
  - **Pre-scaling hooks.** Integration with the scheduling system emits `stream.scheduled` events to trigger Realtime fleet pre-scaling before the announced start time, eliminating the thundering herd at stream start.
  - **Observability.** Per-stream dashboards for publish QPS, fanout amplification factor, SSE connection count, p99 delivery latency, mode state, slow-subscriber drop rate, and reconnect storm detection.
- **What you skip.** Nothing structural—this is the target state. Ongoing work is tuning, cost reduction, and pushing more logic to the edge (for example, running the snapshotter on the CDN edge itself).
- **Failure mode.** From here, problems are operational, not architectural: broker hot-spotting on a single viral `liveVideoId`, slow-loris SSE clients eating connection slots, and multi-region consistency during broker failover.

---

## Insider Tips and Tricks

### You Must Sample Comments Above a Threshold — It's a UX Requirement
A stream with 1M concurrent viewers posting comments at even 1% engagement produces 10,000 comments per second. Rendering all of them is both technically and visually impossible. Production systems sample aggressively above a threshold — YouTube Live shows perhaps 1-2% of comments on popular streams. The sampling is random with slight bias toward highly-reacted comments. This is not a scaling shortcut; it's a product decision that happens to solve a scaling problem.

### SSE Is Sufficient for Comment Delivery — WebSocket Is Overkill
Server-Sent Events (SSE) is a one-way HTTP/2 stream from server to client. Comments only flow server→client; clients send new comments via a separate POST request. SSE is simpler to implement (works over standard HTTP, no upgrade handshake), proxies handle it correctly, and it auto-reconnects. WebSocket adds bidirectional complexity you don't need for comment delivery. Use WebSocket only if you need true bidirectional real-time communication (e.g., collaborative editing).

### "Slow Mode" Is a Rate Limiter on the Write Path, Not the Read Path
Slow mode (users can only comment every 30 seconds) reduces comment volume on the write side. This is a per-user rate limiter keyed by `(userId, streamId)` with a 30-second TTL in Redis. It does not affect comment fanout speed or read-path architecture. Implementing it on the read path (dropping comments from fast commenters before fanout) would be wrong — the comment is already written; the limit must be enforced at write time.

### Partition Comment Streams by Stream ID, Not by Viewer
The Kafka partition key for comment events must be `streamId`, not `viewerId`. All comments for one stream must be on the same partition to maintain intra-stream ordering. If partitioned by viewer, comments from different viewers for the same stream end up on different partitions with no relative ordering. One stream = one Kafka partition (or a consistent subset of partitions). Consumers (WebSocket pushers) subscribe by streamId.

### WebSocket Connection Cost at 1M Concurrent Viewers Is the Real Constraint
Each WebSocket connection consumes ~64KB of kernel memory (socket buffer). 1M connections = 64GB RAM just for socket buffers — this is the infrastructure cost before any application logic. You need a connection tier (dedicated WebSocket servers) separate from business logic servers. Connection state is kept in-memory on the WebSocket server; comment delivery is pushed via internal pub/sub (Redis pub/sub or Kafka consumer per server). This is why companies like Twitch use regional connection servers.

### Backpressure: Slow Subscribers Must Not Block Fast Producers
If a WebSocket client consumes comments slowly (slow network), the server's send buffer fills. Without backpressure handling, the server accumulates unbounded in-memory buffers. Production fix: drop comments for slow subscribers (comments are ephemeral — a viewer missing 10 comments during a lag is acceptable), or use a bounded channel and close the connection if the buffer exceeds a threshold. Never block the producer waiting for a slow consumer.

### Live Comments Are Ephemeral — Most Platforms Don't Durably Store All of Them
Durably storing every comment from a 1M-viewer stream at 10K comments/second generates 36M rows per hour. Most platforms store a small sample for replay and moderation, not the full stream. The common design: write to a Kafka topic (retained for 7 days for replay), sample 1% to a durable DB for moderation review, discard the rest after delivery. Viewers who reload the page see the last N sampled comments, not the full history.

### Thundering Herd on Stream Start / Reconnect
When a popular streamer goes live, millions of clients attempt WebSocket connections simultaneously. When a brief server restart happens, all existing connections drop and reconnect at once. Both cause a thundering herd. Mitigations: exponential backoff with jitter on client reconnect, connection admission control (queue new connections, don't accept all simultaneously), and pre-scaling WebSocket servers before a scheduled stream start.

### Total Comment Ordering Is Impossible at Scale — And That's Fine
With comments arriving from millions of clients across multiple regions with variable network latency, total ordering (every viewer sees comments in the exact same sequence) requires a centralized sequencer — a single SPOF that becomes the bottleneck. Production systems use per-stream partial ordering (comments from the same Kafka partition are ordered; across partitions, ordering is best-effort). Viewers accept that two viewers may see slightly different comment sequences. This is a deliberate, correct tradeoff.

---

## Expected Depth by Level

| Area | Mid-Level | Senior | Staff+ |
|---|---|---|---|
| Clarifying requirements | Lists core FRs with prompting. Names 200 ms target when asked. | Drives FR/NFR exchange. Calls out read/write asymmetry unprompted. | Frames the whole problem as a fanout amplification problem up front and sets the scaling goalposts. |
| API design | Produces reasonable REST endpoints; uses offset pagination unless corrected. | Uses cursor pagination and derives `userId` from JWT without prompting. | Designs the SSE contract, `Last-Event-ID` semantics, and mode-switch signaling end-to-end. |
| Transport choice | Realizes polling is bad with a nudge. Proposes "websockets" as the generic answer. | Compares SSE vs WebSocket vs long-poll and picks SSE with reasoning about the asymmetric workload. | Argues SSE + HTTP/2, details proxy buffering pitfalls, and specifies per-connection resource budgets. |
| Horizontal scaling | Draws a load balancer and more servers. Needs hints that same-video viewers must co-locate. | Arrives at consistent-hash routing on `liveVideoId` and partitioned pub/sub independently. | Additionally discusses dispatcher pattern, Zookeeper-backed routing maps, and spill-over strategies during viral spikes. |
| Pub/sub choice | Says "Kafka" by default and is corrected. | Picks Redis Pub/Sub and justifies with dynamic subscription + fire-and-forget. | Discusses Redis sharding, cross-region brokering, and when to graduate parts of the system to NATS JetStream or equivalent. Correctly places Kafka on the write path (partition key = streamId) not the fan-out path. |
| Mega-streams | May not raise the problem without a prompt. | Raises the issue, proposes sampling or CDN snapshots, explores tradeoffs. | Designs the full tiered delivery with mode manager, hysteresis, bulkheading, per-stream isolation, and anchors sampling as a product decision not just a perf optimization. |
| Reconnection / ordering | Mentions "store last id and retry." | Uses `Last-Event-ID` natively and explains dedup across backfill and SSE. | Specifies replay window, server-side replay buffer location, client dedup data structures, and correctly articulates why total ordering is impossible and per-stream partial ordering is the right target. |
| Backpressure / slow subscribers | Does not raise the problem. | Raises the issue with prompting; proposes dropping or bounding buffers. | Specifies bounded channel semantics, drop-vs-close policy, and the invariant that producers must never block on slow consumers. |
| Thundering herd | Does not raise the problem. | Raises mass reconnect scenario; proposes backoff. | Covers both stream-start and mass-reconnect scenarios; specifies jitter formula, admission control, pre-scaling hooks, and graceful rolling deploys. |
| Connection cost | Does not quantify. | Estimates rough connection count. | Derives the 64 GB socket-buffer number, uses it to argue for a dedicated connection tier, and connects it to why regional PoP servers are necessary. |
| Time budget | 80% breadth, 20% depth. Usually stalls in the scaling deep dive. | 60% breadth, 40% depth. Leads the scaling discussion. | 40% breadth, 60% depth. Interviewer steers topics, not the design. |
