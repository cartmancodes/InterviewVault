# Design Uber

> **Pattern**: Geospatial Matching / Real-time
> **Difficulty**: Hard
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/uber)

## Table of Contents
1. [Understanding the Problem](#understanding-the-problem)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Uber is a two-sided marketplace that pairs nearby drivers with riders in under a minute, subject to strict geospatial constraints and exclusivity (a driver can hold at most one active ride). The core technical challenge is ingesting millions of high-frequency location pings while simultaneously running low-latency proximity searches and maintaining strict consistency during dispatch.

### Functional Requirements

**In scope (core):**
1. A rider enters a pickup and destination and receives a fare estimate with an ETA.
2. A rider confirms a request; the system matches them with a nearby available driver.
3. A driver sees the offer and can accept or decline within a bounded time window.
4. Once accepted, both parties see the active trip as it transitions through pickup, en-route, and completion.

**Out of scope:**
- Ratings and feedback after the trip.
- Scheduled rides (future bookings).
- Ride categories (UberX, XL, Comfort, Pool).
- Driver onboarding, background checks, earnings payouts.

### Non-Functional Requirements

**In scope (core):**
- **Low-latency matching:** A rider must be matched (or receive a failure) inside 1 minute.
- **Strong consistency at dispatch:** A driver can only be offered or assigned one ride at a time. No double-booking, even under racing requests.
- **High throughput on location writes and ride requests:** System must survive demand spikes (e.g., a concert letting out: 100k simultaneous requests from the same geohash).

**Out of scope:**
- GDPR / PII compliance.
- Multi-region failover and DR posture.
- Observability stack (logs, metrics, traces).
- CI/CD and deployment topology.

**Back-of-envelope numbers:**
- ~10M active drivers globally pinging every ~5s yields ~2M writes/sec on the location hot path.
- Match SLO: under 1 minute end to end, with per-driver accept windows of ~10s.
- Peak local density: 100k requests per city cell during events.

---

## Core Entities

| Entity | Purpose | Notable fields |
|---|---|---|
| **Rider** | The requesting user. | `riderId`, profile, payment method on file |
| **Driver** | The supplying side. Carries availability state. | `driverId`, `vehicleInfo`, `status` (available, offered, on_trip, offline) |
| **Fare** | A quoted price tied to a route. Short-lived; becomes a Ride on confirmation. | `fareId`, `pickup`, `destination`, `price`, `eta`, `expiresAt` |
| **Ride (Trip)** | The lifecycle object linking a rider, a driver, and a route. | `rideId`, `riderId`, `driverId`, `status`, timestamps per state |
| **Location** | A driver's last-known coordinates, updated on every ping. | `driverId`, `lat`, `lng`, `updatedAt` |

---

## API Design

All user identity is read from the session token or JWT on the server. The client never asserts `riderId` or `driverId` in the body.

```
POST /fare
Body: { pickup: {lat, lng}, destination: {lat, lng} }
Returns: { fareId, price, etaSeconds, expiresAt }
```

```
POST /rides
Body: { fareId }
Returns: { rideId, status: "MATCHING" }
Notes: idempotency key on the header to guard retries.
```

```
POST /drivers/location
Body: { lat, lng, heading, speed }
Returns: 204
Notes: sent over a persistent websocket in the mature design, not as repeated HTTPS posts.
```

```
PATCH /rides/{rideId}
Body: { action: "ACCEPT" | "DECLINE" }
Returns: { rideId, status, pickup, destination }
Notes: called by the driver app. Server validates the offer is still outstanding.
```

```
GET /rides/{rideId}/track
Returns: streaming connection (SSE or websocket) with driver position and ETA.
```

---

## High-Level Design

```
[Rider App] --+
              |
[Driver App] -+--> [API Gateway] ---> [Ride Service]      (fare, state machine, persistence)
                         |        \-> [Location Service]  (ingest pings, write to geo index)
                         |        \-> [Match Service]     (proximity search + dispatch)
                         |        \-> [Notification Svc]  (APNs / FCM fanout)
                         |
                         v
               [Redis Geo Index]       <-- hot location store
               [Primary DB: Postgres]  <-- Rider, Driver, Ride, Fare
               [Kafka]                 <-- ride requests, dispatch workflow
               [Temporal / Step Fn]    <-- durable matching workflow
```

**Write path (location ping):** driver app opens a websocket to Location Service; every N seconds (adaptive) it posts lat/lng; Location Service writes to Redis using `GEOADD` keyed by region.

**Read path (match):** rider posts `POST /rides`; Ride Service creates the row, emits a `RideRequested` event to Kafka. Match Service consumes, runs `GEOSEARCH` around pickup, picks the best candidate, acquires a Redis distributed lock on that `driverId` with a 10s TTL, and pushes the offer through Notification Service. On ACCEPT, lock is released, Ride row transitions to `ACCEPTED`. On timeout, workflow moves to the next candidate.

---

## Deep Dives

### 1. Driver Location Ingestion at 2M writes/sec

The naive "write every ping into Postgres with a B-tree on (lat, lng)" fails on two fronts: write amplification kills the database, and B-trees cannot efficiently answer "drivers within 3 km of this point."

**Geohashing in Redis** wins here. `GEOADD` encodes lat/lng into a 52-bit integer (a geohash of sorts) and stores it in a sorted set. `GEOSEARCH ... BYRADIUS` runs in near-constant time against a bounded cell. Losing a few seconds of Redis state is acceptable because drivers re-ping within 5s; AOF + Sentinel covers the rest.

**Batch + adaptive ping rate:** The client itself decides how often to ping. Stationary drivers can drop to 30s; fast-moving drivers on a highway stay at 2s. Location Service can also coalesce writes in a 1-2s window per driver before flushing to Redis. This alone cuts the 2M/sec number by 3-5x.

### 2. Matching Algorithm and Proximity Search

Matching is more than "nearest." A good score blends distance, driver ETA (accounting for one-way streets and traffic), driver acceptance rate, and current demand on the driver side. Practically:

1. `GEOSEARCH` returns the N closest drivers inside, say, a 3 km radius.
2. Filter by `status = available` and matching vehicle class.
3. Rank by estimated time-to-pickup, not straight-line distance.
4. Offer the top candidate; on decline or timeout, try the next.

The geospatial index must be correct at cell boundaries. Scatter-gather across neighboring cells handles riders near the edge.

### 3. Geospatial Index Choice

Candidates in rough order of sophistication:
- **PostGIS (Postgres):** Excellent SQL ergonomics, R-tree (GiST) indexes. Great at low scale. Struggles under 2M write/sec on hot cells.
- **Redis geohash (GEOADD / GEOSEARCH):** In-memory, simple, city-shardable. The sweet spot for most ride-hailing workloads.
- **Google S2 / Uber H3:** Hierarchical cell coverings. H3 uses hexagons, which have uniform adjacency (six equidistant neighbors) unlike squares, making radius queries cleaner. Used by Uber in production for surge pricing cells and fleet balancing.
- **Quadtree:** Textbook answer; fine pedagogically but rarely chosen over H3/S2 in practice.

Answer in the interview: start with PostGIS, justify moving to Redis geohash at scale, and reference H3 for the globally sharded version.

### 4. Ride State Machine and Strong Consistency

```
REQUESTED -> MATCHING -> OFFERED -> ACCEPTED -> EN_ROUTE -> IN_TRIP -> COMPLETED
                         |               |           |
                         v               v           v
                       EXPIRED       CANCELLED   CANCELLED
```

Every transition is a conditional update in Postgres: `UPDATE rides SET status = 'ACCEPTED' WHERE rideId = ? AND status = 'OFFERED'`. If zero rows change, the transition lost a race and the caller sees the current state. This gives us linearizability on the ride document itself.

Driver exclusivity is enforced separately by a **Redis distributed lock keyed on `driverId` with a 10s TTL**. Match Service must acquire the lock before sending an offer; the lock auto-expires if the service crashes mid-dispatch. No two matchers can ever offer the same driver simultaneously. Postgres is the system of record; Redis is the dispatch mutex.

### 5. Driver Disconnections and Timeouts

Two failure modes matter:
- **Driver accepts but goes offline:** rider sees a phantom trip. Mitigation: Ride Service has a watchdog that expects the driver's location to keep ticking post-accept; if pings stop for 30s, the ride is auto-cancelled and re-queued.
- **Driver never responds to an offer:** handled by the lock TTL + the matching workflow. Encode the full "offer A, wait 10s, offer B, wait 10s, ..." loop as a **Temporal (or AWS Step Functions) workflow** so it survives Match Service crashes. Without durable execution, a pod restart mid-dispatch silently drops the request.

### 6. Peak-Demand Surge Handling

Event lets out: 100k ride requests hit the same cell in 60 seconds. Defenses:
- **Kafka in front of Match Service** absorbs the burst; consumers scale horizontally on lag.
- **Partition by geohash prefix** so a single city's surge doesn't starve other cities' consumers.
- **Expand search radius progressively** (3 km -> 5 km -> 8 km) as queue depth on that cell grows, rather than holding riders hostage waiting for a perfect local driver.
- **Surge pricing feedback loop** pulls more drivers in, but that is a product control, not a backend fix.

---

## Scaling Journey: 0 -> Infinity

This section is my own framing for how a ride-hailing backend concretely evolves. Each stage shows what you build, what you deliberately skip, and the failure that forces the next step.

### Stage 1: 0-100 Users (One city MVP)

**Goal:** Prove a rider can hail a car in a single city at all. Two engineers, one week.

**Architecture:**
- Monolithic Rails/Node app behind a single load balancer.
- One Postgres instance with PostGIS for both Rider/Driver/Ride rows and the driver location table.
- Drivers ping `POST /location` every 5s over plain HTTPS.
- Matching is a synchronous SQL query: `ST_DWithin(pickup, driver.location, 3000)` ordered by distance, pick the first available driver, row-lock them with `SELECT ... FOR UPDATE`.
- Push notifications via APNs/FCM directly from the web process.

**What you skip:**
- No Redis. No Kafka. No workflow engine.
- No websockets; HTTPS posts are fine at this volume.
- No sharding, no replicas, no multi-region.

**Failure mode that pushes to next stage:** Postgres write CPU saturates once concurrent drivers cross ~1,000 because the location table is rewritten constantly. Lock contention on `SELECT FOR UPDATE` starts adding seconds of latency to dispatch during small local surges.

### Stage 2: 100-1,000 Users

**Goal:** Stop hammering Postgres with location writes and stop blocking the request path on match.

**Architecture:**
- Split out a **Location Service** that writes driver positions to **Redis** using `GEOADD`. Postgres no longer sees ping traffic.
- Upgrade driver app to a persistent **websocket** to Location Service (one long-lived connection per driver instead of HTTPS setup cost every 5s).
- Introduce **adaptive ping intervals** on the client: 2s while moving, 15-30s while parked.
- Match Service still runs synchronously but now queries Redis `GEOSEARCH` instead of PostGIS.
- Dispatch exclusivity moves off `SELECT FOR UPDATE` onto a **Redis `SET NX PX 10000`** lock keyed on `driverId`.

**What you skip:**
- Still one Postgres primary. Still one Redis. Still one region.
- No Kafka yet; the match path is request-response.
- No durable workflow; a service crash mid-offer still drops the request, but the 10s lock TTL keeps the driver from being stuck.

**Failure mode that pushes to next stage:** Launching in a second city forces a choice. Do you put LA and NYC drivers in the same Redis sorted set? The `GEOSEARCH` runtime starts scaling with total fleet size, not local fleet size. Also, a 30-second Redis outage now drops thousands of pings and a Match Service pod crash during peak loses ride requests silently.

### Stage 3: 1K-100K Users (Multi-city)

**Goal:** Treat each city as an isolated unit. Make dispatch crash-safe.

**Architecture:**
- **City-sharded Redis:** one Redis per city (or per region). Client app includes city in its login session so the gateway routes pings to the right shard.
- **Geospatial index becomes H3 cells**, not raw geohashes. Each driver is tagged with their H3 cell at resolution ~9 (~200m edge); matching scans the pickup cell plus its six neighbors.
- **Kafka in front of Match Service.** `POST /rides` enqueues a `RideRequested` event partitioned by H3 prefix. Match Service consumers scale horizontally per partition. Consumer lag becomes the autoscaling signal.
- **Temporal workflow** owns the "offer driver A -> wait 10s -> offer driver B -> ..." loop. Survives pod restarts. Retries are free and safe.
- Postgres gets **read replicas** for rider history and driver profile reads. Writes still go to a single primary per region.

**What you skip:**
- No global dispatch yet; a rider in Tokyo cannot match a driver in Seoul (and shouldn't).
- No edge/PoP deployment; API Gateway is regional.

**Failure mode that pushes to next stage:** A single Postgres primary per region chokes at roughly 10M rides/day. Event-driven peaks (NYE, stadium events) produce 100k requests in one H3 cell in under a minute, overwhelming the consumers bound to that partition. One country's outage takes out an entire region's riders.

### Stage 4: 100K-10M Users

**Goal:** Remove the single-primary bottleneck and isolate blast radius to a single city.

**Architecture:**
- **Ride storage sharded by `rideId` hash** across many Postgres shards (Citus / Vitess / managed equivalent). Per-region routing stays the same; sharding is inside the region.
- **Location writes sharded by H3 parent cell**, not by driver. This keeps dense cells on dedicated Redis nodes and spreads load naturally.
- **Hot-cell autoscaling for consumers:** Kafka partitions per H3 prefix let the orchestrator spin up extra Match Service pods specifically for the cell that is surging, without over-provisioning the whole city.
- **Progressive radius expansion** in the matching workflow: if the queue backs up on a cell, the search radius widens from 3km to 8km automatically.
- **Per-city isolation:** a Tokyo Redis cluster failure cannot take out Seoul. Each city has its own Kafka, its own Match Service pool, its own geo index.
- **Push notifications** move behind a dedicated Notification Service with provider-specific retry logic for APNs / FCM.

**What you skip:**
- No active-active across continents. A city still belongs to exactly one region.
- No cross-region driver reuse (e.g., someone crossing a national border mid-trip is a rare edge case treated as two trips).

**Failure mode that pushes to next stage:** Global events (a new country launch, cross-border trips, consistent low latency for travelers) expose the single-region-per-city assumption. Redis AOF replication lag during regional incidents causes enough data loss to be noticeable. Regulatory pressure demands strict data residency per country.

### Stage 5: 10M+ Users (Global)

**Goal:** Global platform with regional isolation, data residency, and sub-second dispatch latency worldwide.

**Architecture:**
- **Regional cells as the unit of deployment.** Each cell is a fully self-contained stack: gateway, services, Redis H3 index, Postgres shards, Kafka, Temporal. Cells are pinned to legal regions for residency.
- **Global control plane** handles rider identity, payment methods, cross-region handoff for rare long-distance trips, and fraud. The control plane is globally replicated with eventual consistency; the dispatch plane stays strongly consistent inside a cell.
- **H3 hierarchical cells at multiple resolutions** power surge pricing (coarse cells, res 6-7) separately from dispatch (fine cells, res 9).
- **Edge PoP termination** for websockets cuts tail latency on driver pings; PoPs forward to the home cell over a backbone.
- **Chaos engineering and per-cell evacuation drills** are routine; losing any one cell degrades a city, not the planet.
- **Dynamic pricing, batching (Pool), and matching become an ML pipeline** that reads from the same Redis/H3 substrate, but feature generation and model serving are their own subsystem.

**What you skip (intentionally, forever):** A single global database. There is no operational reason to join a Tokyo ride against a New York ride in the hot path, and every attempt to build one becomes the bottleneck.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What you must nail | What is bonus |
|---|---|---|---|
| **Mid (E4)** | 80 / 20 | Clean entities and APIs. A working high-level design with one DB and a separate geo index. Recognize that plain Postgres will not scale location writes. At least a "good" answer to driver exclusivity (DB status column + timeout). | Naming a specific geospatial tech (PostGIS, Redis geo). |
| **Senior (E5)** | 60 / 40 | Move fast through the basics. Deep-dive two of: Redis geohash vs PostGIS vs H3, the distributed-lock dispatch pattern, the Kafka + Temporal durable workflow for offer timeouts. Articulate trade-offs out loud (durability vs latency, strong vs eventual consistency). Proactively spot the 2M/sec write problem and propose adaptive pings + batching. | Progressive radius expansion, city-level sharding. |
| **Staff+ (L7+)** | 40 / 60 | Drive the conversation. Three or more deep dives with original angles: H3 hex adjacency properties, hot-cell partition autoscaling, surge zone ML feedback loop, data-residency-driven cell architecture, failure modes at the driver-app side (flaky LTE, background throttling). Show calibrated opinions from real experience. The interviewer should leave having learned something. | Cross-region handoff, chaos/evacuation strategy, observability for match latency SLOs. |
