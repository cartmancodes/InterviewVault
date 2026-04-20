# Design Local Delivery Service (GoPuff-style)

> **Pattern**: Geospatial / Inventory
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/gopuff)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   1. [Nearby-DC Search with Travel Time](#1-nearby-dc-search-with-travel-time)
   2. [Inventory Consistency and Avoiding Overselling](#2-inventory-consistency-and-avoiding-overselling)
   3. [Scaling Availability Reads at 20k QPS](#3-scaling-availability-reads-at-20k-qps)
   4. [Geospatial Indexing Strategies](#4-geospatial-indexing-strategies)
   5. [Regional Sharding and Partitioning](#5-regional-sharding-and-partitioning)
6. [Scaling Journey: 0 to infinity](#scaling-journey-0-to-infinity)
   - [Stage 1: 0 to 100 Users (MVP)](#stage-1-0100-users-mvp)
   - [Stage 2: 100 to 1,000 Users](#stage-2-1001000-users)
   - [Stage 3: 1K to 100K Users](#stage-3-1k100k-users)
   - [Stage 4: 100K to 10M Users](#stage-4-100k10m-users)
   - [Stage 5: 10M+ Users](#stage-5-10m-users)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

GoPuff-style local delivery is an e-commerce system that operates out of small "dark stores" or micro-fulfillment distribution centers (DCs). Users in a geographic area open the app, see only the items that can reach them within roughly one hour, place an order, and have it delivered quickly. The challenge is that inventory is physical, finite, and localized: what a user in Manhattan sees differs from what a user in Brooklyn sees, and two users cannot both buy the last box of Cheetos at the same DC.

The problem sits at the intersection of two system-design patterns. The first is geospatial: we need to know which DCs can serve a given location quickly. The second is inventory management: we need strong consistency on stock decrements so we never promise an item we cannot deliver.

### Functional Requirements

**In scope:**
- A user can query item availability for their current location; the system returns items deliverable within one hour.
- A user can place an order containing one or more items. The order must succeed atomically or fail cleanly.

**Out of scope (by explicit design):**
- Product search and catalog browse.
- Payment processing.
- Driver dispatch and routing.
- Cancellations, refunds, and returns.
- User accounts, authentication, and profile management.

### Non-Functional Requirements

- **Latency**: Availability queries must return in under 100 ms at p99 so the app feels instant as the user scrolls.
- **Consistency**: Strong consistency on inventory writes. We must never sell the same physical unit twice.
- **Scale targets**:
  - 10,000 distribution centers.
  - 100,000 catalog items (SKUs).
  - ~10 million orders per day (~115 orders/sec average, likely several times that at peak).
  - ~20,000 availability queries/second (assuming a 10% conversion and 10x page views per order).
- **Availability**: The app must degrade gracefully; read paths should survive partial failure.
- **Freshness**: Availability results can be seconds stale, but order commits must reflect truth instantly.

---

## Core Entities

| Entity | Description | Notes |
|---|---|---|
| **Item** | A catalog SKU (e.g., "Cheetos 8oz bag"). Identified by `itemId`. | Globally unique; shared across all DCs. |
| **Inventory** | Physical quantity of a specific `itemId` at a specific `dcId`. | Compound key `(itemId, dcId)`. Quantity is an integer; decrements on order. |
| **DistributionCenter** | A physical micro-fulfillment store with a lat/long, delivery radius, and operating hours. | The unit of geospatial placement. |
| **Order** | A user's purchase. Contains a list of `(itemId, quantity, dcId)` tuples, a user reference, a delivery address, and a status. | One order may pull from one or multiple DCs, though single-DC is the common case. |

The data model is deliberately small. The tricky piece is that `Inventory` is the thing that gets contended on writes, while `DistributionCenter` (rarely changing) is what drives the geospatial read path.

---

## API Design

```
GET /availability?lat={lat}&lng={lng}&limit=20
-> 200 OK
   [
     { "itemId": "...", "name": "...", "quantity": 12, "dcId": "..." },
     ...
   ]
```

Returns items available from any DC that can deliver to `(lat, lng)` within one hour. `quantity` is an aggregate across eligible DCs; the client does not need to know which DC fulfills it.

```
POST /orders
Body: {
  "userId": "...",
  "lat": ..., "lng": ...,
  "items": [ { "itemId": "...", "quantity": 2 }, ... ]
}
-> 201 Created { "orderId": "...", "status": "CONFIRMED", "items": [...] }
-> 409 Conflict if any item is unavailable or insufficient.
```

Ordering takes a location so the server can re-validate that the resolved DC is still within range and has stock. The client does not pick the DC; the server does.

Out of scope but mentioned in passing: `GET /orders/{id}` for status, `GET /search` for catalog search.

---

## High-Level Design

The system decomposes into a few services and a single authoritative store for inventory and orders.

1. **Availability Service** handles `GET /availability`. It first asks the Nearby Service for DCs within reach of the user, then queries inventory for those DCs and aggregates quantities per item.

2. **Nearby Service** answers "which DCs can reach `(lat, lng)` within one hour?" In its simplest form it keeps the small DC table (only ~10k rows) in memory and refreshes every few minutes. It filters by a coarse radius first (e.g., 60 miles), then refines using a travel-time provider such as Google Distance Matrix only on the surviving candidates.

3. **Orders Service** handles `POST /orders`. It opens a SERIALIZABLE transaction against the primary database that (a) checks stock for every line item, (b) decrements inventory, and (c) writes the order row. Either all steps commit or nothing does.

4. **Primary Database (Postgres)** holds `Item`, `Inventory`, `Order`. Colocating inventory and orders in one relational store is the simplest path to strong consistency without distributed locking. Read replicas fan out for availability queries.

The read path (availability) is hot and can tolerate slight staleness. The write path (orders) is cooler and must be exact. This asymmetry drives every subsequent scaling decision: we scale reads aggressively (replicas, caches, indexes) while keeping writes on a narrow, strongly-consistent path.

---

## Deep Dives

### 1. Nearby-DC Search with Travel Time

A naive Haversine-distance filter is wrong because road networks and traffic dominate delivery time in dense urban areas; 10 miles across Manhattan at 5 PM is not the same as 10 miles in suburbia. Calling a travel-time API against all 10k DCs per request is also wrong: cost and latency explode.

The right answer is two-stage filtering. Stage one uses a fixed Haversine radius (e.g., 60 miles) as a coarse prefilter to cut 10k DCs down to a handful. Stage two calls the travel-time provider on just those survivors to get a true drive-time estimate. DC locations rarely change, so the Nearby Service can cache the DC table in memory and refresh every five minutes; only the travel-time leg hits the network per request.

### 2. Inventory Consistency and Avoiding Overselling

The tempting but bad design puts orders in one database and inventory in another (say, Redis for speed). This introduces a distributed transaction problem: a crash between "write order" and "decrement inventory" leaves the two stores out of sync. Compensating logic and distributed locks follow, and deadlocks appear when two orders touch overlapping items.

The clean answer is to keep `Inventory` and `Order` in the same relational database and wrap the order-placement flow in a single SERIALIZABLE transaction. Postgres's SERIALIZABLE isolation uses predicate locking to detect write-skew anomalies; if two orders race for the last unit, one commits and the other receives a serialization failure that the Orders Service retries or surfaces as a 409. The trade-off is that inventory and orders scale together, but for the write volumes given (~115 orders/sec) that is fine for a long time.

### 3. Scaling Availability Reads at 20k QPS

Twenty thousand availability queries per second is well beyond what a single Postgres primary handles. Two layers relieve it.

First, a Redis cache keyed by something coarse like `(h3_cell_or_zip_prefix, itemId_batch)` with a short TTL (30 seconds to 1 minute). A one-minute TTL already collapses most hot reads to a handful of origin queries. When the Orders Service commits a write, it publishes an invalidation for the affected cells so the cache does not serve oversold state for long.

Second, read replicas absorb cache misses. Because availability tolerates a few seconds of staleness, replica lag is acceptable on this path. Writes still go to the primary.

### 4. Geospatial Indexing Strategies

At small scale, an in-memory list of 10k DCs with a Haversine scan works; 10k comparisons is nothing. As DC count grows or per-query latency tightens, the standard choices are:

- **R-tree or PostGIS `GIST`**: works well on Postgres, supports bounding-box and distance queries, simple to operate.
- **Geohash**: encode lat/long as a string prefix; query by expanding to neighboring cells. Cheap and cache-friendly.
- **H3 (Uber's hex grid)**: hex cells are more isotropic than square geohashes, which matters for "within N minutes" queries whose real shape is irregular. H3 also gives a natural sharding key.
- **Elasticsearch `geo_point`**: useful if availability ever merges with catalog search since ES can do both text and geo in one query.

For this problem I would start with PostGIS because inventory already lives in Postgres; adding a spatial index on the DC table is one line of DDL. Only when the geospatial layer becomes the bottleneck, or when search is folded in, would I reach for Elasticsearch or H3.

### 5. Regional Sharding and Partitioning

Once the single Postgres primary becomes the write bottleneck, the natural shard key is geography. A user in Los Angeles never orders from a DC in Boston, so there is no cross-shard transaction in the common case. Sharding by the first three digits of zip code (or by H3 resolution-4 cell) produces dozens to hundreds of shards, each independently scalable.

Catalog (`Item`) stays globally replicated since it is small and read-heavy. Inventory and orders follow the shard key. The Orders Service routes writes by resolving the DC's region first; if an order ever spans two regions (rare: the user is near a shard boundary), the service rejects multi-DC fulfillment or uses a two-phase commit. I would design away from cross-shard orders rather than engineer them.

---

## Scaling Journey: 0 to infinity

Each stage below states its goal, the architecture in play, what we deliberately skip, and the specific failure that pushes us to the next stage. Scaling here is dominated by two pressures: availability-read QPS, and inventory-write contention. The stages track how those pressures force structural change.

### Stage 1: 0 to 100 Users (MVP)

**Goal**: Prove the concept in one neighborhood with one DC. Make end-to-end ordering work.

**Architecture**: A single monolith (Rails or Django will do) behind a load balancer, one Postgres instance, one DC's inventory manually seeded. Availability is computed by a simple query: "give me all items at DC 1 with quantity > 0." There is no Nearby Service because there is only one DC; every user is implicitly assigned to it. Orders execute in a single SERIALIZABLE transaction. No cache, no replicas, no queue.

**What you skip**: Geospatial logic, travel-time calls, caching, read replicas, sharding, rate limiting, multi-DC assignment, cross-region routing. Payments are stubbed.

**Failure mode that pushes to next stage**: A second DC opens. Now "which items can this user buy?" depends on the user's location and the system has no way to answer it. A hardcoded DC also produces absurd results for users at the edge of the delivery radius.

### Stage 2: 100 to 1,000 Users

**Goal**: Support a small set of DCs in one metro area and correctly route users to the nearest serviceable one.

**Architecture**: Introduce a **Nearby Service** (or a `/nearby` endpoint in the monolith) that keeps the DC table in memory and does a Haversine filter to pick candidates within a fixed radius. Add a travel-time call (Google Distance Matrix) on the shortlist to refine. Availability queries now take `(lat, lng)`, resolve to candidate DCs, and aggregate inventory across them. Postgres still runs as a single primary; total inventory rows are `items x DCs` which is tiny. Add a basic read replica for reporting but not yet for the read path.

**What you skip**: Caching (QPS is still low), sharding, H3/geohash indexes (10 DCs scan trivially in memory), multi-region replication.

**Failure mode that pushes to next stage**: Read QPS on `/availability` spikes as marketing drives more users to the app. Users scroll the homepage repeatedly, each scroll re-hitting the database. Postgres primary CPU climbs past 60% on reads alone, and write latency for orders starts to creep up because reads are crowding out writes.

### Stage 3: 1K to 100K Users

**Goal**: Absorb the read spike without putting inventory consistency at risk. Start serving multiple metros.

**Architecture**:
- Add a **Redis cache** in front of availability, keyed by `(zip3 or H3 cell, item-batch)` with a 30-60 second TTL. The Orders Service publishes invalidations to specific keys after each commit so stale-positive reads clear quickly.
- Add **Postgres read replicas**. Availability cache misses read from replicas (eventual consistency is fine on this path); orders continue to write to the primary.
- Introduce **PostGIS** on the DC table so `nearest N within radius` is an index scan rather than a linear scan, now that DC counts are growing toward the hundreds.
- Split the monolith into three services: **Availability**, **Orders**, **Nearby**. This lets each scale independently; Availability grows horizontally while Orders stays modest.
- Add an async **event bus** (Kafka or SQS) for post-order work: emailing receipts, notifying the DC picker app, updating analytics. The order transaction itself stays synchronous.

**What you skip**: Regional sharding (still one primary), multi-region failover, sophisticated geospatial (H3 is overkill for hundreds of DCs), ML-based ETA. Do not start precomputing all availability; the cache TTL plus invalidation is simpler and correct.

**Failure mode that pushes to next stage**: The single Postgres primary becomes the write bottleneck. At ~1,000 orders/sec with SERIALIZABLE isolation, serialization failures start retrying often enough that p99 order latency exceeds 1 second. Cross-region latency also hurts: a user in LA talking to a primary in us-east-1 pays 70 ms of network RTT per transaction. The cache can no longer hide write-path problems.

### Stage 4: 100K to 10M Users

**Goal**: Operate nationally across thousands of DCs and millions of orders per day without a single-primary bottleneck.

**Architecture**:
- **Regional sharding** of inventory and orders by geography. Shard key is the DC's region (H3 resolution-4 cell or zip3 prefix). Each region runs its own Postgres primary plus replicas. Because a user almost always orders from a DC in their own region, nearly all transactions are single-shard and remain SERIALIZABLE.
- The **Item catalog** stays globally replicated (it is small, ~100k rows, and reads dominate). Inventory rows reference a global `itemId` but live in the region's shard.
- **Orders Service** routes by resolving the DC first, then opening the transaction on the owning shard. If a rare cross-region order appears, it is rejected at the API layer with a clear error; we do not introduce 2PC for an edge case.
- **Nearby Service** now holds several thousand DCs; upgrade to an H3-indexed in-memory structure or an Elasticsearch `geo_point` index for sub-5ms lookups.
- **Multi-region deployment**: place each shard's primary near its users (us-east, us-west, etc.) to cut order-path RTT. Availability cache nodes live in every region; cache is not cross-region replicated because each region's data differs anyway.
- Introduce a **rate limiter** in front of `/availability` (token bucket per user/IP) to protect the cache from scrapers.
- Inventory reservations: for multi-item carts that the user may take minutes to complete, add an optional **soft-reservation** pattern. A TTL-bound row in a `Reservation` table holds stock for N minutes; the order transaction converts it to a sale. This prevents rage-inducing "oversold at checkout" experiences under high contention.

**What you skip**: Cross-region consistency (regions are independent by design), global coordination services, ML demand forecasting, predictive prewarming. Stick with simple TTL caches.

**Failure mode that pushes to next stage**: International expansion and extreme per-DC write hotspots. A single DC in a dense urban area hits more writes per second than its shard's primary can serialize. Also, the business wants recommendations ("people in your neighborhood are buying X") and personalized availability, which cannot be served by raw inventory queries.

### Stage 5: 10M+ Users

**Goal**: Sustain extreme per-DC write contention, deliver personalized and predictive experiences, and operate globally with per-country regulatory isolation.

**Architecture**:
- **Per-DC partitioning within a region**: for hotspot DCs, split inventory across sub-partitions by `itemId` hash so hot items do not all land on one row group. SERIALIZABLE contention drops because locks now span fewer rows per transaction.
- **CQRS on inventory**: the write path remains a transactional Postgres commit; the read path is fed by a change-data-capture stream (Debezium into Kafka) that materializes denormalized `(h3_cell, itemId) -> quantity` views in a fast KV store (DynamoDB or Aerospike) and into a search index (Elasticsearch). Availability queries hit the materialized view; they never touch Postgres. This decouples read scaling from write scaling entirely.
- **Predictive prewarming**: a batch job forecasts demand per DC per hour and suggests inventory relocations. This is a product feature, but it also reshapes load: DCs rarely oversell on forecasted-hot items because stock gets moved proactively.
- **Per-country deployment** with data-residency guarantees (GDPR, etc.). Each country is a fully independent cell; the catalog service replicates globally with regional overrides for locale/pricing.
- **Chaos and blast-radius controls**: circuit breakers on the travel-time provider (fall back to Haversine if the provider is slow), per-region feature flags, automated shard failover.
- **Observability**: p99 dashboards per shard, per DC, and per item. Overselling is a critical business alert, not a debug metric.

**What you skip**: There is no next stage from a system-design standpoint; further growth is a product and cost problem, not a structural one. Do not introduce a global inventory service; locality is the core invariant that made this system work.

**Failure mode**: At this point, failure modes are organizational (team coordination across cells, deployment velocity) rather than technical, and the architecture accommodates them with cell independence.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What interviewers want to see | Specific expectations for this problem |
|---|---|---|---|
| **Mid-level** | ~80% breadth, 20% depth | A clear, working design end-to-end. | Correct API shapes, sensible entities, a single Postgres with SERIALIZABLE for orders, an in-memory DC list for the Nearby step. Candidate should recognize availability is read-heavy but may not drive the cache design without prompting. |
| **Senior** | ~60% breadth, 40% depth | Proactive identification of bottlenecks and justified trade-offs. | Candidate brings up read/write asymmetry unprompted, proposes Redis + replicas for availability, explains why SERIALIZABLE beats distributed locks, and handles the Nearby-with-travel-time deep dive cleanly. Should discuss regional sharding at least at a conceptual level. |
| **Staff+** | ~40% breadth, 60% depth | Novel insights, failure-mode anticipation, deep ownership of 2-3 areas. | Candidate anticipates hotspot DCs, discusses CQRS with CDC for extreme read scale, reasons about geospatial index choice (PostGIS vs H3 vs Elasticsearch) with trade-offs, and addresses cross-region consistency, reservation patterns, and blast-radius containment. Should also talk about operational concerns: invalidation correctness, monitoring for overselling, and graceful degradation when the travel-time provider is down. |
