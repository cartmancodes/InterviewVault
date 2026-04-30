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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Imagine a **pizza shop's old-school dispatch board**. The manager has a magnetic whiteboard tracking every in-flight order. When a new ticket comes in, they pin it to the board, glance at which delivery driver is closest and free, and assign it. That magnetic board is exactly what an order dispatcher does — except instead of one pizza shop, DoorDash is running thousands of these boards simultaneously across every city.

Now picture a **taxi cab dispatcher with a CB radio**. A rider yells "I need a ride from 5th and Main." The dispatcher looks at the map of cabs roaming the city, picks the closest one, and radios them. The cab driver gets a few seconds to accept — if they don't, the dispatcher tries the next driver. Local delivery works the same way: when an order pops, the system pings the nearest driver, waits for an acceptance, and falls through to the next candidate if they ignore it.

Finally, think of a **relay race**. Each leg has a different runner — the restaurant prepares the food, the driver picks it up, the customer receives it. If any leg drops the baton — say, the food isn't ready when the driver arrives — the whole relay slows down and everyone waits.

The hard parts:

- **Three sides of the marketplace**: customers, restaurants, and drivers all need different real-time updates. The customer sees "your driver is 5 min away." The driver sees "drive to McDonald's, 2.3 mi." The restaurant sees "order #4521 incoming." One event, three different views.
- **Geospatial matching**: you don't want to dispatch a driver across town when there's one across the street. That's why systems use geo-indexes like H3 hex grids — a city map carved into chess squares so the dispatcher can ask "who's in this square?" instantly.
- **Surge pricing**: when 1,000 people in one neighborhood all order at once (rainstorm, sports game ending), drivers are scarce. Prices rise to attract more drivers onto the road. Like the pizza shop charging double on Super Bowl night.
- **ETAs**: predicting when food arrives is a math puzzle — cooking time + driver pickup + driving time + parking time + walking up the stairs. Each step has its own variance.

### When the analogy breaks down

A real pizza dispatcher couldn't optimize routes for batched deliveries (one driver carrying three orders that all happen to point in the same direction), nor could they run ML models that predict which driver is most likely to accept a given offer based on their recent behavior. Real DoorDash ingests live weather and traffic feeds, rebalances three-sided incentives (driver pay, restaurant fees, customer prices) to keep the marketplace liquid, and does this across millions of orders per day at latencies no human dispatcher could match. The whiteboard works for one shop on one night — it doesn't survive contact with a city-scale, multi-tenant marketplace under unpredictable demand shocks.

---

## Core Entities

| Entity | Description | Notes |
|---|---|---|
| **Item** | A catalog SKU (e.g., "Cheetos 8oz bag"). Identified by `itemId`. | Globally unique; shared across all DCs. |
| **Inventory** | Physical quantity of a specific `itemId` at a specific `dcId`. | Compound key `(itemId, dcId)`. Quantity is an integer; decrements on order. |
| **DistributionCenter** | A physical micro-fulfillment store with a lat/long, delivery zone polygon, and operating hours. | The unit of geospatial placement. |
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

1. **Availability Service** handles `GET /availability`. It first asks the Nearby Service for DCs whose delivery polygon contains the user's coordinates, then queries inventory for those DCs and aggregates quantities per item.

2. **Nearby Service** answers "which DCs can deliver to `(lat, lng)`?" It stores DC delivery zones as GeoJSON polygons in PostGIS. It performs a polygon containment query (`ST_Contains`) to find eligible DCs, then optionally refines further with a travel-time API call on the surviving short list. Because DC zone geometries change infrequently, the service can cache the full polygon dataset in memory and refresh every few minutes.

3. **Orders Service** handles `POST /orders`. It opens a transaction against the primary database that (a) checks stock for every line item, (b) decrements inventory using an optimistic lock (`UPDATE ... WHERE available > 0`), and (c) writes the order row. Either all steps commit or nothing does.

