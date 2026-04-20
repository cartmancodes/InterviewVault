# Design Tinder

> **Pattern**: Geo-matching / Feed
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/tinder)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   1. [Atomic Mutual-Match Detection](#1-atomic-mutual-match-detection)
   2. [Swipe Deduplication (Don't Re-Show Profiles)](#2-swipe-deduplication-dont-re-show-profiles)
   3. [Geo-Based Feed Generation](#3-geo-based-feed-generation)
   4. [Match Notification Fanout](#4-match-notification-fanout)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
   - [Stage 1: 0–100 Users (MVP)](#stage-1-0100-users-mvp)
   - [Stage 2: 100–1,000 Users](#stage-2-1001000-users)
   - [Stage 3: 1K–100K Users](#stage-3-1k100k-users)
   - [Stage 4: 100K–10M Users](#stage-4-100k10m-users)
   - [Stage 5: 10M+ Users](#stage-5-10m-users)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Tinder is a location-aware dating application where users view a vertical stack of candidate profiles, swipe right (interested) or left (not interested), and are notified when two users have mutually swiped right on each other. The interesting problems sit at the intersection of **consistency** (never miss a match), **freshness** (never re-show a swiped profile), and **low-latency geo search** at massive write volume.

### Functional Requirements

**In Scope**

1. Users can create a profile and set preferences: age range, interests, gender interested in, max distance.
2. Users can view a stack (feed) of candidate profiles filtered by their preferences and current location.
3. Users can swipe yes / no on a profile.
4. Users receive a notification when a mutual right-swipe (match) occurs.

**Out of Scope**

- Photo upload pipeline (CDN, moderation).
- Post-match messaging (that's Design WhatsApp territory).
- Premium tier (Super Likes, Boosts, Passport, Rewind).
- Fake / spam profile detection.

### Non-Functional Requirements

**In Scope**

1. **Strong consistency for matching** — if A and B both swipe right, a match must be detected and notified. A race condition cannot swallow a match.
2. **Scale**: target 20M DAU, ~100 swipes per user per day => roughly 2B swipes/day (~23K swipes/sec average, multiples higher at peak).
3. **Low-latency feed**: p99 < 300ms for the stack.
4. **No repeats**: a previously swiped profile should never reappear.

**Out of Scope**

- Fake profile / bot detection.
- Observability, alerting, fraud pipelines.
- GDPR deletion workflows.

---

## Core Entities

| Entity | Purpose | Key Fields |
|---|---|---|
| **User** | The account identity. | `user_id`, `name`, `dob`, `gender`, `location (lat, lng)`, `geohash`, `last_active_at` |
| **Profile / Preferences** | The filter set the user searches by, plus the bio shown to others. | `user_id`, `age_min`, `age_max`, `max_distance_km`, `interested_in`, `bio`, `interests[]` |
| **Swipe** | A single yes/no decision. | `swiper_id`, `target_id`, `decision` (YES/NO), `created_at` |
| **Match** | A mutual right-swipe pair — the "edge" that unlocks messaging. | `match_id`, `user_a_id`, `user_b_id` (canonicalized so `a < b`), `created_at` |

A **swipe is append-only**; a **match is derived** from a pair of reciprocal YES swipes. The ordering `a < b` on `(user_a_id, user_b_id)` matters — canonicalization lets you dedupe and partition by the pair rather than the swiper.

---

## API Design

All endpoints assume a signed JWT in `Authorization: Bearer <token>` — the server extracts the `user_id` from it rather than trusting a request-body field.

```http
POST /v1/profile
Body: { age_min, age_max, max_distance_km, interested_in, bio, interests[] }
-> 200 { profile }
```

```http
GET /v1/feed?lat={lat}&lng={lng}&limit=20
-> 200 { candidates: User[], cursor }
```

Note that `distance` is read from the profile, not the query — the client should not be able to override filter radius except through the profile update endpoint.

```http
POST /v1/swipe
Body: { target_user_id, decision: "YES" | "NO" }
-> 200 { matched: boolean, match_id?: string }
```

Returning `matched: true` synchronously lets the client show the "It's a Match!" screen without waiting on the push notification.

```http
GET /v1/matches?cursor=...
-> 200 { matches: Match[], cursor }
```

---

## High-Level Design

At a starting architecture:

```
 [Mobile]
    |
[API Gateway / Load Balancer]
    |
    +---> Profile Service  --->  Profile DB (Postgres)
    |                             + search index (Elasticsearch)
    |
    +---> Feed Service     --->  Feed Cache (Redis, per-user decks)
    |                             Geo Index (Elasticsearch geo_point / PostGIS)
    |
    +---> Swipe Service    --->  Swipe Store (Cassandra)
                                 +  Match Detector (Redis + Lua)
                                       |
                                       v
                                 Kafka "matches" topic
                                       |
                                       v
                           Notification Service (APNS / FCM)
```

Why split the services and stores:

- **Profile Service** is read-heavy and update-light. Postgres is fine.
- **Swipe Service** is write-heavy (~2B/day). Cassandra's LSM-tree write path and horizontal sharding suit this.
- **Feed Service** is latency-sensitive and benefits from precomputed per-user decks plus a geo-indexed fallback.
- **Match detection** must be atomic across two writers; Redis with Lua scripting is the cheapest way to get single-round-trip atomicity.

---

## Deep Dives

### 1. Atomic Mutual-Match Detection

**The race.** A swipes YES on B at T=0. B swipes YES on A at T=0+10ms. Both swipe handlers run concurrently on different app servers. Each reads "the other hasn't swiped yet" before either has written. Result: no match is created, both users are convinced the other hasn't seen them. This is a classic lost-update race.

**Options considered.**

1. **Poll the DB every N seconds for matches.** Dumb, latent, and you spend 2B reads/day chasing 0.1% of rows. Rejected.
2. **Cassandra Lightweight Transactions (LWT).** `IF NOT EXISTS`-style compare-and-set works within a single partition. To use it you'd have to co-locate both directions of the swipe into the same partition (keyed by the sorted pair), which inflates hot partitions for "popular" users whose pair partitions with everyone. Also, LWTs carry 4x the latency of a normal write.
3. **Redis + Lua script (chosen).** Keep a hash `swipes:{min_id}:{max_id}` with fields `{swiper_id}_decision`. The Lua script does: `HSET` the new decision, then read the other direction, and if both are `YES`, emit the match. Lua executes atomically on a single Redis shard — no other command interleaves. Consistent hashing on the canonical pair key guarantees both directions of a swipe land on the same shard.

**Durability.** Redis is not the system of record. Every successful swipe is also written to Cassandra (the Swipe Store). When a match is produced in Lua, it's published to Kafka (`matches` topic) where downstream consumers write it to the Match table and trigger notifications. If Redis loses a node before Cassandra has the swipe, we can rebuild the Redis state from Cassandra by replaying recent swipes for that pair (bounded by how long the pair partition has been active).

**Why not just Cassandra single-partition?** Two reasons: (a) per-pair partitions grow unboundedly for active users, (b) LWT latency hurts the 300ms budget. Redis gives sub-millisecond atomicity and we pay Cassandra's cost async.

### 2. Swipe Deduplication (Don't Re-Show Profiles)

The feed must exclude every user this user has already swiped on. At 100 swipes/day × 5 years, a heavy user has ~180K entries to filter against.

**Options.**

1. **Query Cassandra for all swipes on each feed generation, do a `NOT IN`.** 180K IDs is too big to ship back on every feed call, and replication lag on Cassandra means a profile just swiped can slip through.
2. **Client-side cache of recent K swipes.** Fine on the hot path for today's session, but fails on multi-device users and on very long swipe histories.
3. **Bloom filter per user (chosen).** The Feed Service keeps a Bloom filter of the user's swipe history in Redis, keyed `bloom:{user_id}`. On swipe, we insert the target into the filter. On feed generation, we check each candidate against the filter; a `maybe_contains` verdict means exclude. False positives (small, tunable, say 1%) cost us occasionally not showing an un-swiped profile, which is far better than the inverse (re-showing a swiped one — Bloom filters never produce false negatives). On cache loss we recompute the filter from Cassandra.

### 3. Geo-Based Feed Generation

The feed needs candidates within the user's `max_distance_km`, matching their preferences, that they haven't swiped on, ranked by some relevance score.

**Naive query.** `SELECT * FROM users WHERE lat BETWEEN ... AND lng BETWEEN ... AND age BETWEEN ... AND gender IN (...)`. This is a full scan on a huge table with ugly multi-dimensional index behavior. Dead on arrival.

**Options.**

1. **Geohash / quadtree sharding.** Index users by 6-char geohash (~1.2km cells). Query neighbors of the caller's cell and filter in-app. Works, but combining geo with age/interest filters still means hitting many cells and post-filtering a lot.
2. **Elasticsearch with `geo_point` (chosen for online path).** One index: each document is a user with `location`, `age`, `gender`, `interests`, plus `last_active`. A single query does geo-distance + boolean filters + scoring in one shot and returns 200 candidates in <50ms. Keep the index in sync via CDC from Postgres (Debezium -> Kafka -> ES writer).
3. **Precomputed decks (chosen for warm path).** For each user, a nightly (or on-login) background job builds a ranked deck of ~500 candidate IDs and stores it in Redis (`deck:{user_id}`). On feed call, pop from the deck and fetch profile hydrations. When the deck drops below a low-water mark (say 50), trigger a refresh from Elasticsearch.

**Why both?** Decks give us a 5ms feed call for the 90% common case. Elasticsearch handles users whose decks are empty or whose filters/location just changed (invalidate deck, query live). Stale decks are bounded by TTL (~1 hour) plus explicit invalidation on profile edits.

### 4. Match Notification Fanout

When Redis Lua emits a match, we publish to Kafka. A consumer:

1. Writes the `Match` row in Postgres (source of truth for the matches list).
2. Fans out push notifications to both users via APNS/FCM. Each user gets a payload with the other user's minimal profile card.
3. Writes an entry to each user's `matches` inbox (another Redis sorted set by timestamp) so the matches tab loads in one round trip.

Decoupling via Kafka is what lets the swipe hot path stay tight (return `matched: true` immediately) while the side-effects happen asynchronously without blocking the swipe response.

---

## Scaling Journey: 0 to infinity

Each stage lists **Goal**, **Architecture**, **What you skip**, and the **Failure mode** that forces the next stage.

### Stage 1: 0–100 Users (MVP)

**Goal.** Prove the loop: profile, swipe, match, push. Ship to TestFlight.

**Architecture.**
- Single monolith (Node or Django) on one VM.
- Postgres for everything: `users`, `swipes`, `matches` all in one DB.
- Match detection is a single SQL transaction: insert swipe, select reciprocal swipe, if present insert match. `SERIALIZABLE` isolation or explicit row lock on the canonical pair gives correctness.
- Feed is a raw SQL query with lat/lng bounding box and `NOT EXISTS (SELECT 1 FROM swipes ...)`.
- Push notifications: direct APNS/FCM call inline after the match insert.
- Images stored in S3 with a CDN in front. No moderation.

**What you skip.**
- No Redis. No Kafka. No Elasticsearch. No background workers.
- No sharding, no read replicas.
- No feed precomputation — compute on every request.
- No bloom filter — 100 users × 100 swipes = 10K rows, `NOT EXISTS` is instant.

**Failure mode that pushes to next stage.** At ~500 concurrent users, the feed query starts taking 200ms+ because the lat/lng range scan sorts through growing tables, and you notice the monolith does inline push fanout which stalls the swipe response for 300-800ms when APNS is slow.

---

### Stage 2: 100–1,000 Users

**Goal.** Decouple the slow stuff from the hot path, buy headroom without re-architecting.

**Architecture.**
- Still a monolith, but now with a **Redis** layer and a **background worker**.
- Add Redis for:
  - Session tokens.
  - Caching user profile rows (read-through).
  - A per-user deck — a simple list of candidate IDs refreshed lazily.
- Postgres gains a **GiST index** on `location` (PostGIS point) plus a composite index on `(gender, age)`. Feed query now hits the index rather than scanning.
- Push notifications move out of the request path onto an in-process job queue (BullMQ / RQ / Sidekiq). Swipe returns as soon as the match row is committed.
- Add a nightly cron to vacuum old swipes from hot tables if needed (not yet).

**What you skip.**
- Still no sharding.
- Still no Elasticsearch — PostGIS + btree indexes are fine at this scale.
- No Kafka — in-process job queue backed by Redis is enough.
- No separate swipe DB.

**Failure mode.** Around 10K users, writes to the single Postgres instance hit IO ceiling. Swipes are ~1M/day and Postgres vacuum is falling behind. Feed latency creeps up because the shared instance is fighting itself between OLTP writes and heavy geo-range reads.

---

### Stage 3: 1K–100K Users

**Goal.** Split read and write paths. Separate the swipe firehose from the profile store. Make the feed fast and consistent.

**Architecture.**
- **Split services**: Profile Service, Feed Service, Swipe Service, Notification Service — still deployable together but with clear internal boundaries.
- **Separate datastores**:
  - Profile DB remains Postgres (with 1–2 read replicas).
  - Swipe DB moves to **Cassandra**, partitioned by `(min(user_a, user_b), max(user_a, user_b))`. Write-optimized, horizontally scalable. Match detection now uses a **single-partition transaction** since both sides of a pair live in the same partition.
  - Match DB: small Postgres table, written to by the match detector.
- **Elasticsearch** introduced for the feed: a single index of `{user_id, location (geo_point), age, gender, interests, last_active}`. Feed queries hit ES, not Postgres. Sync via a scheduled job at first — good enough when profile edits are rare.
- **Precomputed decks** in Redis per user. Built on login, refreshed when the user's profile changes or the deck runs low. A deck is ~200 candidate IDs.
- **Bloom filter per user** in Redis for swipe dedup. Populated from Cassandra on first use, updated on every swipe.
- **Kafka** introduced between services. Swipes publish to a `swipes` topic; match events publish to `matches`. Notification Service consumes `matches`.

**What you skip.**
- No multi-region. No cross-datacenter replication.
- No per-shard hot-partition management yet — user pair partitions are still small.
- Ranking is simplistic: distance + recency of `last_active`. No ML.

**Failure mode.** At ~500K DAU, two things hurt. First, Cassandra LWTs for atomic match detection cost 20-40ms each and you're doing them on the hot path — swipe p99 starts breaching 200ms. Second, Elasticsearch sync lag via the scheduled job means users who just updated their `max_distance` still see old-radius decks for minutes. Third, celebrities / very active users generate hot pair partitions in Cassandra that compaction can't keep up with.

---

### Stage 4: 100K–10M Users

**Goal.** Sub-300ms feed, strict match consistency at millions of concurrent swipes per minute, real-time index freshness.

**Architecture.**
- **Match detection moves to Redis + Lua** (the deep dive from earlier). Swipes still durably write to Cassandra, but the canonical match decision is made in a Lua script on the Redis shard that owns the pair key. Swipe hot path is now 5-10ms.
- **Cassandra is write-through only** for swipes; reads for "have these two swiped each other" are served by Redis. Cassandra stays as the durable backup used to rebuild Redis state.
- **CDC pipeline** from Postgres to Elasticsearch via Debezium + Kafka. Profile edits land in ES within 1-2 seconds. No more scheduled sync.
- **Deck refresh** moves to a dedicated worker pool. On login and on deck low-water-mark, enqueue a refresh job; the worker queries ES with the user's current filters + location, ranks, and writes the deck back to Redis. TTL of decks is ~1 hour.
- **Bloom filters** persist in Redis with periodic snapshots to disk (RDB) so crashes don't require full Cassandra rebuilds. Users who exceed the filter's design capacity (say >100K swipes) get resized filters via a background job.
- **Rate limiting** at the gateway: per-user swipe cap enforced in Redis (`INCR swipes:{user}:{date}` with TTL).
- **Read replicas** for Postgres, one per region for the profile store.
- **Notification Service** scales horizontally, idempotent on `match_id` so retried Kafka messages don't double-notify.

**What you skip.**
- Still single primary region for writes. Reads can be regional but swipes globally hit one Redis cluster.
- No ML-based ranking yet — still heuristic (distance, recency, swipe-rate priors).
- No graph-based "friends of friends" features.

**Failure mode.** At ~15M DAU across multiple continents, cross-region latency to the single Redis cluster for match detection becomes the bottleneck — a user in Tokyo swipes and waits 180ms for the round trip to the us-east Redis primary. Also, the Kafka `swipes` topic is pushing 25K msg/s and a single-cluster Kafka starts to wobble. Hot partitions for celebrities (models, influencers) are melting individual Redis shards.

---

### Stage 5: 10M+ Users

**Goal.** Global low latency, hot-entity isolation, ML-ranked decks, zero-surprise match consistency.

**Architecture.**
- **Regional Redis clusters for match detection.** Pairs are routed to a region based on the users' home regions; cross-region pairs route to a designated "home" region for that pair (hash of the canonical pair key modulo regions). Most swipes stay local.
- **Global swipe log in Kafka**, multi-region with MirrorMaker 2 or a managed equivalent. Downstream consumers in each region write to local Cassandra and local Elasticsearch.
- **Hot entity isolation.** Celebrity accounts — users receiving >10K incoming swipes/day — are moved to a dedicated Redis shard class with larger memory and higher replica count. Their pair keys are salted so swipes against them distribute across multiple sub-keys that merge on read.
- **ML-ranked decks.** A candidate generator (ES query) returns ~1000 users; a ranker service (batch inference on a model that takes embeddings of both users plus interaction features) scores them; top 200 land in the deck. Reranking runs asynchronously every few minutes for active users.
- **Feature store** for user embeddings, updated via a streaming job consuming `swipes`, `matches`, `profile_updates`.
- **Matches** are stored per-user in Redis sorted sets (timestamp-scored) so the matches tab is a single `ZREVRANGE`. Postgres remains the durable store.
- **Bloom filters sharded** per user across a dedicated Redis cluster; heavy users get Counting Bloom variants so un-match actions (rarely but used in premium) can remove entries.
- **Backpressure and graceful degradation.** If Elasticsearch is slow, deck refresh falls back to a cached geohash bucket query against Cassandra (lower quality results but non-empty decks). If Redis match cluster is degraded, swipes queue to Kafka and match notifications are delayed rather than lost — swipe UX stays green.
- **Observability.** Swipe latency, match detection lag, deck hit rate, ES sync lag, push delivery rate — all dashboarded and alerted.

**What you skip.** Nothing you need for core functionality. Remaining work is product-level: premium tiers, richer matching algorithms, video profiles, content moderation pipelines, anti-spam.

**Failure mode.** Product-level, not systems-level. At this scale the bottleneck becomes the quality of the match itself — ranking, diversity, recency — not the ability to deliver it.

---

## Expected Depth by Level

| Level | Breadth / Depth Split | What "Good" Looks Like on This Problem |
|---|---|---|
| **Mid (E4)** | 80 / 20 | Cleanly define the API. Draw a high-level design covering Profile, Feed, Swipe, Match. Identify that geo-filtering and swipe dedup need thought. Knows what a geohash or a Bloom filter is and can name-drop Elasticsearch / Redis without deep mechanics. Does not need to go deep on Cassandra internals or Lua scripting. |
| **Senior (E5)** | 60 / 40 | Sketches the basic design quickly and pivots into depth. Spends most of the interview on (a) atomic match detection, (b) feed freshness vs. latency trade-offs, (c) how the Elasticsearch index stays in sync. Proactively raises staleness, hot partitions, and the Redis-as-cache-vs-source-of-truth question. Can sketch a Lua script and a Bloom filter API. |
| **Staff+ (L6+)** | 40 / 60 | Breezes through requirements and high-level in the first 10 minutes, then treats the interviewer as a peer. Drives the deep dives — hot-entity isolation for celebrities, regional sharding for match detection, CDC pipeline correctness under Kafka rebalance, Bloom filter resizing strategy, graceful degradation when ES is down. Argues trade-offs with specifics: "we'd take 1% false-positive rate on the Bloom to keep it under 128KB per user; that's ~200K users per GB and we can fit the active cohort in a single Redis cluster." |
