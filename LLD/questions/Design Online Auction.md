# Design Online Auction

> **Pattern**: Ordered Writes / Real-time
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/online-auction)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   1. [Bid Ordering and Strong Consistency](#1-bid-ordering-and-strong-consistency)
   2. [Fairness Under Burst Traffic](#2-fairness-under-burst-traffic)
   3. [Real-time Price Updates to Viewers](#3-real-time-price-updates-to-viewers)
   4. [Auction-closing Race Conditions](#4-auction-closing-race-conditions)
   5. [Durability and Fault Tolerance of the Bid Log](#5-durability-and-fault-tolerance-of-the-bid-log)
6. [Scaling Journey: 0 to infinity](#scaling-journey-0-to-infinity)
   - [Stage 1: 0 to 100 Users (MVP)](#stage-1-0100-users-mvp)
   - [Stage 2: 100 to 1,000 Users](#stage-2-1001000-users)
   - [Stage 3: 1K to 100K Users](#stage-3-1k100k-users)
   - [Stage 4: 100K to 10M Users](#stage-4-100k10m-users)
   - [Stage 5: 10M+ Users](#stage-5-10m-users)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

An online auction is a classic eBay-style problem where sellers list items with a starting price and end time, bidders place monetary bids, and the highest valid bid at the close wins the item. The hard part is not the data model, which is tiny, but the ordered-write semantics of bids. For any given auction, bids must be serialized into one true sequence, because the correctness of the entire system depends on a single question: which bid arrived first? Two bidders separated by a few milliseconds can disagree forever about who bid $51 first, and the system must pick an answer and stick with it.

The second pressure comes from the read side. A popular auction can have thousands or even millions of passive viewers whose screens must update when the price changes, within a second or so, to keep the experience feeling live. That pushes us toward a push-based fanout model rather than polling. Finally, every auction has a cliff-edge at closing time, where bids arriving a millisecond before or after the deadline can flip the outcome; the system has to be unambiguous about what counts.

### Functional Requirements

**In scope:**

- A seller can list an item for auction with a starting price and an end time.
- A bidder can place a bid on an active auction. The bid is accepted only if it is strictly higher than the current highest bid.
- Any user can view an auction page showing the item, the current highest bid, the current bidder (or their handle), and the time remaining. The displayed price updates in near real time as new bids arrive.

**Out of scope:**

- Search, browse, filter, and category pages.
- Payment capture, shipping, and fulfillment after a win.
- Bid retraction, auction cancellation, reserve prices, and proxy bidding (auto-bid up to max).
- User registration, auth, and reputation systems.
- Bid history pagination.

### Non-Functional Requirements

- **Strong consistency on bids**: for any auction, the accepted bids form a single totally ordered sequence, monotonically increasing in price. No two bids may be accepted at the same price; none may be lost.
- **Low write latency**: placing a bid should feel instantaneous, ideally under 200 ms end-to-end, so the last-second flurry works.
- **Real-time read fanout**: price updates reach connected viewers within ~1 second of the accepted bid. A few seconds of staleness is tolerable for users who are merely browsing, but not for active bidders.
- **Durability**: once a bid is acknowledged to the client, it must survive a datacenter failure. Losing the winning bid is unacceptable.
- **Availability and burst tolerance**: a popular auction can go from a handful of viewers to hundreds of thousands in the final minute. The system must absorb bursts without dropping bids.
- **Scale targets**:
  - 10M registered users, 1M active auctions at any moment.
  - ~1k bids/sec average across the system, with a single hot auction producing several hundred bids/sec at the deadline.
  - ~1M concurrent WebSocket viewers aggregated, tens or hundreds of thousands on a single auction.

---

## Core Entities

| Entity | Description | Notes |
|---|---|---|
| **User** | A person who can list, view, or bid. Identified by `userId`. | Sellers and bidders are just roles of the same entity. |
| **Item** | The physical or digital good being auctioned. Has `itemId`, title, description, images. | Immutable for the duration of the auction. |
| **Auction** | Wraps an item with auction mechanics: `auctionId`, `itemId`, `sellerId`, `startingPrice`, `currentPrice`, `highestBidderId`, `startTime`, `endTime`, `status`. | `currentPrice` and `highestBidderId` are the contended fields; everything else is effectively read-only. |
| **Bid** | An attempt by a user to offer a price. Has `bidId`, `auctionId`, `bidderId`, `amount`, `timestamp`, `status` (accepted or rejected). | Append-only. The accepted bids for an auction form its price history. |

The surface is small. The tension is that `Auction.currentPrice` is a single contended cell for each auction, while `Bid` is an append-only log keyed by `auctionId`. These two views of the same truth must stay consistent.

---

## API Design

```
POST /auctions
Body: { "itemId": "...", "startingPrice": 10.00, "endTime": "2026-05-01T20:00:00Z" }
-> 201 Created { "auctionId": "...", "status": "ACTIVE" }
```

Creates an auction. The `startingPrice` becomes the initial `currentPrice` and there is no highest bidder yet.

```
GET /auctions/{auctionId}
-> 200 OK { "auctionId": "...", "itemId": "...", "currentPrice": 57.00,
            "highestBidderId": "...", "endTime": "...", "status": "ACTIVE" }
```

Returns the current snapshot. This is the REST fallback when a viewer first loads the page, before the WebSocket takes over.

```
POST /auctions/{auctionId}/bids
Body: { "amount": 58.00 }
-> 201 Created { "bidId": "...", "status": "ACCEPTED", "currentPrice": 58.00 }
-> 409 Conflict { "status": "REJECTED", "reason": "TOO_LOW", "currentPrice": 60.00 }
-> 410 Gone    { "status": "REJECTED", "reason": "AUCTION_CLOSED" }
```

The bid endpoint is the heart of the system. It either linearizes the bid into the auction's sequence and returns the new price, or tells the client why it was rejected. The client learns the current price from the 409 response so it can retry intelligently.

```
GET /auctions/{auctionId}/stream   (WebSocket or SSE upgrade)
-> pushes { "type": "PRICE_UPDATE", "currentPrice": ..., "highestBidderId": ..., "ts": ... }
-> pushes { "type": "AUCTION_CLOSED", "winnerId": ..., "finalPrice": ... }
```

Subscribes a viewer to the auction's event feed. The server pushes price updates and the final close event; clients never poll.

---

## High-Level Design

The architecture has four responsibilities: accept bids in order, persist them durably, broadcast accepted price changes to viewers, and close auctions atomically at `endTime`.

1. **API Gateway** terminates HTTP and WebSocket connections and routes by `auctionId`. For WebSocket traffic, it uses consistent hashing on `auctionId` so all viewers of the same auction end up on the same pool of servers, which keeps fanout local.

2. **Auction Service** handles auction CRUD (list, get snapshot). It reads `Auction` rows from the database, cached in Redis for hot items. It is effectively stateless.

3. **Bid Service** handles `POST /bids`. This is the critical write path. Its job is to take a bid, decide whether it beats the current price, and if so update both the authoritative record and emit an event. It enforces the total ordering guarantee.

4. **Database (Postgres)** is the system of record. Two tables matter: `auctions` (one row per auction with `current_price`, `highest_bidder_id`, `version`) and `bids` (append-only, one row per bid attempt, accepted or rejected, with server-assigned timestamp and monotonic sequence number per `auctionId`).

5. **Redis** serves two roles. First, it caches the current `Auction` snapshot so viewer page loads skip the database. Second, at higher scale it becomes the atomic bid arbitrator using a Lua script that compares-and-sets `currentPrice` in a single round trip; see the deep dive.

6. **Event Bus (Kafka)** carries a stream per auction (or per-auction partition key). When the Bid Service accepts a bid, it produces a `BidAccepted` event. Fanout Service instances consume these events and push updates to connected WebSocket clients.

7. **Fanout Service** maintains WebSocket connections and subscribes to the event bus. Because gateway routing sends all viewers of a given auction to the same fanout-service shard, each accepted bid event needs only one Kafka consumer on that shard to push to all local subscribers.

8. **Auction Closer** is a scheduled component that transitions auctions from ACTIVE to CLOSED at `endTime`. At low scale it is a cron job polling for due auctions; at high scale it is a timer wheel or a delayed-job queue (e.g., Redis sorted set keyed by `endTime`).

The bid write path is where correctness lives. The read and fanout path is where scale lives. The closer is where the edge case lives.

---

## Deep Dives

### 1. Bid Ordering and Strong Consistency

A bid is accepted only if its amount is strictly greater than the current highest. Two bids arriving within a millisecond for the same auction must be evaluated sequentially, and the second one must see the first one's effect. This is a classic read-modify-write.

The simplest correct implementation is a single-row pessimistic lock in Postgres:

```sql
BEGIN;
SELECT current_price, version FROM auctions WHERE id = $1 FOR UPDATE;
-- application checks: new_bid > current_price AND now() < end_time
UPDATE auctions SET current_price = $2, highest_bidder_id = $3, version = version + 1
  WHERE id = $1;
INSERT INTO bids (auction_id, bidder_id, amount, status, seq) VALUES (...);
COMMIT;
```

`SELECT FOR UPDATE` serializes all bidders on that auction through the row lock. Correct, simple, and it performs fine at tens of bids per second per auction. Optimistic concurrency control (check `version` in the UPDATE's WHERE clause and retry on zero-row update) is an alternative that avoids the lock hold during the network round trip.

At higher contention, the database row lock becomes the bottleneck. The next step is to move the arbitration into Redis with an atomic Lua script:

```
-- KEYS[1] = auction key, ARGV[1] = new_amount, ARGV[2] = bidder_id, ARGV[3] = now
local cur = redis.call('HGET', KEYS[1], 'current_price')
if tonumber(ARGV[1]) <= tonumber(cur) then return {0, cur} end
redis.call('HSET', KEYS[1], 'current_price', ARGV[1], 'highest_bidder_id', ARGV[2])
return {1, ARGV[1]}
```

Redis executes this script single-threaded per key, giving exact linearizability for that auction. The Bid Service, on success, synchronously produces a Kafka event and asynchronously persists the accepted bid to Postgres. Redis becomes the source of truth for "current price right now" and Postgres becomes the durable log, reconciled by replay.

### 2. Fairness Under Burst Traffic

A popular auction's final 30 seconds is a thundering herd. If the system accepts bids from whichever server happens to win the race, fairness (bids are processed roughly in the order the bidders pressed the button) degrades. Three mechanisms help.

First, assign a server-side receive timestamp at the Bid Service entry, before any locking or queueing. This timestamp, not wall-clock of the database write, is the bid's logical arrival time. It goes into the `bids` table and is the tiebreaker if two bids have the same amount (which in our model is a rejection, but still useful for audit).

Second, funnel all bids for a given auction through a single writer. In the Kafka-based design, use `auctionId` as the partition key so all bids for one auction go to one partition and are processed by one consumer. This makes ordering intrinsic to the transport rather than something the database has to enforce. A single-writer partition at tens of thousands of events per second is well within Kafka's envelope.

Third, smooth the spike with a short in-memory queue at the Bid Service. Rather than letting 500 concurrent Postgres transactions all fight over one row, serialize them through a per-auction queue in the process and process them one at a time. Client-visible latency rises from 20 ms to maybe 200 ms under the worst bursts, but no bid is dropped and processing order matches arrival order.

### 3. Real-time Price Updates to Viewers

Viewers want the price to update within a second of a bid landing. Polling does not scale: a hundred thousand viewers refreshing every second is a hundred thousand GETs per second for one auction.

WebSockets (or SSE for one-way streams) invert the model. A viewer opens a persistent connection to a Fanout Service instance. The gateway routes the connection by `auctionId` using consistent hashing, so all viewers of the same auction land on the same fanout shard, say two or three nodes for redundancy. Each fanout node subscribes to the Kafka partition for the auctions it handles.

When the Bid Service accepts a bid, it emits `BidAccepted(auctionId, newPrice, bidder, ts)`. The fanout node consumes that event and iterates over its local map of `auctionId -> Set<WebSocketConnection>`, writing the update to each. With tens of thousands of local connections per auction and a few-hundred-byte payload, this is a few megabits of outbound traffic per event on that node, which a modern server handles without strain.

For the long tail of viewers on flaky networks, clients reconnect with a `lastSeenTs`, and the server replays missed events from a short Redis ring buffer per auction. The REST `GET /auctions/{id}` remains available as the cold-start fallback.

### 4. Auction-closing Race Conditions

Auctions close at `endTime`. A bid submitted at `endTime - 1ms` should win; a bid submitted at `endTime + 1ms` must lose. Both clocks (client's and server's) are suspect, so the server's clock is authoritative and the check happens inside the same critical section as the bid arbitration.

In the Redis Lua script, extend the check:

```
local endTime = redis.call('HGET', KEYS[1], 'end_time')
if tonumber(ARGV[3]) >= tonumber(endTime) then return {0, 'CLOSED'} end
```

This guarantees that the close check and the bid update are atomic with respect to each other. There is no window where one bidder sees "still open" and updates while another sees "closed" and rejects.

The asynchronous closer is a separate concern. A worker (or a Redis ZADD-based delayed queue keyed on `endTime`) fires at `endTime`, performs one final atomic operation that sets `status = CLOSED` in Redis, then persists the final state to Postgres and emits `AuctionClosed`. If a bid's Lua execution lost the race by microseconds, the closer's CAS wins and the bid is rejected. If the closer crashes, a second worker picks up the lease from the ZADD queue and completes the close; the atomic CAS makes repeated attempts safe.

One subtle extension seen in real auctions is soft close: if a bid arrives in the last 30 seconds, extend `endTime` by 30 seconds. This is a simple HINCRBY on the end time inside the same Lua script, with the same atomicity guarantee.

### 5. Durability and Fault Tolerance of the Bid Log

Accepting a bid in Redis and acknowledging to the client before Postgres has it risks data loss if Redis goes down. Two defenses.

First, use Redis with AOF persistence set to `appendfsync everysec` (or `always` at the cost of throughput) plus a replica in a separate availability zone, so a node failure loses at most a second of accepted bids.

Second, and more importantly, write the accepted bid to Kafka synchronously before ACKing the client. Kafka with `acks=all` and replication factor 3 gives durable storage with low-millisecond latency. The write order is: Redis Lua arbitrates -> Bid Service publishes to Kafka with `acks=all` -> Bid Service ACKs the client. Postgres then consumes the Kafka stream and updates itself asynchronously. Redis can be rebuilt from Kafka at startup, so Redis is a cache of state, not the system of record; Kafka is the log, and Postgres is the queryable projection.

---

## Scaling Journey: 0 to infinity

### Stage 1: 0 to 100 Users (MVP)

**Goal**: prove the product. One small auction house, a few dozen listings a day, at most a handful of bids per minute per auction.

**Architecture**: a single monolithic service on one box. Postgres on the same or a neighboring instance. Bids are handled with `SELECT FOR UPDATE` inside a transaction. No Redis, no Kafka, no WebSocket; the web page polls `GET /auctions/{id}` every 5 seconds.

**What you skip**: caching, event bus, real-time fanout, fancy locking, auction-closer worker (a cron job that runs every 10 seconds is fine).

**Failure mode that forces the next stage**: one auction goes viral and suddenly 500 people are polling every 5 seconds. Database load spikes, and the polling feels laggy. Time to push rather than pull.

### Stage 2: 100 to 1,000 Users

**Goal**: handle a few hundred simultaneous viewers per auction with a live-updating UI, without melting Postgres.

**Architecture**: introduce a Redis cache for `GET /auctions/{id}` so viewer page refreshes do not hit Postgres. Add a WebSocket server process that subscribes to a simple Postgres `LISTEN/NOTIFY` channel the monolith publishes on after each accepted bid. The bid path is still `SELECT FOR UPDATE`; it is correct, just slow under contention.

**What you skip**: Kafka (LISTEN/NOTIFY is enough), sharding, multi-region, gateway-level consistent hashing (one WebSocket box handles all connections).

**Failure mode that forces the next stage**: at 1,000+ concurrent viewers on a single auction, LISTEN/NOTIFY starts dropping messages under load, and the single WebSocket node can no longer hold all the TCP connections. The row lock on hot auctions also becomes visibly slow in the final minute.

### Stage 3: 1K to 100K Users

**Goal**: handle a few hot auctions per day with thousands of concurrent viewers and bursty last-minute bidding.

**Architecture**: split the monolith into Auction Service, Bid Service, and Fanout Service. Introduce Kafka as the event bus with `auctionId` as the partition key so all bids for one auction are ordered by a single partition. The Bid Service still uses Postgres `SELECT FOR UPDATE` for correctness, but introduces a per-auction in-memory serialization queue inside the Bid Service process to keep contention off the database when a hot auction spikes. The Fanout Service runs on multiple nodes; the API gateway uses consistent hashing on `auctionId` to pin all WebSocket viewers of one auction to the same fanout node. Add a delayed-job queue (Redis ZSET keyed on `endTime`) for auction closing.

**What you skip**: Redis-based bid arbitration, sharded auction databases, cross-region replication.

**Failure mode that forces the next stage**: a truly hot auction generates hundreds of bids per second in the closing seconds. Postgres `SELECT FOR UPDATE` on a single row tops out around 200-300 transactions per second with WAL fsync. Bidders start seeing 1+ second latencies, and the system feels broken precisely when it should feel most alive.

### Stage 4: 100K to 10M Users

**Goal**: sustain hundreds of bids per second per auction and millions of concurrent viewers across the platform.

**Architecture**: move bid arbitration into Redis with the atomic Lua script described in deep dive 1. Redis is the hot path; Postgres becomes an asynchronous durable projection consumed from Kafka. Every accepted bid is written synchronously to Kafka with `acks=all` before the client receives an ACK, so durability does not depend on Redis staying up. Shard the auction services by `auctionId`; a consistent-hash ring maps each auction to one Bid Service leader and one Redis shard. Viewers of a given auction still land on one Fanout Service node via gateway routing. The Auction Closer graduates from a polled ZSET into a sharded timer-wheel service, each node responsible for the auctions whose `auctionId` hashes to it, with lease-based failover. Read replicas of Postgres serve `GET /auctions/{id}` when Redis misses.

**What you skip**: cross-region active-active, custom storage engines, CDN-fronted streaming.

**Failure mode that forces the next stage**: at tens of millions of users, a regional outage takes down whole auctions. The hottest Redis shards top out at around 100k ops/sec and one globally famous auction (a celebrity artwork, say) exceeds that. Latency from a bidder across the ocean is too high to feel live.

### Stage 5: 10M+ Users

**Goal**: global scale, multi-region, resilient to single-region failure, hero auctions with hundreds of thousands of concurrent viewers worldwide.

**Architecture**: pin each auction to a "home region" where its Bid Service leader and primary Redis shard live; all bids route there via the API gateway, which adds maybe 100-150 ms of latency for a distant bidder but preserves the single-writer invariant that makes bid ordering tractable. Viewer fanout is regional: regional Fanout Service clusters consume the auction's Kafka stream via geo-replication (MirrorMaker or equivalent) and push to local WebSocket clients, so the read path is low-latency everywhere even though writes are centralized per auction. For hero auctions that exceed a single Redis shard, further shard the single auction itself: split the ordered-bid log into an acceptance tier (many Redis instances each owning a range of bidder IDs, doing a fast local "is this bid even plausible?" reject) with a single coordinator that linearizes the surviving candidates. This is effectively a two-level filter: 99% of low bids are rejected locally without contending on the coordinator. Reconciliation between Redis and Postgres is continuous via Kafka consumers, with a dead-letter queue for any accepted-bid event that fails to project.

---

## Expected Depth by Level

| Level | What the interviewer wants to see |
|---|---|
| **Mid-level** | Clear articulation of the bid ordering problem and a correct single-node solution using `SELECT FOR UPDATE`. Sensible API design. Awareness that polling does not scale and that WebSockets are the right tool, even without designing the fanout layer in detail. Can reason about the closing-time race at a high level. |
| **Senior** | Drives the deep dives unprompted. Designs the Kafka partition-per-auction pattern for ordered writes. Chooses between pessimistic and optimistic concurrency with justification. Designs the WebSocket fanout with consistent-hash routing. Handles the closing race atomically. Understands durability requires synchronous Kafka write before client ACK, not just Redis persistence. |
| **Staff** | Reasons about Redis-based bid arbitration with Lua as a clean upgrade path and understands why Kafka is still required for durability underneath. Discusses soft-close, fairness under burst, and server-assigned timestamps explicitly. Designs multi-region with home-region pinning per auction and explains the latency/consistency trade-off. Can describe two-level filtering for hero auctions that exceed a single shard. Addresses failure recovery: Redis loss rebuilt from Kafka, closer failover via leases, reconciliation between cache and durable projection. |
