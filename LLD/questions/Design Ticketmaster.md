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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Picture the **concert box office during a Taylor Swift onsale**: there are 50,000 seats inside the stadium, but at 10:00 AM there are 2 million people online refreshing their browsers. Somebody — some piece of software — has to make sure no two fans get assigned the same seat, that nobody walks away with 100 seats while others get zero, and that the line behaves fairly. That's the entire job of Ticketmaster's backend.

Now think about the **high-school dance with limited tickets**: when you finally get to the front of the line, the volunteer "holds" a ticket for you for 10 minutes while you run to the ATM for cash. If you don't come back in time, your hold is released and the next person in line gets it. That 10-minute hold is exactly the seat-hold pattern — a temporary reservation, not a final purchase.

Or the **movie theater kiosk seating chart**: you tap a seat, it turns yellow (held just for you), then green (purchased) once you pay. If two people somehow tap the same seat at the same instant, only one wins — the system has to pick a winner deterministically and tell the loser "sorry, try another seat."

**Key challenges:**

- **The thundering herd**: at 10:00:00 AM exactly, 2 million browsers refresh in the same second. You need a **waiting room** — like a velvet rope at a club — to admit users in controlled waves rather than letting them all stampede the door at once.
- **Holding a seat without paying yet**: the 10-minute purchase window is a real auction-house concept. You get a brief, exclusive option to buy. If it expires, the seat falls back into the pool for someone else.
- **Bots vs humans**: bots are like scalpers who hire 100 friends to stand in line for them. Captchas, rate limits, and reCAPTCHA are your bouncers — they don't catch everyone, but they make the cost of cheating much higher.

### When the analogy breaks down

A real venue is far stranger than a high school dance. It has dozens of price tiers (floor vs nosebleed), dynamic pricing that changes by the minute, presales for credit-card holders and fan-club members, fan codes that gate access, geographic restrictions ("UK residents only"), and a parallel resale market where the same ticket can be sold a second time at a markup. Ticketmaster is less "one ticket booth" and more "an entire financial exchange for seats" — with all the regulatory, fraud, and arbitrage problems that implies.

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
     body: { event_id, ticket_ids: [string], idempotency_key: string }
     -> { booking_id, reserved_until }           # reserves seats, starts 10-min timer

POST /bookings/{bookingId}/confirm
     body: { payment_token, idempotency_key: string }
     -> { status: CONFIRMED, receipt_url }
```

Notes:
- Booking is explicitly **two-phase**: reserve (hold) then confirm (pay). The hold TTL bounds how long a selfish user can squat on seats.
- `payment_token` is a Stripe-issued token so the server never sees raw card data.
- `idempotency_key` is generated client-side at the start of the checkout session and sent with every mutation in the flow. This makes the entire checkout safe to retry without double-charging or double-issuing.
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
                       Redis         Redis (seat holds: SETNX NX EX)
                      (read cache)
                                        |
                                    Stripe (payments)
```

- **API Gateway** terminates TLS, authenticates, rate-limits per user/IP, fans out to services.
- **Event Service** serves event detail pages. Hot events are cached in Redis with short TTLs; the seat map SVG static data sits behind a CDN — not an API endpoint.
- **Search Service** fronts Elasticsearch. Events are projected from Postgres into ES via CDC (Debezium / outbox pattern).
- **Booking Service** owns tickets and bookings. It is the only service allowed to mutate ticket status. Seat holds live in Redis (TTL-based); Postgres is only written at confirmed payment.
- **Queue Service** (added later) admits users to the Booking Service during high-demand on-sales via a virtual waiting room backed by a Redis sorted set.
- **PostgreSQL** is the source of truth because we need ACID transactions for the confirm flow.
- **Redis** pulls triple duty: distributed TTL-based seat holds, read-through cache for event pages, and sorted-set backing for the waiting room.

---

## Deep Dives

### 1. Preventing Double-Booking

The core correctness problem: two users click "Buy" on seat A17 at the same millisecond. One must succeed, one must fail, nothing in between.