4. **Primary Database (Postgres with PostGIS)** holds `Item`, `Inventory`, `Order`, and `DistributionCenter` with spatial geometry columns. Colocating inventory and orders in one relational store is the simplest path to strong consistency without distributed locking. Read replicas fan out for availability queries.

The read path (availability) is hot and can tolerate slight staleness. The write path (orders) is cooler and must be exact. This asymmetry drives every subsequent scaling decision: we scale reads aggressively (replicas, caches, indexes) while keeping writes on a narrow, strongly-consistent path.

---

## Deep Dives

### 1. Nearby-DC Search with Travel Time

A naive Haversine-distance filter is wrong for two independent reasons. First, road networks and traffic dominate delivery time in dense urban areas; 10 miles across Manhattan at 5 PM is not the same as 10 miles in suburbia. Second, and less obvious, a radius query returns DCs that are geographically close but may be unreachable by road — a DC across a river with no nearby bridge, or on the other side of a divided highway, can show as 0.5 miles away but be 15 minutes of drive time. Calling a travel-time API against all 10k DCs per request is also wrong: cost and latency explode.

The right answer is three-stage filtering. Stage one performs a PostGIS `ST_Contains(delivery_zone_polygon, user_point)` query to return only DCs whose hand-drawn delivery polygon actually includes the user's location. Delivery zone polygons are maintained by operations teams and stored as GeoJSON; they already encode road-reachability implicitly because operations draws them to follow streets, rivers, and barriers. Stage two applies a coarse Haversine radius filter as a bounding-box prefilter to limit how many polygons the database must test. Stage three calls the travel-time provider (Google Distance Matrix, HERE, or similar) on the handful of surviving candidates to get a true drive-time estimate for ETA purposes. DC zone geometries change rarely, so the Nearby Service can cache the full polygon dataset in memory and refresh every five minutes; only the travel-time leg hits the external network per request.

When no polygon-based zones exist yet (early stage), fall back to a configurable radius and document the known shortcoming. The migration path to polygons is an operational concern, not a code rewrite.

### 2. Inventory Consistency and Avoiding Overselling

The tempting but broken design puts orders in one database and inventory in another (say, Redis for speed). This introduces a distributed transaction problem: a crash between "write order" and "decrement inventory" leaves the two stores out of sync. Compensating logic and distributed locks follow, and deadlocks appear when two orders touch overlapping items.

The clean answer is to keep `Inventory` and `Order` in the same relational database and use a two-phase write pattern. At checkout initiation the Orders Service soft-reserves items by decrementing a `reserved` counter without touching `available`. The reservation row carries a TTL; a background job (or Postgres `pg_cron`) expires and releases it after 10 minutes if payment never completes. At payment success the service hard-commits: it decrements `available`, increments `sold`, and deletes the reservation row. If payment fails or the session times out the release path fires. This two-phase pattern means no DB lock is held during the external payment call — a potentially slow operation — while still guaranteeing that stock cannot be double-sold.

For the final decrement, use optimistic locking rather than a row lock:

```sql
UPDATE inventory
SET available = available - 1
WHERE sku_id = ? AND available > 0;
```

Check rows affected: if the result is 0, the item sold out between the inventory check and the commit. Return a 409 to the user. No lock was held; the conflict is detected at write time. If two users simultaneously pass the inventory check for the last unit, exactly one of their UPDATE statements will match `available > 0`; the other returns 0 rows affected and loses cleanly. This is safer than SERIALIZABLE isolation for hot items because it does not produce serialization failures that require retry logic; the conflict path is explicit and deterministic.

### 3. Scaling Availability Reads at 20k QPS

Twenty thousand availability queries per second is well beyond what a single Postgres primary handles. Two layers relieve it, and they serve different consistency tiers deliberately.

