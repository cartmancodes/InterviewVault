# Design Robinhood

> **Pattern**: Trading / Real-time Prices
> **Difficulty**: Hard
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/robinhood)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   1. [Order Routing to the Exchange](#1-order-routing-to-the-exchange)
   2. [Real-Time Price Feed Fanout](#2-real-time-price-feed-fanout)
   3. [Consistency of Balances and Positions](#3-consistency-of-balances-and-positions)
   4. [Market-Open Bursts and Load Shedding](#4-market-open-bursts-and-load-shedding)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
   - [Stage 1: 0 to 100 Users (MVP)](#stage-1-0100-users-mvp)
   - [Stage 2: 100 to 1,000 Users](#stage-2-1001000-users)
   - [Stage 3: 1K to 100K Users](#stage-3-1k100k-users)
   - [Stage 4: 100K to 10M Users](#stage-4-100k10m-users)
   - [Stage 5: 10M+ Users](#stage-5-10m-users)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Robinhood is a retail brokerage app: users watch prices tick in real time and submit market or limit orders that are ultimately filled at an external exchange (NYSE, Nasdaq, or a market maker). The design is hard for two reasons: (1) price data is a firehose that must be fanned out with sub-second latency to millions of phones, and (2) orders touch money, so we need strong consistency and idempotency even when the system is under market-open stress. Critically, we are not building the exchange; we are the broker that holds user accounts, routes orders, and displays state.

### Functional Requirements

**Core**
- Users can view live prices for stocks they follow, updated as trades happen on the exchange.
- Users can place orders: both market orders (fill at best available price) and limit orders (fill only at or better than a target price).
- Users can cancel open orders before they are filled.
- Users can see the status of their orders (pending, partially filled, filled, canceled, rejected) and their resulting positions.

**Out of scope (below the line)**
- Trading outside regular market hours (pre/post-market).
- Options, ETFs, mutual funds, and cryptocurrency.
- Full order-book depth visibility (Level 2 data).
- Margin, short selling, and complex derivatives.
- Tax lots, wash-sale tracking, and regulatory reporting beyond core trade records.

### Non-Functional Requirements

**Core**
- Price fanout latency from exchange trade event to client UI under ~200 ms at the p95.
- Strong consistency on balances and positions: a user must never spend the same cash twice or sell shares they do not own.
- High availability during market hours (9:30 AM to 4:00 PM ET); the cost of an outage is direct dollar loss and regulatory exposure.
- Durability of every order and fill event; audit trail must survive any single-node failure.
- Elastic capacity for the market-open spike, when order volume can be 10x a normal minute.
- Idempotent order submission so retries from a flaky mobile network never double-place an order.

**Out of scope**
- Ultra-low-latency HFT-grade order routing (microseconds). Robinhood is retail; milliseconds are fine.
- Multi-region active-active for US equities (exchange is in NY, so single-region active with DR is acceptable).

---

## Core Entities

- **User / Account** - identity, KYC status, buying power (cash available), total equity. One user typically has one brokerage account.
- **Stock (Symbol)** - reference data about a ticker: symbol, name, exchange, lot size. Relatively static.
- **Quote (Tick)** - the latest trade event for a symbol: last price, size, timestamp, bid, ask. High write, high read, short shelf life.
- **Order** - a user's intent to buy or sell: userId, symbol, side (buy/sell), type (market/limit), quantity, limitPrice, status, createdAt, clientOrderId (for idempotency), externalOrderId (from the exchange).
- **Fill (Execution)** - a partial or full execution of an order: orderId, price, quantity, timestamp. An order can have multiple fills.
- **Position** - a user's current holding for a symbol: userId, symbol, quantity, averageCost. Derived from the stream of fills.
- **Balance Ledger Entry** - append-only record of cash movements: debit on buy fill, credit on sell fill, holds on open buy orders. The source of truth for buying power.

---

## API Design

All APIs are HTTPS and authenticated with a session token. Price streaming is a separate WebSocket channel.

```
GET  /v1/stocks/{symbol}
     -> static reference data plus the latest cached quote

GET  /v1/stocks/{symbol}/quote
     -> one-shot latest price (for cold loads)

WS   /v1/stream/prices
     client subscribes: { action: "subscribe", symbols: ["AAPL", "TSLA"] }
     server pushes: { symbol, price, size, bid, ask, ts }

POST /v1/orders
     body: { clientOrderId, symbol, side, type, quantity, limitPrice? }
     -> { orderId, status: "pending" }
     Header: Idempotency-Key: <clientOrderId>

GET  /v1/orders/{orderId}
     -> full order state with fills

GET  /v1/orders?status=open
     -> list user's open orders

DELETE /v1/orders/{orderId}
     -> attempts cancel; returns updated status

GET  /v1/positions
     -> list of { symbol, quantity, averageCost, currentPrice }

GET  /v1/account
     -> { cash, buyingPower, equity }
```

The POST /v1/orders endpoint is synchronous from the client's perspective but internally it only guarantees the order is durably accepted; the actual fill arrives asynchronously over the WebSocket (or by polling GET /v1/orders/{orderId}).

---

## High-Level Design

There are two fundamentally different data paths, and keeping them separate is the central architectural choice.

**Path A: Price Fanout (read-heavy, eventually consistent)**
1. A **Market Data Ingestor** holds persistent connections to the exchange's trade feed (e.g., SIP / direct exchange feeds).
2. Each trade event is normalized and published to a **Price Bus** (Kafka topic keyed by symbol, or Redis Pub/Sub for lowest latency).
3. **WebSocket Gateway** nodes subscribe to the bus and push updates to connected clients that have registered interest in specific symbols.
4. The last tick per symbol is also written to a **Quote Cache** (Redis) so cold HTTP reads get sub-10ms latency.

**Path B: Order Management (write-heavy, strongly consistent)**
1. **API Gateway** authenticates and rate-limits.
2. **Order Service** validates the order (symbol exists, user has buying power / shares) against the **Account Service** and its **Postgres** store, inside a transaction. A cash hold is placed for buy orders, a share hold for sells.
3. The accepted order is durably written and then forwarded to the **Order Router**, which speaks FIX (or the broker's REST API) to the exchange or market maker.
4. The exchange asynchronously sends back fill events. An **Execution Handler** consumes these, updates the order, writes fills to the ledger, and moves cash/shares from "held" to "settled."
5. A notification is pushed to the user over the same WebSocket gateway used for prices.

The two paths share only the WebSocket gateway layer, which multiplexes price ticks and per-user order events over a single connection.

---

## Deep Dives

### 1. Order Routing to the Exchange

**The problem.** Robinhood is a broker, not an exchange. After we accept an order, we must hand it off to an external venue (NYSE, Nasdaq, Citadel, Virtu) and track its lifecycle. Network failures and partial outages cannot produce duplicate or lost orders.

**Approach.**
- **Idempotency at the edge.** The client generates a UUID `clientOrderId` and sends it with every retry. The Order Service uses it as a unique constraint in Postgres, so retries collapse into a single insert.
- **Durable accept before route.** We commit the order row (status=PENDING) and a cash/share hold in the same Postgres transaction, then publish an `order.accepted` event to Kafka. Only after the commit do we respond 200 to the user. If the process dies now, a recovery worker resumes routing from Kafka.
- **Order Router as a stateful consumer.** Router instances read from Kafka (partitioned by `orderId` so each order is owned by one consumer), then send FIX messages to the exchange. The router tracks an in-memory state machine per order and keeps a correlation map `exchangeSessionId -> orderId`.
- **Exchange acks are the source of truth for fills, not for acceptance.** Our DB says the order exists; the exchange tells us what actually traded. We reconcile the two with a periodic drop-copy feed and a nightly recon job.
- **Cancel races.** A user can tap cancel after the order has already been filled. The router sends the cancel, but the exchange may reply "too late, filled." We treat the exchange's response as authoritative and surface the outcome.

**Why not call the exchange synchronously from the request handler?** Because exchange RTT can spike to seconds, and tying the user's HTTP connection to the exchange socket couples two very different SLAs. Kafka-in-the-middle lets us accept orders at 99.99% availability even when the exchange is slow.

### 2. Real-Time Price Feed Fanout

**The problem.** A single symbol like TSLA can produce thousands of ticks per second. We have millions of clients, each subscribed to a handful of symbols. Naive broadcast to every client for every tick would melt the fleet.

**Approach.**
- **Single writer per symbol.** To avoid reorder, each symbol is owned by exactly one ingestor instance (consistent hashing over symbol). This instance is the only one that publishes ticks for that symbol to the bus.
- **Pub/Sub with sharded topics.** Ticks go into Kafka or Redis Pub/Sub topics partitioned by symbol. WebSocket Gateways subscribe only to the topics for symbols their connected clients care about, minimizing cross-traffic.
- **Interest maps on the gateway.** Each gateway maintains `symbol -> [connectionIds]`. When a tick arrives, it walks the list and pushes to each socket. For hot symbols (TSLA, AAPL, NVDA), this list can be huge - we shard by taking `hash(connectionId) % N` so a symbol is owned by several gateways.
- **Coalescing under pressure.** If a client is slow (mobile on 3G), we do not buffer unbounded ticks. We keep only the latest tick per symbol for that connection and drop older ones. Users do not need every tick; they need the current price.
- **Quote cache.** The latest tick per symbol lives in Redis with a short TTL so HTTP `GET /quote` does not need to hit the bus.
- **Binary framing.** At scale, JSON over WebSocket is wasteful. Protobuf or a compact custom frame cuts bandwidth by 3-5x.

### 3. Consistency of Balances and Positions

**The problem.** Money is real. If two buy orders race for the same $1,000 of buying power, at most one must succeed. After a fill, the position must reflect the new share count without drift, even if components crash mid-update.

**Approach.**
- **Account Service with a relational core.** Postgres (or a similar ACID store) holds the canonical account row: `cash`, `held_cash`, `version`. Every order placement is a serializable transaction: read current balance, verify `cash - held_cash >= order_value`, bump `held_cash`, insert the order row, bump `version`. Optimistic concurrency (version check) handles retries cleanly.
- **Event sourcing for the ledger.** Rather than mutate position rows in place, we append events: `order_placed`, `cash_held`, `fill_received`, `cash_released`, `shares_credited`. The current position and cash are computed by folding these events. This gives us an immutable audit trail and makes it trivial to replay or investigate disputes.
- **Materialized views for reads.** A projection process consumes the event stream and maintains a denormalized `positions` and `account_snapshot` table for fast `GET /positions` reads. The user tolerates a second or two of lag on this view; the authoritative ledger is always consistent.
- **Fills are reconciled, not trusted blindly.** The execution handler processes exchange fill messages idempotently (keyed by exchange fill ID). If a fill arrives for $100 but we only held $90 (due to price slippage between placement and fill for a market order), we have explicit policy: accept the overage, because we already sized the hold with a buffer, or otherwise flag for risk review.
- **Nightly reconciliation.** Compare internal ledger totals against the clearing firm's records. Any drift is a bug we must find before morning.

### 4. Market-Open Bursts and Load Shedding

**The problem.** At 9:30:00 AM ET, order and quote volume can be 10-50x baseline. Many users pre-queue orders overnight. A naive system will saturate its DB connections, exhaust its Kafka producers, and take down both the order path and the price path.

**Approach.**
- **Pre-warm everything.** Auto-scaling groups for API, Order Service, and WebSocket Gateways scale up on a schedule starting at 8:45 AM. Cold-start lag at market open is catastrophic, so we pay for headroom.
- **Asynchronous pipeline with bounded queues.** The Order Service's only synchronous work is validation, hold placement, and Kafka publish. Routing to the exchange is async. This shields the user-facing path from exchange slowness.
- **Per-user rate limits.** A single user cannot submit 1,000 orders per second. Token bucket per userId at the API gateway, enforced in Redis.
- **Priority queues for order pipeline.** Cancel orders get their own Kafka topic / partition with higher consumer priority, because a stuck cancel has regulatory consequences. New orders are best-effort fast.
- **Load shedding on the price path.** If WebSocket Gateways approach CPU limits, we shed by (a) reducing tick frequency per symbol to a cap (e.g., 10/sec even if the exchange ticks 500/sec), (b) temporarily disconnecting idle clients, (c) serving HTTP quote reads from the stale Redis cache with a banner.
- **Queued-order smoothing.** Overnight-queued orders are released in a randomized 30-second window around 9:30 AM rather than all at once, smoothing the spike into a manageable ramp.
- **Backpressure on Kafka producers.** If Kafka ack lag exceeds threshold, the Order Service returns 503 with Retry-After rather than accepting orders it cannot durably commit.
- **Clear user-visible degradation.** If we cannot accept a new order, we say so. Silent failure or a spinner during market open destroys trust.

---

## Scaling Journey: 0 to Infinity

This is my own walkthrough of how I would evolve a Robinhood-style broker from weekend prototype to a venue serving tens of millions of active traders. Each stage names the bottleneck that forced the next step.

### Stage 1: 0 to 100 Users (MVP)

**Goal.** Prove the product: a user can see a price and place an order that actually hits an exchange.

**Architecture.** One monolith behind a load balancer. A single Postgres holds users, orders, fills, and positions. A single worker polls the exchange's REST quote endpoint every second for each watched symbol and stores the latest price in Postgres. Order placement is a synchronous HTTP call from the monolith to the exchange's REST API; we block the user until we get an accept back. The mobile app long-polls `/positions` and `/quotes`.

**What you skip.** No Kafka. No Redis. No WebSockets. No event sourcing. No separate services.

**Failure mode that forces the next stage.** Polling the exchange every second per symbol does not scale past a few dozen symbols, and the UI feels laggy compared to real trading apps. We need push, not pull.

### Stage 2: 100 to 1,000 Users

**Goal.** Make prices feel live and decouple order routing from the user request.

**Architecture.** Introduce a **Market Data Ingestor** process that holds a streaming connection to the exchange's trade feed and writes the latest tick per symbol into **Redis** (one key per symbol). The API server reads quotes from Redis. Add a simple **WebSocket server** that clients connect to; it also subscribes to Redis Pub/Sub on symbol channels and pushes ticks to interested clients. Orders still go through the monolith, but exchange calls move into a background worker fed by a Postgres-backed job queue; the HTTP handler now just persists the order with status=PENDING and returns immediately.

**What you skip.** Still no Kafka. Still one Postgres. No sharding, no event sourcing, no multi-region.

**Failure mode that forces the next stage.** The single monolith and single Postgres start to get hot. More importantly, synchronous order placement with a DB-polled job queue has terrible latency and recovery semantics, and Redis Pub/Sub drops messages under load with no replay.

### Stage 3: 1K to 100K Users

**Goal.** Split the read and write paths, make the order pipeline durable, and survive component failures.

**Architecture.** Break the monolith into **Account Service**, **Order Service**, **Execution Handler**, and **Market Data Service**. Introduce **Kafka** as the spine: Order Service writes order-accepted events to a Kafka topic, Order Router consumers read and send FIX to the exchange, the Execution Handler consumes the exchange fill stream and writes to Postgres. Price ticks move from Redis Pub/Sub to Kafka for durability and replay, with Redis still caching the latest tick per symbol for HTTP reads. WebSocket Gateways become a dedicated fleet behind a load balancer with sticky sessions. Postgres gets a read replica for GET-heavy endpoints. Introduce idempotency-key support on POST /orders.

**What you skip.** Still single-writer Postgres for orders. No event sourcing yet. No per-symbol single-writer sharding of the ingestor. No multi-region.

**Failure mode that forces the next stage.** Market-open spikes start overwhelming the shared Postgres. Hot symbols like TSLA create hotspots in the price fanout - one Kafka partition for that symbol means one consumer and one WebSocket node becomes a bottleneck. Balance-verification transactions block each other under contention.

### Stage 4: 100K to 10M Users

**Goal.** Shard by user for the write path, shard by symbol for the price path, and make the ledger an event-sourced system of record.

**Architecture.**
- **Account sharding.** Partition the Account Service's Postgres by `userId` hash. Each shard owns a slice of users, their orders, holds, and balances. Cross-user operations are rare in trading, so this works cleanly.
- **Event sourcing for the ledger.** All cash and share movements become immutable events in Kafka. The account DB is a projection of the event log; positions and balances are materialized views maintained by a projector service. This gives us audit, replay, and the ability to reconstruct any user's state at any point in time.
- **Per-symbol single writer.** The Market Data Ingestor is sharded: a symbol has exactly one owning instance using consistent hashing. This eliminates out-of-order ticks without cross-node coordination.
- **WebSocket Gateway tier scales independently.** Gateways subscribe to Kafka topics for symbols their connected clients care about. For hot symbols, we fan out to many gateway instances via a broadcast-style consumer group configuration.
- **Redis Cluster** for quote cache and per-user rate limiting.
- **Dedicated cancel path** with its own Kafka partition and consumer group, prioritized over new orders.

**What you skip.** Still single-region (US equities trade in one region; DR is cold-standby cross-region, not active-active). No user-facing options/crypto. No custom exchange of our own.

**Failure mode that forces the next stage.** Market-open still produces queueing delays that users notice. Hot-symbol fanout approaches gateway CPU ceilings. Regulators and finance demand second-by-second reconciliation.

### Stage 5: 10M+ Users

**Goal.** Keep p95s sane during the 9:30 AM spike, saturate network before CPU, and harden against correlated failures.

**Architecture.**
- **Scheduled pre-scaling** of all tiers starting 45 minutes before market open.
- **Load shedding policies** at each layer: tick-rate caps per symbol on the gateway, per-user order rate limits at the API, 503-with-retry when Kafka producer lag exceeds SLO.
- **Queued-order smoothing.** Overnight-queued orders are released over a randomized 30-second window starting at 9:30:00 so we do not create a thundering herd.
- **Binary wire protocol** (protobuf or custom) on the WebSocket to cut bandwidth per client by 3-5x; JSON remains for debug endpoints.
- **Cross-region warm standby** for the order stack with continuous Kafka mirroring so we can fail over within minutes if the primary region goes dark mid-session.
- **Real-time reconciliation pipeline** comparing our internal event log to the clearing broker's drop-copy feed every few seconds, flagging drift to an on-call queue.
- **Tiered quote service.** Free users get ticks coalesced to 1/sec per symbol. Paid / active users get full tick rate. This is both a business model and a load-management lever.
- **Kill switches** per subsystem. If the Execution Handler goes haywire, we can stop consuming fills from a specific exchange without dropping the rest of the platform.

At this point the interesting engineering is less about scale and more about safety: the system is large enough that any change is a potential market incident, and the deploy and rollback story matters as much as the code.

---

## Expected Depth by Level

| Area | Mid-level | Senior | Staff+ |
| --- | --- | --- | --- |
| Functional scoping | Cover prices, orders, cancels. | Call out market vs limit, idempotency, partial fills, the broker-vs-exchange distinction. | Explicitly negotiate out-of-scope (options, crypto, after-hours) with reasoning; surface regulatory and reconciliation requirements. |
| API design | REST for orders and account; note WebSocket for prices. | Clean idempotency keys, status transitions, separate read endpoints for positions vs orders, auth and rate limiting. | Design the WebSocket envelope, subscription model, binary framing, and backpressure semantics; discuss clock sync and event ordering contracts. |
| Core architecture | One service, Postgres, Redis, WebSocket. | Two distinct paths (price fanout vs order management), Kafka between order accept and exchange routing. | Sharding strategy (user-hash vs symbol-hash), event sourcing for the ledger, per-symbol single-writer ingestor, kill switches and deploy safety. |
| Real-time prices | Mention WebSockets and a quote cache. | Pub/Sub fanout, interest maps on the gateway, coalescing slow clients, Redis for latest tick. | Hot-symbol sharding, protobuf framing, tick-rate caps as a load-shedding lever, cross-region failover for the feed. |
| Consistency | Note ACID Postgres for balances. | Cash holds on order placement, idempotent fill processing, optimistic concurrency on accounts. | Event-sourced ledger as system of record, reconciliation against clearing broker, policy for slippage and overfills, replay for disputes. |
| Market-open / scaling | Acknowledge spikes exist. | Async order pipeline, rate limits, pre-warming. | Randomized release of queued orders, priority queues for cancels, tiered quote rates by user class, end-to-end load-shedding playbook. |
| Failure modes | Handles "server crashes." | Retries, exchange timeouts, duplicate-order prevention via clientOrderId. | Partial exchange outages, cancel-vs-fill races, multi-region DR strategy, per-subsystem kill switches, observability and on-call runbooks. |