**Option A - SELECT FOR UPDATE (rejected at scale).** Grab a pessimistic row lock on the ticket rows at reservation time and hold it through payment. This is correct for small traffic but catastrophic under load. At 500K concurrent checkout attempts, every request acquires a row lock that is held for the entire 2-10 minute human payment window. Postgres connection pool exhausts within seconds, head-of-line blocking cascades across unrelated rows on the same page, and the entire booking service grinds to a halt. This approach works for 100 users; it fails violently at 500K. It should never appear in a production design for this problem.

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

If the number of returned rows is less than the number requested, roll back and tell the user some seats were just taken. No cron, no long-held locks, one network round trip. This is the right answer for events up to a few thousand concurrent buyers.

**Option D - Redis TTL-based seat hold (recommended for hot on-sales).** Keep Postgres simple with only `AVAILABLE / BOOKED`. The distributed lock lives entirely in Redis:

```
SETNX seat:{event_id}:{ticket_id} {user_id} EX 600
```

`SETNX` is atomic: if the key already exists, it returns 0 and the seat is already held. If it returns 1, the seat is held for 600 seconds (10 minutes) for this user. Payment confirmation is the only moment Postgres is written — a short transaction flips `status = 'BOOKED'` and deletes the Redis key. If the user abandons checkout or payment fails, the TTL expires and the seat is released automatically with zero cleanup code.

This decouples the hold from the DB transaction entirely. Postgres sees only confirmed writes, not speculative holds. The seat hold path is now sub-millisecond (Redis) rather than multi-millisecond (Postgres row lock). At 500K concurrent checkout attempts, Redis handles this comfortably; Postgres only sees the ~5-10% of attempts that complete payment.

The one trade-off: the event page's read path must consult Redis to determine which seats are currently held. Solve this with a `MGET` over the seat keys when rendering availability, or by pushing hold events onto a pub/sub fanout channel.

### 2. Handling Popular Event Bursts

On a Taylor Swift drop, 10M users hit the booking page in the first 60 seconds. Even if each request is cheap, the seat map goes stale the moment it renders and every reservation attempt fights over the same few hundred "best" seats.

**Real-time seat map updates.** Maintain an SSE or WebSocket channel per connected client on the event page. When the Booking Service acquires a Redis hold, it publishes `{ticket_id, status: RESERVED}` to a Redis pub/sub channel keyed by event; the Event Service fans out to connected clients. Users see seats grey out in real time instead of wasting attempts on already-taken ones.

**Virtual waiting room — the actual scaling lever.** Before a user reaches the booking page, the API Gateway redirects them to a waiting room:

1. Client connects to the Queue Service and is assigned a position in a Redis sorted set `queue:{event_id}` scored by arrival timestamp.
2. The client holds an SSE connection that streams their current position and estimated wait time.
3. An admission worker dequeues the top N users per second, where N is sized to what the Booking Service can sustain without overwhelming the Redis hold cluster or Postgres. Admitted user IDs go into `admitted:{event_id}` (Redis set) with a short TTL.
4. The Booking Service rejects any reserve call whose `user_id` is not in the admitted set.
5. Queue position is always server-side. The client receives a signed JWT encoding their position and a timestamp; the server validates this on every status poll. A client that modifies its reported position is rejected.

This converts a thundering herd into a controlled trickle. Ops has a single knob — the admission rate — to throttle the on-sale in real time. Queue depth and admission rate become the primary operational metrics during a hot sale.

### 3. Search at Scale

Users search by partial names, misspellings, date ranges, and geography. `WHERE name LIKE '%taylo%'` is a full table scan; it will not survive.

**Indexed Postgres full-text search** (`tsvector` + GIN index) works up to a few million events and handles stemming and prefix matches well. Fine for MVP.

**Elasticsearch** is the production answer. Project `Event` documents into ES and let its inverted index handle tokenization, fuzzy matching (`"tayler" -> "taylor"`), geo queries, and aggregations for facet counts (genre, city, date buckets). Keep ES in sync using CDC from Postgres: the Booking Service writes to an outbox table in the same transaction as the event mutation; Debezium streams outbox rows to Kafka; an ES indexer consumer applies them. This preserves exactly-once semantics relative to the source of truth.

**Shard ES by `event_id`**, not by venue or category, to keep the write path simple. Hot events get disproportionate query traffic; ES shard routing by `event_id` contains this load to one shard.