The first layer is a Redis cache keyed by something coarse like `(h3_cell, itemId_batch)` with a short TTL of 30 to 60 seconds. Browse-time inventory — the count a user sees while scrolling the app — can be eventually consistent. A 30-second stale count is acceptable because it does not commit to selling anything; it merely sets user expectation. This layer collapses most of the 20k QPS down to a handful of origin fetches per TTL window. When the Orders Service commits a write, it publishes an invalidation for the affected cache keys so the cache does not serve oversold state for longer than the TTL even in the worst case.

The second layer is Postgres read replicas. Availability cache misses read from replicas (lag of a few seconds is fine on this path). Writes always go to the primary. These two layers together mean the primary only sees cache-miss traffic, which at a 30-second TTL and 20k QPS is a small fraction of origin requests.

Checkout-time inventory is a different story entirely. The `POST /orders` write path never reads from cache or replicas. It reads from the primary via the optimistic `UPDATE ... WHERE available > 0` pattern described above. Strong consistency is enforced precisely because real money is at stake. The two tiers — eventually consistent browse cache and strongly consistent checkout write — are an intentional design choice, not an oversight.

### 4. Geospatial Indexing Strategies

At small scale, an in-memory list of 10k DCs with a Haversine scan works; 10k comparisons is nothing. As DC count grows or per-query latency tightens, the standard choices are:

