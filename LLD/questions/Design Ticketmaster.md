# Design Ticketmaster

> **Pattern**: Booking / Concurrency Control
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/ticketmaster)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   1. [Preventing Double-Booking](#1-preventing-double-booking)
   2. [Handling Popular Event Bursts](#2-handling-popular-event-bursts)
   3. [Search at Scale](#3-search-at-scale)
   4. [Query Result Caching](#4-query-result-caching)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
   - [Stage 1: 0 to 100 Users (MVP)](#stage-1-0100-users-mvp)
   - [Stage 2: 100 to 1,000 Users](#stage-2-1001000-users)
   - [Stage 3: 1K to 100K Users](#stage-3-1k100k-users)
   - [Stage 4: 100K to 10M Users](#stage-4-100k10m-users)
   - [Stage 5: 10M+ Users](#stage-5-10m-users)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Ticketmaster is an online ticketing platform where fans discover events (concerts, sports, theater) and purchase seats for specific shows at specific venues. The hard part is not the browsing experience; it is guaranteeing that a given seat is sold exactly once while millions of fans hammer the refresh button on a popular on-sale.

### Functional Requirements

**Core**
- Users can view an event page: metadata, venue details, performer info, and the live seat map with availability.
- Users can search events by keyword, date range, location, and category with pagination.
- Users can book one or more tickets for an event: select seats, reserve them, pay, and receive a confirmation.

**Out of scope (below the line)**
- Booking history and refunds.
- Admin flows for event/venue creation.
- Dynamic pricing and resale marketplace.
- Recommendations and personalization.

### Non-Functional Requirements

**Core**
- **Strong consistency on booking.** No two users may ever own the same seat. We accept a small hit to availability on the write path to enforce this.
- **High availability on read paths.** Browsing, search, and event pages should stay up even during regional failures.
- **Scale.** Capacity for a 10M-concurrent-user spike on a hot on-sale (Taylor Swift, World Cup finals). Read-to-write ratio roughly 100:1.
- **Latency.** Search under ~500 ms P95. Seat reservation acquire under ~200 ms.

**Below the line**
- PCI-compliant payment flow (Stripe or equivalent).
- GDPR / data residency for EU users.
- Durable write-ahead for bookings (no lost confirmed orders).
- Observability: metrics on lock contention, queue depth, payment success rate.

---

## Core Entities

| Entity | Purpose | Key Attributes |
|--------|---------|----------------|
| **Event** | A show at a venue on a date | `event_id`, `name`, `description`, `start_time`, `performer_id`, `venue_id`, `category` |
| **Venue** | The physical space | `venue_id`, `name`, `address`, `capacity`, `seat_map` (JSON of sections/rows/coords) |
| **Performer** | Artist, team, speaker | `performer_id`, `name`, `bio`, `links` |
| **Ticket** | A single seat for a single event | `ticket_id`, `event_id`, `section`, `row`, `seat_number`, `price`, `status` (AVAILABLE / RESERVED / BOOKED), `reserved_until`, `booking_id` |
| **Booking** | A purchase transaction | `booking_id`, `user_id`, `ticket_ids[]`, `total_price`, `status` (IN_PROGRESS / CONFIRMED / CANCELLED), `created_at` |
| **User** | A customer | `user_id`, `email`, `name`, `payment_method_ref` |

Key relationships: a Venue has many Events; an Event has many Tickets (pre-generated from the venue's seat map); a Booking groups one or more Tickets for one User.

---

## API Design

```
# Browse
GET  /events/search?keyword=taylor&start=2026-06-01&end=2026-09-01&city=NYC&page=1&pageSize=20
     -> { events: Event[], nextPage }

GET  /events/{eventId}
     -> { event, venue, performer, tickets: [{ ticket_id, section, row, seat, price, status }] }

# Booking (two-phase)
POST /bookings
     body: { event_id, ticket_ids: [string] }
     -> { booking_id, reserved_until }           # reserves seats, starts 10-min timer

POST /bookings/{bookingId}/confirm
     body: { payment_token }
     -> { status: CONFIRMED, receipt_url }
```

Notes:
- Booking is explicitly **two-phase**: reserve (hold) then confirm (pay). The hold TTL bounds how long a selfish user can squat on seats.
- `payment_token` is a Stripe-issued token so the server never sees raw card data.
- Auth is via JWT at the API Gateway; `user_id` is derived from the token, never trusted from the body.

---

## High-Level Design

```
                      +---------------------+
  Clients (web/app) ->|   API Gateway / LB  |-> Auth, rate-limit, routing
                      +----------+----------+
                                 |
        +----------------+-------+------+---------------+
        |                |              |               |
   Search Service   Event Service  Booking Service  Queue Service
        |                |              |               |
  Elasticsearch     PostgreSQL      PostgreSQL       Redis (sorted set)
   (inverted idx)   (events,venue)  (tickets,bookings)
                         |              |
                       Redis         Redis (distributed locks)
                      (read cache)
                                        |
                                    Stripe (payments)
```

- **API Gateway** terminates TLS, authenticates, rate-limits per user/IP, fans out to services.
- **Event Service** serves event detail pages. Hot events are cached in Redis with short TTLs; the seat map static data sits behind a CDN.
- **Search Service** fronts Elasticsearch. Events are projected from Postgres into ES via CDC (Debezium / outbox pattern).
- **Booking Service** owns tickets and bookings. It is the only service allowed to mutate ticket status.
- **Queue Service** (added later) admits users to the Booking Service during high-demand on-sales.
- **PostgreSQL** is the source of truth because we need ACID transactions for the reserve/confirm flow.
- **Redis** pulls triple duty: distributed locks for seat holds, read-through cache for event pages, and sorted-set backing for the waiting room.

---

## Deep Dives

### 1. Preventing Double-Booking

The core correctness problem: two users click "Buy" on seat A17 at the same millisecond. One must succeed, one must fail, nothing in between.

**Option A - SELECT FOR UPDATE.** Grab a pessimistic row lock on the ticket rows at reservation time and hold it through payment. Correct, but holds DB resources across a 2 to 10 minute human-latency window. At scale this exhausts Postgres connections and gives you head-of-line blocking on hot rows.

**Option B - Status column + expiry + cron.** Ticket has `AVAILABLE / RESERVED / BOOKED` plus `reserved_until`. A cron sweeps expired RESERVED rows back to AVAILABLE. Works, but the cron is a single point of failure and users see stale "reserved" status until the sweep runs.

**Option C - Implicit expiry in the transaction (recommended for moderate scale).** One atomic statement:

```sql
UPDATE tickets
   SET status = 'RESERVED', reserved_until = now() + interval '10 min', booking_id = $1
 WHERE ticket_id = ANY($2)
   AND (status = 'AVAILABLE'
        OR (status = 'RESERVED' AND reserved_until < now()))
RETURNING ticket_id;
```

If the number of returned rows is less than the number requested, roll back and tell the user some seats were just taken. No cron, no long-held locks, one network round trip.

**Option D - Redis distributed lock (recommended for hot on-sales).** Keep Postgres simple with only `AVAILABLE / BOOKED`. On seat selection do `SET seat:{event_id}:{ticket_id} {user_id} NX EX 600`. If it succeeds, the seat is held for 10 minutes. On payment success, the Booking Service writes `BOOKED` to Postgres in a transaction and deletes the Redis key. If payment fails or the user walks away, the TTL releases the hold automatically.

Trade-off: the read path (event page) must now consult Redis to render "reserved" state. Solve this with a `MGET` over the seat keys when rendering the seatmap, or by pushing hold events onto a fanout channel the client subscribes to (see deep dive 2).

### 2. Handling Popular Event Bursts

On a Taylor Swift drop, 10M users hit the booking page in the first 60 seconds. Even if each request is cheap, the seat map goes stale the moment it renders and every reservation attempt fights over the same few hundred "best" seats.

**Real-time seat map updates.** Maintain an SSE or WebSocket channel per connected client on the event page. When the Booking Service acquires a Redis hold, it publishes `{ticket_id, status: RESERVED}` to a Redis pub/sub channel keyed by event; the Event Service fans out to connected clients. Users see seats grey out in real time instead of wasting attempts on already-taken ones.

**Virtual waiting room.** This is the actual scaling lever. Before a user reaches the booking page, the API Gateway redirects them to a waiting room:

1. Client connects to the Queue Service and is added to a Redis sorted set `queue:{event_id}` scored by arrival timestamp.
2. The client holds an SSE connection that streams their position and ETA.
3. An admission worker dequeues the top N users per second, where N is sized to what the Booking Service can handle without exploding Postgres. Admitted user IDs go into `admitted:{event_id}` (Redis set) with a short TTL.
4. The Booking Service rejects any reserve call whose `user_id` is not in the admitted set.

This converts a thundering herd into a controlled trickle, makes queue position observable to the user (huge UX win), and gives ops a single knob (admission rate) to throttle the on-sale.

### 3. Search at Scale

Users search by partial names, misspellings, date ranges, and geography. `WHERE name LIKE '%taylo%'` is a full table scan; it will not survive.

**Indexed Postgres full-text search** (`tsvector` + GIN index) works up to a few million events and handles stemming and prefix matches well. Fine for MVP.

**Elasticsearch** is the real answer at scale. Project `Event` documents into ES and let its inverted index handle tokenization, fuzzy matching (`"tayler" -> "taylor"`), geo queries, and aggregations for facet counts (genre, city, date buckets). Keep ES in sync using CDC from Postgres: the Booking Service writes to an outbox table in the same transaction as the event mutation; Debezium streams outbox rows to Kafka; an ES indexer consumer applies them. This preserves exactly-once semantics relative to the source of truth.

### 4. Query Result Caching

Two layers:

- **CDN** in front of the search endpoint, keyed by the full query string, for non-personalized results. A 60-second TTL absorbs the bulk of "taylor swift nyc" repeat queries during an on-sale announcement.
- **Elasticsearch shard-level request cache** handles the warm search patterns inside the cluster. Combined with a generous filter cache, repeat date/geo slices are effectively free.

Personalized results (logged-in recommendations) bypass the CDN and use a per-user Redis cache with short TTL.

---

## Scaling Journey: 0 to Infinity

Every stage answers four questions: what is the goal, what does the architecture look like, what are we explicitly skipping, and what failure mode forces us into the next stage.

### Stage 1: 0 to 100 Users (MVP)

**Goal.** Ship a working product. Prove the two-phase reserve/confirm flow. Sell real tickets for small local events.

**Architecture.**
- Monolith (single Node/Java service) deployed on one VM or a single container.
- Single Postgres instance holding `events`, `venues`, `tickets`, `bookings`.
- Double-booking prevention via **Option C** above: atomic conditional UPDATE with `reserved_until`. No Redis, no cron.
- Search via Postgres `ILIKE` or `tsvector` + GIN index.
- Stripe for payments. Sendgrid for confirmation emails.
- Static assets (seat map SVGs) on S3 + CloudFront.

**What you skip.**
- No caching layer.
- No search engine.
- No queue.
- No read replicas, no sharding, no multi-region.
- No real-time seat map updates. Users refresh to see new availability.

**Failure mode that pushes to next stage.** A modest 500-person event sells out in 90 seconds. Postgres connection pool saturates because every booking request is holding an open transaction through Stripe's ~2 second round trip. Login and event-browsing requests start timing out because they share the same pool. Clear signal: we need to separate read traffic from write traffic and stop holding DB transactions across external calls.

### Stage 2: 100 to 1,000 Users

**Goal.** Survive small sell-outs. Keep browsing snappy while bookings are in flight.

**Architecture.**
- Split the monolith into **Event Service** (reads), **Booking Service** (writes), and **Search Service**. Still one Postgres, now with a **read replica** used by Event and Search Services.
- Restructure booking: the reserve step atomically updates ticket status in a short transaction; payment happens outside the DB transaction; confirm is a second short transaction that flips status to BOOKED.
- Add **Redis** as a read-through cache for event detail pages. TTL 30 to 60 seconds for availability counts; long TTL (hours) for static event metadata.
- Introduce a connection pooler (PgBouncer) in front of Postgres.

**What you skip.**
- Still no Elasticsearch. Postgres full-text is enough at this scale.
- No distributed lock. Option C (atomic conditional UPDATE) still holds.
- No queue. Bursts are small enough that the booking service absorbs them.

**Failure mode that pushes to next stage.** A mid-size artist announces a tour. Search latency climbs from 80 ms to 2 seconds because `tsvector` queries against a now-multi-million-row events table are saturating the read replica. Separately, Redis is getting hammered with stale reads because invalidation after each booking is racy. We need a purpose-built search engine and a faster way to expose availability changes.

### Stage 3: 1K to 100K Users

**Goal.** Handle real search traffic and medium-popular on-sales without falling over.

**Architecture.**
- Introduce **Elasticsearch**. Sync events from Postgres via an **outbox table + Debezium + Kafka + ES indexer**. Search Service now queries ES. Postgres keeps the authoritative event data.
- Switch double-booking strategy to **Option D: Redis distributed locks** with 10-minute TTL. Postgres ticket states simplify to AVAILABLE / BOOKED. Booking Service writes the Redis hold first, then accepts payment, then commits BOOKED to Postgres in one transaction and deletes the Redis key.
- Add **SSE fanout** for real-time seat map updates. Booking Service publishes hold/book events to a Redis pub/sub channel keyed by `event_id`; Event Service maintains SSE connections and relays the events.
- Horizontally scale all stateless services behind an L7 load balancer. Postgres now has one primary and two read replicas.
- Add CDN caching for search responses with short TTL.

**What you skip.**
- Still a **single Postgres primary**. All writes funnel through it.
- No virtual waiting room yet. Admission is uncontrolled.
- No sharding. No multi-region.

**Failure mode that pushes to next stage.** A Taylor Swift pre-sale announcement hits. 2M clients connect in the first 30 seconds. Three things break at once: (1) the SSE fanout server runs out of file descriptors, (2) the Redis hosting locks hits CPU ceiling because every client is also subscribing to pub/sub on it, (3) the single Postgres primary's write throughput caps out at ~5k tickets/sec while the queue of reserve-attempts grows unboundedly. The fundamental issue is that we are letting 2M people into the booking flow when we can only service 5k concurrent reservations. We need admission control.

### Stage 4: 100K to 10M Users

**Goal.** Survive a Taylor Swift drop. Turn a thundering herd into a managed queue.

**Architecture.**
- Introduce the **Queue Service** (virtual waiting room). Redis sorted set per event, scored by arrival timestamp. Admission worker dequeues at a rate tuned to the downstream Booking Service capacity. Admitted user IDs go into a Redis set with a 15-minute TTL; Booking Service rejects non-admitted users.
- **Split Redis by concern and by event** to kill hot-key problems:
  - `locks-{event_id}` cluster for seat holds (sharded by event).
  - `queue-{event_id}` cluster for waiting rooms (sharded by event).
  - `cache` cluster for event detail caching.
- **Dedicated SSE fanout tier** (or switch to a managed service like Pusher/Ably/AWS AppSync) so connection count no longer lives on application servers.
- **Postgres read replicas in multiple regions** for search and event reads. Writes still go to a single primary (bookings are already serialized by the Redis lock anyway, so primary throughput is the constraint).
- **CDN caches the waiting room page itself** aggressively, so even the "you are in line" page does not hit origin.
- Kafka becomes the backbone for async work: booking confirmation emails, analytics, seat map update fanout, ES indexing.
- Stripe interactions wrapped in an idempotency key per `booking_id` to survive retries.

**What you skip.**
- Still a single Postgres primary per region for writes. We rely on the Redis admission throttle to keep it under its ~20k writes/sec sustainable ceiling.
- No multi-region active-active writes. Bookings are pinned to the event's home region.

**Failure mode that pushes to next stage.** Ticketmaster now runs global on-sales, including the World Cup. A single region's Postgres primary cannot handle 50M concurrent waiting-room users across 128 simultaneous matches. The queue shards help, but the moment users are admitted, they all hit the same write primary for that event. Additionally, a regional AWS outage takes down an entire event's booking window, which is commercially unacceptable. We need to shard the write path by event and move to multi-region active-active.

### Stage 5: 10M+ Users

**Goal.** Run Ticketmaster-scale globally. Survive region failures. Make the write path horizontally scalable.

**Architecture.**
- **Shard Postgres by `event_id`.** Each event lives on exactly one write-primary shard; reservation/booking traffic for that event is pinned there. Use a routing layer (Vitess-style or an application-level router keyed by `event_id`) in front. Events are independent, so this shards cleanly with no cross-shard transactions.
- **Multi-region active-active for reads**. Each region has read replicas of every shard, fed by logical replication. Event pages, search, and waiting-room status all serve from the nearest region.
- **Event home region.** Writes for a given event go to that event's home region. If the home region fails, promote a replica in another region via a pre-wired failover (5-10 min RTO). Clients see a short "try again" window but the event does not go permanently dark.
- **Elasticsearch runs as a global cluster with cross-cluster replication**, sized for 100x the steady-state query load to absorb promo spikes.
- **Tiered caching**: L1 in-process LRU on Event Service, L2 Redis region-local, L3 CDN. Cache keys are versioned by a monotonic `event_version` bumped on every ticket state change, so invalidation is a single counter update.
- **Capacity pre-warming** before known on-sales: scale out the Queue Service, Redis lock cluster, and SSE tier to forecasted peak 30 minutes ahead. Run game-day drills.
- **Per-event feature flags** so ops can independently throttle admission rate, hold TTL, or disable real-time seat map updates for a specific event in distress.
- **Formal idempotency** everywhere that touches money: booking confirm, Stripe charge, refund. Idempotency keys stored in a dedicated table with a 24-hour retention.

**What you skip.**
- Strong consistency across regions for reads. Search and event pages are eventually consistent at tens-of-seconds granularity; the booking path still routes to the event's home region for linearizable writes.
- Fancy ML-driven dynamic pricing, recommendations, anti-bot fingerprinting beyond rate-limits. These are separate product investments.

At this point the system's bottleneck is no longer technical; it is venue capacity and payment-processor throughput.

---

## Expected Depth by Level

| Level | Breadth : Depth | What the interviewer expects |
|-------|-----------------|------------------------------|
| **Mid (E4)** | 80 : 20 | Clean API and data model. Correct high-level diagram. Can explain at least one workable double-booking solution (status + expiry). Interviewer drives the deep dives; candidate answers correctly when prompted. |
| **Senior (E5)** | 60 : 40 | Moves through breadth quickly and confidently. Proactively deep-dives on seat locking (distributed lock vs atomic SQL, trade-offs), search (ES vs Postgres FTS, sync strategy), and scale (caching, read replicas). Articulates trade-offs without being asked. |
| **Staff (L6+)** | 40 : 60 | Minimal hand-holding on basics. 2 to 3 expert deep dives with real operational detail: virtual waiting room design, CDC from Postgres to ES with exactly-once semantics, sharding strategy by `event_id`, capacity planning for on-sales, game-day playbooks. Offers perspective the interviewer learns from. |