### 4. Query Result Caching

Two layers:

- **CDN** in front of the search endpoint, keyed by the full query string, for non-personalized results. A 60-second TTL absorbs the bulk of "taylor swift nyc" repeat queries during an on-sale announcement.
- **Elasticsearch shard-level request cache** handles the warm search patterns inside the cluster. Combined with a generous filter cache, repeat date/geo slices are effectively free.

Personalized results (logged-in recommendations) bypass the CDN and use a per-user Redis cache with short TTL.

For the event detail page, use a three-tier cache: in-process LRU on each Event Service pod (L1), regional Redis (L2), and CDN (L3). Cache keys are versioned by a monotonic `event_version` counter bumped on every ticket state change. Invalidation is a single counter increment — no key enumeration, no cache stampede.

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
- Switch double-booking strategy to **Option D: Redis TTL-based seat holds** with `SETNX ... EX 600`. Postgres ticket states simplify to AVAILABLE / BOOKED. Booking Service writes the Redis hold atomically, then accepts payment, then commits BOOKED to Postgres in one short transaction and deletes the Redis key.
- Add **SSE fanout** for real-time seat map updates. Booking Service publishes hold/book events to a Redis pub/sub channel keyed by `event_id`; Event Service maintains SSE connections and relays the events.
- Horizontally scale all stateless services behind an L7 load balancer. Postgres now has one primary and two read replicas.
- Add CDN caching for search responses with short TTL.

**What you skip.**
- Still a **single Postgres primary**. All writes funnel through it.
- No virtual waiting room yet. Admission is uncontrolled.
- No sharding. No multi-region.

**Failure mode that pushes to next stage.** A Taylor Swift pre-sale announcement hits. 2M clients connect in the first 30 seconds. Three things break at once: (1) the SSE fanout server runs out of file descriptors, (2) the Redis instance hits CPU ceiling because every client is also subscribing to pub/sub, (3) the single Postgres primary's write throughput caps out at ~5k tickets/sec while the queue of reserve-attempts grows unboundedly. The fundamental issue is that we are letting 2M people into the booking flow when we can only service 5k concurrent reservations. We need admission control.

### Stage 4: 100K to 10M Users

**Goal.** Survive a Taylor Swift drop. Turn a thundering herd into a managed queue.

**Architecture.**
- Introduce the **Queue Service** (virtual waiting room). Redis sorted set per event, scored by arrival timestamp. Admission worker dequeues at a rate tuned to the downstream Booking Service capacity. Admitted user IDs go into a Redis set with a 15-minute TTL; Booking Service rejects non-admitted users.
- **Split Redis by concern and by event** to kill hot-key problems:
  - `locks-{event_id}` cluster for seat holds (sharded by event).
  - `queue-{event_id}` cluster for waiting rooms (sharded by event).
  - `cache` cluster for event detail caching.
- **Dedicated SSE fanout tier** (or switch to a managed service like Pusher/Ably/AWS AppSync) so connection count no longer lives on application servers.
- **Postgres read replicas in multiple regions** for search and event reads. Writes still go to a single primary (bookings are already serialized by the Redis hold anyway, so primary throughput is the constraint).
- **CDN caches the waiting room page itself** aggressively, so even the "you are in line" page does not hit origin.
- Kafka becomes the backbone for async work: booking confirmation emails, analytics, seat map update fanout, ES indexing.
- Stripe interactions wrapped in an idempotency key per `booking_id` to survive retries.
- **Pre-scale 30 minutes before known on-sales.** Auto-scaling reacts in minutes; a hot on-sale spike peaks in seconds. Queue Service, Redis lock cluster, and SSE tier must be at target capacity before the on-sale moment, not after.

**What you skip.**
- Still a single Postgres primary per region for writes. We rely on the Redis admission throttle to keep it under its ~20k writes/sec sustainable ceiling.
- No multi-region active-active writes. Bookings are pinned to the event's home region.

**Failure mode that pushes to next stage.** Ticketmaster now runs global on-sales, including the World Cup. A single region's Postgres primary cannot handle 50M concurrent waiting-room users across 128 simultaneous matches. The queue shards help, but the moment users are admitted, they all hit the same write primary for that event. Additionally, a regional AWS outage takes down an entire event's booking window, which is commercially unacceptable. We need to shard the write path by event and move to multi-region active-active.

