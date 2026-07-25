# Real-time Updates

> **Quick Reference** for [Real-TimeUpdates](../Real-TimeUpdates.md) — condensed cheat-sheet.

## First Hop

### Client Protocols

![Client protocols: Simple Polling is the default unless low latency is required, Long Polling holds HTTP requests for infrequent near-real-time updates, Server-Sent Events is a one-way HTTP stream, WebSockets is a full-duplex persistent channel, and WebRTC is peer-to-peer with signaling, STUN, and TURN.](assets/aa3cd63cf82688fa-1ea219aad7c65708.png)

- **Simple Polling**: Default unless low latency is required; stateless HTTP, delayed by the polling interval.
- **Long Polling**: Held HTTP request gives near real-time for infrequent updates, but bursts add callback latency.
- **Server-Sent Events (SSE)**: One-way HTTP stream; efficient for server push when clients rarely write back.
- **WebSockets**: Full-duplex persistent channel for high-frequency reads and writes; adds stateful infra.
- **WebRTC**: Peer-to-peer for audio/video or server-load reduction; requires signaling, STUN, and TURN.

### Load Balancers

![Load balancers: L4 Load Balancer routes by IP and port while preserving TCP sessions, and L7 Load Balancer terminates connections and routes by HTTP content.](assets/3da8beb6c333950e-21dc7f65f5080920.png)

- **L4 Load Balancer**: Routes by IP and port, preserves TCP sessions, and fits persistent connections.
- **L7 Load Balancer**: Terminates connections and routes by HTTP content; better for HTTP traffic.

### Connection Pitfalls

![Connection pitfalls: HTTP keep-alive should exceed the polling interval, long-poll timeouts must align across every hop, streaming proxies can buffer SSE responses, and deployment churn forces persistent sockets to reconnect.](assets/aa3cd63cf82688fa-6fa7cbdf7f9786c5.png)

- **HTTP keep-alive**: Set it longer than the polling interval to avoid repeated TCP setup and teardown.
- **Long-poll timeouts**: Align client, server, and load balancer timeouts so long requests are not cut off.
- **Streaming proxies**: Some proxies buffer SSE responses; verify streaming support across every hop.
- **Deployment churn**: Server restarts sever persistent sockets; expect clients to reconnect rather than transfer sockets.

## Second Hop

### Trigger Models

![Trigger models: Pushing via Pub/Sub is the default for most real-time designs, Pushing via Consistent Hashes gives a predictable owner for heavy connection state, and Pulling via Polling uses DB-backed reads with delay and extra DB load.](assets/aa3cd63cf82688fa-4a35a1c6bbf49580.png)

- **Pushing via Pub/Sub**: Default for most real-time designs; endpoints subscribe and forward lightweight updates.
- **Pushing via Consistent Hashes**: Predictable owner for heavy connection state; needs Zookeeper or etcd routing metadata.
- **Pulling via Polling**: DB-backed reads decouple producers and clients; accepts delay and extra DB load.

### Scaling Assignment

1

Signal scaling start and keep both old and new server mappings.

2

Reconnect clients to new owners while sending updates to both old and new servers.

3

Signal completion and update the coordination service with new assignments.

## Key Numbers

2-5 second updates may be acceptable when true real-time is not required.

With 100ms latency and updates 10ms apart, the second update can arrive up to 290ms late.

15-30s is a common polling interval that avoids load balancer timeout fuss.

1M clients polling every 10s creates 100k TPS of read volume.

The extra indirection has minimal latency impact, under 10ms.

## Interview Scenarios

### Bidirectional Delivery Scenarios

![Bidirectional delivery scenarios: Instant messages need bidirectional delivery, and typing indicators and presence need bidirectional delivery.](assets/3da8beb6c333950e-82363bca70ccfa59.png)

- **Instant messages**: Need bidirectional delivery.
- **Typing indicators and presence**: Need bidirectional delivery.

### High-Volume Fan-Out Scenarios

![High-volume fan-out scenarios: Live Comments use batching and hierarchical aggregation for high-volume fan-out during live events, and Live Dashboards and Analytics use one-way metric updates with aggregation intervals.](assets/3da8beb6c333950e-02d61f10c628490f.png)

- **Live Comments**: High-volume fan-out during live events; use batching and hierarchical aggregation.
- **Live Dashboards and Analytics**: One-way metric updates; decide aggregation intervals and real-time enough.

### Consistency and Conflict Scenarios

![Consistency and conflict scenarios: CRDTs handle collaborative document editing character-update conflicts, and Operational Transforms handle collaborative document editing character-update conflicts.](assets/3da8beb6c333950e-2872076a67c62a29.png)

- **CRDTs**: Conflict handling for collaborative document editing character updates.
- **Operational Transforms**: Conflict handling for collaborative document editing character updates.

## Deep Dive Fixes

![Deep dive fixes: Heartbeats detect broken sockets, Missed update replay uses per-user queues or sequence numbers, Celebrity fan-out caches once and distributes through layers, and Message ordering sends related messages through one server or partition.](assets/aa3cd63cf82688fa-27e41c0635ba7297.png)

- **Heartbeats**: Detect broken sockets where client and server disagree on connection state.
- **Missed update replay**: Use per-user queues or sequence numbers; Redis streams are a popular option.
- **Celebrity fan-out**: Cache once, then distribute through regional or hierarchical layers.
- **Message ordering**: For product designs, send related messages through one server or partition.

---
*Source: [https://www.hellointerview.com/learn/system-design/patterns/realtime-updates/quick-reference](https://www.hellointerview.com/learn/system-design/patterns/realtime-updates/quick-reference)*