- **PostGIS `GIST` spatial index**: works natively in Postgres, supports polygon containment (`ST_Contains`), bounding-box queries (`&&` operator), and distance ordering (`<->`). The right default choice for this problem because inventory already lives in Postgres; adding a spatial index on the DC table is one line of DDL. Polygon containment queries against a GIST index run in O(log n) and handle hand-drawn delivery zones directly as GeoJSON geometries.
- **Geohash bucketing**: encode lat/long as a string prefix; query by expanding to neighboring cells. Cheap and cache-friendly. Critical caveat: always query the 8 neighboring cells plus the user's own cell. A user sitting at the boundary between two geohash cells may be equidistant from two DCs, each in a different cell; querying only the user's own cell misses one DC entirely. Libraries like `geohash-neighbors` return the 8 adjacent cells in O(1). This neighbor expansion is a standard pattern, not a performance concern.
- **H3 (Uber's hex grid)**: hex cells are more isotropic than square geohashes, which reduces edge-case distortion for "within N minutes" queries whose real shape is irregular. H3 also gives a natural shard key for regional partitioning. Prefer H3 over raw geohash once geospatial queries become a bottleneck or when sharding by geography.
- **Elasticsearch `geo_shape`**: supports polygon containment queries natively (`geo_shape` filter with `relation: contains`) and can combine geospatial filtering with full-text catalog search in a single query. Useful if availability ever merges with catalog search since Elasticsearch handles both in one round trip. Higher operational overhead than PostGIS.

For this problem, start with PostGIS because inventory already lives in Postgres. Migrate to Elasticsearch only when the geospatial layer becomes the bottleneck or when catalog search is folded into the availability response.

### 5. Regional Sharding and Partitioning

Once the single Postgres primary becomes the write bottleneck, the natural shard key is geography. A user in Los Angeles never orders from a DC in Boston, so there is no cross-shard transaction in the common case. Sharding by H3 resolution-4 cell (or by the first three digits of zip code) produces dozens to hundreds of shards, each independently scalable.

DC selection within a region requires more nuance than "nearest DC." If DC-A is 2 km away but 90% inventory-full and DC-B is 3 km away and 20% full, DC-B may fulfill and dispatch faster. The DC selection query must join user location (converted to a DC-distance metric), DC distance, and item availability at each candidate DC simultaneously. A capacity-weighted scoring function — combining distance penalty and current fill ratio — outperforms naive nearest-first selection under high-demand conditions and reduces the probability of a "nearest DC is sold out" scenario during peak hours.

Catalog (`Item`) stays globally replicated since it is small and read-heavy. Inventory and orders follow the shard key. The Orders Service routes writes by resolving the DC's region first; if an order ever spans two regions (rare: the user is near a shard boundary), the service rejects multi-DC fulfillment or uses a two-phase commit. The correct engineering choice is to design away from cross-shard orders rather than implement 2PC for an edge case that represents a fraction of a percent of traffic.

The Item catalog and the Inventory table are also separate data domains and should be treated as such. Catalog data (name, description, images, category) changes on a timescale of days to weeks. Inventory data (stock count, price per DC, availability flag) changes per second. Mixing them in one table forces inventory updates — which happen on every order — to touch the same rows as catalog reads, creating unnecessary lock contention and making caching strategies for each domain harder to tune independently. Separate tables with separate caching TTLs is the operationally correct decomposition.

---

## Scaling Journey: 0 to infinity

Each stage below states its goal, the architecture in play, what we deliberately skip, and the specific failure that pushes us to the next stage. Scaling here is dominated by two pressures: availability-read QPS, and inventory-write contention. The stages track how those pressures force structural change.

### Stage 1: 0 to 100 Users (MVP)

**Goal**: Prove the concept in one neighborhood with one DC. Make end-to-end ordering work.

**Architecture**: A single monolith (Rails or Django will do) behind a load balancer, one Postgres instance, one DC's inventory manually seeded. Availability is computed by a simple query: "give me all items at DC 1 with quantity > 0." There is no Nearby Service because there is only one DC; every user is implicitly assigned to it. Orders execute with an optimistic `UPDATE ... WHERE available > 0` check plus an Order row insert. No cache, no replicas, no queue.

**What you skip**: Geospatial logic, travel-time calls, caching, read replicas, sharding, rate limiting, multi-DC assignment, cross-region routing. Payments are stubbed.

**Failure mode that pushes to next stage**: A second DC opens. Now "which items can this user buy?" depends on the user's location and the system has no way to answer it. A hardcoded DC also produces absurd results for users at the edge of the delivery radius.

### Stage 2: 100 to 1,000 Users

**Goal**: Support a small set of DCs in one metro area and correctly route users to the nearest serviceable one.

**Architecture**: Introduce a **Nearby Service** (or a `/nearby` endpoint in the monolith) that keeps the DC table in memory, initially using Haversine radius filtering. Add delivery-zone polygons stored as GeoJSON in Postgres and use PostGIS `ST_Contains` for containment checks. Add a travel-time call (Google Distance Matrix) on the shortlist to refine ETA. Availability queries now take `(lat, lng)`, resolve to candidate DCs, and aggregate inventory across them. Postgres still runs as a single primary; total inventory rows are `items x DCs` which is tiny. Add a basic read replica for reporting but not yet for the hot read path.

**What you skip**: Caching (QPS is still low), sharding, geohash neighbor expansion (10 DCs scan trivially in memory), multi-region replication.

**Failure mode that pushes to next stage**: Read QPS on `/availability` spikes as marketing drives more users to the app. Users scroll the homepage repeatedly, each scroll re-hitting the database. Postgres primary CPU climbs past 60% on reads alone, and write latency for orders starts to creep up because reads are crowding out writes.

### Stage 3: 1K to 100K Users

**Goal**: Absorb the read spike without putting inventory consistency at risk. Start serving multiple metros.

**Architecture**:
- Add a **Redis cache** in front of availability, keyed by `(H3 cell, item-batch)` with a 30-60 second TTL. Browse-time queries hit cache; checkout-time writes bypass it entirely and go to the primary. The Orders Service publishes invalidations to specific keys after each commit so stale-positive reads clear quickly.
- Add **Postgres read replicas**. Availability cache misses read from replicas (eventual consistency is fine on this path); orders continue to write to the primary.
- Ensure **PostGIS GIST indexes** are in place on the DC geometry columns so polygon containment queries are index scans rather than full-table scans, now that DC counts are growing toward the hundreds.
- Split the monolith into three services: **Availability**, **Orders**, **Nearby**. This lets each scale independently; Availability grows horizontally while Orders stays modest.
- Add an async **event bus** (Kafka or SQS) for post-order work: emailing receipts, notifying the DC picker app, updating analytics. The order transaction itself stays synchronous.

**What you skip**: Regional sharding (still one primary), multi-region failover, ML-based ETA. Do not start precomputing all availability; the cache TTL plus invalidation is simpler and correct.

**Failure mode that pushes to next stage**: The single Postgres primary becomes the write bottleneck. At high order rates with optimistic lock retries on hot items, p99 order latency exceeds 1 second. Cross-region latency also hurts: a user in LA talking to a primary in us-east-1 pays 70 ms of network RTT per transaction. The cache can no longer hide write-path problems.

### Stage 4: 100K to 10M Users

**Goal**: Operate nationally across thousands of DCs and millions of orders per day without a single-primary bottleneck.

**Architecture**:
- **Regional sharding** of inventory and orders by geography. Shard key is the DC's region (H3 resolution-4 cell or zip3 prefix). Each region runs its own Postgres primary plus replicas. Because a user almost always orders from a DC in their own region, nearly all transactions are single-shard. Capacity-weighted DC selection (distance + fill ratio score) is evaluated per region at routing time.
- The **Item catalog** stays globally replicated (it is small, ~100k rows, and reads dominate). Inventory rows reference a global `itemId` but live in the region's shard. The catalog service uses a long TTL cache because product metadata changes slowly.
- **Orders Service** routes by resolving the DC first, then opening the transaction on the owning shard. Cross-region orders are rejected at the API layer; we do not introduce 2PC for an edge case.
- **Nearby Service** now holds several thousand DCs; upgrade to an H3-indexed in-memory structure or an Elasticsearch `geo_shape` index for sub-5ms polygon containment lookups.
- **Multi-region deployment**: place each shard's primary near its users (us-east, us-west, etc.) to cut order-path RTT. Availability cache nodes live in every region.
- Introduce a **rate limiter** in front of `/availability` (token bucket per user/IP) to protect the cache from scrapers.
- Full **soft-reserve / hard-commit** pattern for all checkouts: soft-reserve at cart initiation (10-minute TTL), hard-commit at payment success, automatic release on payment failure or timeout.

**What you skip**: Cross-region consistency (regions are independent by design), global coordination services, ML demand forecasting, predictive prewarming.

**Failure mode that pushes to next stage**: International expansion and extreme per-DC write hotspots. A single DC in a dense urban area hits more writes per second than its shard's primary can serialize. The business also wants personalized availability and ETA predictions, which cannot be served by raw inventory queries.

### Stage 5: 10M+ Users

**Goal**: Sustain extreme per-DC write contention, deliver personalized and predictive experiences, and operate globally with per-country regulatory isolation.

**Architecture**:
- **Per-DC partitioning within a region**: for hotspot DCs, split inventory across sub-partitions by `itemId` hash so hot items do not all land on one row group. Optimistic lock contention drops because competing `UPDATE` statements span fewer conflicting rows per transaction.
- **CQRS on inventory**: the write path remains a transactional Postgres commit with optimistic locking; the read path is fed by a change-data-capture stream (Debezium into Kafka) that materializes denormalized `(h3_cell, itemId) -> quantity` views in a fast KV store (DynamoDB or Aerospike) and into a search index (Elasticsearch). Availability queries hit the materialized view; they never touch Postgres. This decouples read scaling from write scaling entirely.
- **ML-based ETA**: replace static averages with models trained on historical picker times, pack times, and rider transit times per DC, time of day, and order size. ETA is surfaced as the sum of three independent estimates, each with its own model.
- **Predictive prewarming**: a batch job forecasts demand per DC per hour and suggests inventory relocations. DCs rarely oversell on forecasted-hot items because stock gets moved proactively.
- **Per-country deployment** with data-residency guarantees (GDPR, etc.). Each country is a fully independent cell; the catalog service replicates globally with regional overrides for locale and pricing.
- **Chaos and blast-radius controls**: circuit breakers on the travel-time provider (fall back to polygon-only containment check if the provider is slow), per-region feature flags, automated shard failover.
- **Observability**: p99 dashboards per shard, per DC, and per item. Overselling events are critical business alerts wired to on-call, not debug metrics buried in logs.

**What you skip**: There is no next stage from a system-design standpoint; further growth is a product and cost problem, not a structural one. Do not introduce a global inventory service; locality is the core invariant that made this system work.

**Failure mode**: At this point, failure modes are organizational (team coordination across cells, deployment velocity) rather than technical, and the architecture accommodates them with cell independence.

---

## Insider Tips and Tricks

### Delivery Zones Are Polygons, Not Circles

A radius query returns DCs that are geographically close but physically unreachable — a DC across a river with no nearby bridge or on the wrong side of a divided highway can show as 0.5 miles away yet be 15 minutes of drive time. Real delivery zones are hand-drawn polygons maintained by operations teams, reflecting actual road-network reachability. Store them as GeoJSON geometries in Postgres and use PostGIS `ST_Contains(zone_polygon, user_point)` for containment queries, or Elasticsearch `geo_shape` with `relation: contains` if the geospatial layer lives in ES. The polygon approach eliminates an entire class of "DC selected but unreachable" bugs that radius-based systems hit in production.

### Inventory Has Two Consistency Tiers

Browse-time inventory — the count shown while a user scrolls the catalog — can be eventually consistent. A 30-second stale count is acceptable because it does not commit to selling anything; it merely guides the user. Cache these counts in Redis with a short TTL and read from Postgres replicas on cache miss. Checkout-time inventory is a different contract entirely: two users cannot both buy the last unit. The checkout write path must bypass the cache and the replicas, hitting the primary with a strongly consistent write. Conflating these two tiers into one caching policy is a common design mistake — it either over-engineers the browse path (adding expensive strong reads for no user benefit) or under-engineers the checkout path (allowing overselling).

### The Soft Reserve / Hard Commit Pattern

At checkout initiation, soft-reserve the items by decrementing a `reserved` counter on the inventory row — not the `available` counter. The reservation carries a TTL (10 minutes is common) managed by a background expiry job or `pg_cron`. At payment success, hard-commit: decrement `available`, increment `sold`, and release the reservation. If payment fails, times out, or the user abandons the cart, the soft reserve expires and the stock returns to the pool automatically. This two-phase pattern prevents overselling without holding a database row lock during the entire payment processing window, which can last seconds and would throttle order throughput severely under load.

### The Last-Item Race Condition Requires Optimistic Locking

Two users simultaneously pass the inventory availability check for the last unit. A naive implementation lets both proceed to decrement, producing a quantity of -1 and an oversell. The fix is an optimistic lock baked into the UPDATE itself:

```sql
UPDATE inventory
SET available = available - 1
WHERE sku_id = ? AND available > 0;
```

Check rows affected after execution. If the result is 0, the item sold out between the check and the commit — return a 409 "out of stock" to that user. No lock is held; conflict is detected at write time. This is strictly preferable to `SELECT FOR UPDATE` for hot items because it does not serialize all contending transactions through a lock queue; each transaction attempts the update independently and the database resolves the conflict atomically. At extreme scale, the loser simply retries or fails fast — no deadlock is possible.

### DC Selection When a User Is Between Two DCs

Nearest-first DC selection is a trap under load. If DC-A is 2 km away but 90% inventory-full and DC-B is 3 km away and 20% full, DC-B will likely fulfill and dispatch faster. The DC selection query must evaluate user location, DC distance, and current item availability at each candidate DC simultaneously. Use a capacity-weighted scoring function that penalizes distance and fill ratio together. Additionally, item availability differs by DC — a SKU may be in stock at DC-B but sold out at DC-A — so the query must join all three dimensions in one pass rather than picking the nearest DC first and then checking availability second. A two-step approach can produce "nearest DC has no stock" errors that frustrate users even when a slightly farther DC is fully stocked.

### Product Catalog vs Inventory Are Separate Data Domains

Product catalog data (name, description, images, category, brand) changes on a timescale of days to weeks. Inventory data (stock count, price, availability flag per DC) changes per second on every order. Storing them in the same table — a common shortcut — forces every inventory decrement to touch the same rows that catalog reads lock, unnecessarily inflating write amplification and making it harder to apply distinct caching strategies. Separate them into distinct services with distinct schemas: a Catalog Service with a long-TTL cache (hours) backed by a CDN for images, and an Inventory Service with a short-TTL cache (30 seconds) with write-through invalidation. This decomposition also allows the Catalog Service to be globally replicated cheaply since it is append-dominant, while the Inventory Service remains regionally sharded because it is write-heavy.

### ETA Is a Combination of Three Independent Estimates

Showing "delivery in 15 minutes" requires summing three independently variable durations. Picker time is how long a DC employee takes to locate and pull each item from shelves; it varies with order size, DC layout, and current picker workload. Pack time is roughly constant but bounded by DC staffing. Rider transit time depends on distance, live traffic conditions, and how many riders are currently available in the area. Early systems use static averages per DC (acceptable for MVP). Mature systems train separate ML models for each component on historical fulfillment data, keyed by DC, time of day, order composition, and weather. The three estimates are summed with uncertainty bounds so the app can display "15-20 minutes" rather than a falsely precise single number.

### Geohash Bucket Boundary Problem

A user standing exactly at the boundary between two geohash cells may be equidistant from two DCs, each falling in a different cell. A query that fetches only the user's own geohash cell misses one of those DCs entirely, producing incorrect "no nearby DC" results for a nontrivial fraction of users (boundary zones are not rare in a dense city). The fix is always query the 8 neighboring cells in addition to the user's own cell — 9 cells total. Libraries such as `geohash-neighbors` return all 8 adjacent cells in O(1) time. This is a standard, expected pattern in any geohash-based proximity system. Candidates who know this detail signal real geospatial experience; candidates who propose geohash without mentioning neighbor expansion are demonstrating incomplete knowledge of the technique.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What interviewers want to see | Specific expectations for this problem |
|---|---|---|---|
| **Mid-level** | ~80% breadth, 20% depth | A clear, working design end-to-end. | Correct API shapes, sensible entities, a single Postgres with optimistic locking for orders, an in-memory DC list for the Nearby step. Candidate should recognize availability is read-heavy but may not drive the cache design without prompting. |
| **Senior** | ~60% breadth, 40% depth | Proactive identification of bottlenecks and justified trade-offs. | Candidate brings up read/write asymmetry unprompted, proposes Redis (browse tier) + replica reads for availability, explains why optimistic locking beats distributed locks at the inventory decrement step, and handles the Nearby-with-travel-time deep dive cleanly. Should discuss regional sharding at least at a conceptual level. Bonus: mentions delivery zones as polygons rather than radii. |
| **Staff+** | ~40% breadth, 60% depth | Novel insights, failure-mode anticipation, deep ownership of 2-3 areas. | Candidate anticipates hotspot DCs, discusses CQRS with CDC for extreme read scale, reasons about geospatial index choice (PostGIS polygon containment vs H3 vs Elasticsearch geo_shape) with trade-offs, and addresses cross-region consistency, the soft-reserve / hard-commit pattern, and blast-radius containment. Unprompted: the two inventory consistency tiers (browse vs checkout), the geohash neighbor-expansion requirement, capacity-weighted DC selection, and separation of catalog from inventory as distinct data domains. Should also talk about operational concerns: invalidation correctness, monitoring for overselling as a business-critical alert, and graceful degradation when the travel-time provider is unavailable. |