### Stage 5: 10M+ Users

**Goal.** Run Ticketmaster-scale globally. Survive region failures. Make the write path horizontally scalable.

**Architecture.**
- **Shard Postgres by `event_id`.** Each event lives on exactly one write-primary shard; reservation/booking traffic for that event is pinned there. Use a routing layer (Vitess-style or an application-level router keyed by `event_id`) in front. Events are independent, so this shards cleanly with no cross-shard transactions. Note: sharding by `venue_id` would be wrong — all events at Madison Square Garden would land on one shard, defeating the purpose.
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

## Insider Tips and Tricks

These are the production realities that separate a textbook answer from a real engineering discussion. Knowing these signals to an interviewer that you have thought about the problem at operational depth, not just design depth.

### SELECT FOR UPDATE Is the Wrong Answer at Scale

Pessimistic DB row locks are the most common first instinct and the most common mistake. They work correctly for 100 concurrent users but cause lock contention cascades at 500K concurrent checkout attempts. Each lock is held across a multi-second payment round trip, meaning Postgres connection slots fill up, the lock wait queue grows, and unrelated queries on the same table page block. The production pattern avoids this entirely: use `SETNX seatId userId EX 600` in Redis for the hold phase. This operation is atomic, distributed across a Redis cluster, and automatically expires without any cleanup code. Postgres only sees a write when payment confirms. The DB is the ledger of truth, not the gatekeeper of speculative intent.

### The Taylor Swift 2022 Failure Was an Admission Control Problem

Ticketmaster's Verified Fan presale for Taylor Swift's Eras Tour collapsed because approximately 14 million people attempted access simultaneously — roughly 4x the stated system capacity. The architectural failure was not seat locking logic or database schema. It was insufficient virtual queue admission control: too many users were admitted to the checkout flow simultaneously, overwhelming the seat inventory service. A properly designed waiting room would have throttled admission to match checkout throughput — for example, admitting N users per second where N equals the sustained booking completion rate. Instead, waves of users were let through in batches that the backend could not absorb. When you discuss the virtual queue in an interview, this is the real-world consequence of getting that admission rate wrong.

### Virtual Waiting Queue Token Design

The queue issues a signed JWT when a user joins, encoding their position, a server-generated timestamp, and an expiry. Queue position is always server-side — the server owns the sorted set and the authoritative position. The JWT is evidence of the server's assertion, not a value the client controls. When the user's position reaches the front, the Queue Service signals them via SSE or WebSocket with a short-lived "proceed to checkout" token (for example, a 10-minute window). If the user does not complete checkout within that window, the token expires, the seat hold TTL fires, and the next user in line is admitted. A client that modifies the JWT or the reported position will fail signature validation and be rejected. Never trust client-reported queue position.

### Showing "2 Tickets Remaining" Is Intentionally Inaccurate

Production ticketing systems do not display exact remaining inventory. Showing the precise count leaks inventory data (useful for bots targeting the last few seats), enables panic behavior (every user rushes to checkout when they see "2 remaining", spiking load exactly when the system is most fragile), and creates false urgency that backfires if the system is under load. Instead, systems display approximate buckets ("a few remaining", "limited availability", "less than 10") or nothing at all for the last handful of seats. This is a deliberate product and systems decision. In an interview, knowing this demonstrates awareness that the UI contract is not just a display concern — it directly affects backend load patterns.

### Seat Map Is a Static Asset, Not an API Call

The venue seat map SVG, which can exceed 500KB, must be served from a CDN, not your application API. On sale day, millions of users load the seat map simultaneously. At 1 million concurrent users loading a 500KB SVG, that is 500GB of transfer in a matter of minutes — catastrophic for an application server, completely routine for a CDN. Only seat availability — a small JSON payload listing which `ticket_id` values are AVAILABLE, HELD, or BOOKED — is dynamic and served from the API. The API response for the event page should return a reference to the CDN URL for the seat map, not the map itself. This separation is the single most impactful bandwidth optimization in the entire system.

### Shard by Event ID, Not Venue ID

Events are the unit of contention. All buyers competing for a given concert are competing for seats within a single event. Sharding by `event_id` isolates that contention to one DB shard, one Redis keyspace prefix, and one admission queue. Sharding by `venue_id` would concentrate all events at Madison Square Garden — potentially dozens of active events — onto the same shard, which recreates the hot-shard problem you were trying to solve. The key insight is to shard by the unit of concurrency, not the unit of geography or organizational hierarchy. In the waiting room, queue keys are `queue:{event_id}`; seat hold keys are `seat:{event_id}:{ticket_id}`; Postgres sharding uses `event_id` as the routing key. Consistency across the stack matters.

### Idempotency Key Spans the Entire Checkout

The seat hold, payment charge, and ticket issuance are three distinct network calls. Any of them can fail transiently and be retried by the client or an internal retry policy. Without an idempotency key, a network timeout after the Stripe charge succeeds but before the confirmation response arrives will cause the client to retry, charging the user twice. The correct design: generate a single idempotency key client-side at the moment the user clicks "begin checkout." Send this key as a header or body field with every API call in the flow — `POST /bookings`, `POST /bookings/{id}/confirm`, and the Stripe charge. The server stores each (idempotency_key, operation) pair with its result; a duplicate request returns the stored result immediately without re-executing. Keys are retained for 24 hours. This is not optional plumbing — it is the mechanism that makes the checkout flow safe to retry.

### Overselling by Design for General Admission

For GA (standing room only) events with no assigned seats, slight intentional overselling is standard practice. The system tracks `total_capacity` and `total_sold` and permits `total_sold` to exceed `total_capacity` by a configurable buffer — typically 2–3% — to account for expected no-shows, cancellations, and payment failures. This is not a bug or a race condition; it is a deliberate business and product decision that must be explicitly modeled in the schema. The buffer percentage is set per-event based on historical no-show rates. Assigned-seat events must never oversell (a seat physically exists once). GA events can absorb a buffer. If an interviewer asks whether your system can oversell, the correct answer distinguishes these two cases.

### The "On-Sale" Moment Is a Special Case

The traffic curve for a hot on-sale is unlike normal traffic patterns: flat baseline, then a 100x spike at a precise known time (often 10:00 AM local), then a sharp decline as seats sell out. This predictability is both an opportunity and a trap. The opportunity: you know the spike is coming and can prepare. The trap: auto-scaling is too slow — cloud auto-scaling takes 3–5 minutes to provision new instances, and the spike peaks in under 60 seconds. The production playbook is manual pre-scaling: 30 minutes before the on-sale, scale the Queue Service, Redis lock cluster, and SSE fanout tier to forecasted peak capacity. Additionally: CDN-cache the event landing page aggressively so the origin does not serve it at all, pre-warm the Redis cache for the event object, and pre-position queue admission capacity. During the on-sale, ops monitors the admission rate knob in real time and can throttle it down if any downstream service shows stress. This is capacity planning, not just system design.

---

## Expected Depth by Level

| Level | Breadth : Depth | What the interviewer expects |
|-------|-----------------|------------------------------|
| **Mid (E4)** | 80 : 20 | Clean API and data model. Correct high-level diagram. Can explain at least one workable double-booking solution (status + expiry). Interviewer drives the deep dives; candidate answers correctly when prompted. |
| **Senior (E5)** | 60 : 40 | Moves through breadth quickly and confidently. Proactively deep-dives on seat locking (Redis TTL hold vs atomic SQL, trade-offs, why SELECT FOR UPDATE breaks at scale), search (ES vs Postgres FTS, sync strategy), and scale (caching, read replicas, CDN for seat maps). Articulates trade-offs without being asked. Mentions idempotency for the checkout flow. |
| **Staff (L6+)** | 40 : 60 | Minimal hand-holding on basics. 2 to 3 expert deep dives with real operational detail: virtual waiting room token design and admission rate calculus, CDC from Postgres to ES with exactly-once semantics, sharding by `event_id` with explicit reasoning why not `venue_id`, capacity pre-warming playbook for on-sales, intentional oversell modeling for GA events. References the Taylor Swift failure as an admission control problem, not a database problem. Offers perspective the interviewer learns from. |
