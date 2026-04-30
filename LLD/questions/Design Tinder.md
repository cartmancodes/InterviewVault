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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
   1. [The Swipe Deck Is Precomputed and Bounded](#1-the-swipe-deck-is-precomputed-and-bounded)
   2. [Active-Users-First Dramatically Improves Match Rates](#2-active-users-first-dramatically-improves-match-rates)
   3. [Mutual Match Detection Without Revealing Unmatched Swipes](#3-mutual-match-detection-without-revealing-unmatched-swipes)
   4. [Geohash vs S2 vs H3 for Radius Queries](#4-geohash-vs-s2-vs-h3-for-radius-queries)
   5. [Precise GPS Coordinates Never Leave the Device](#5-precise-gps-coordinates-never-leave-the-device)
   6. [You Don't Need Real-Time Matching](#6-you-dont-need-real-time-matching)
   7. [ELO-Style Desirability Scoring](#7-elo-style-desirability-scoring)
   8. [Swipe Rate Limiting Serves Two Purposes](#8-swipe-rate-limiting-serves-two-purposes)
   9. [The Boost Feature Creates a Thundering Herd on Deck Refresh](#9-the-boost-feature-creates-a-thundering-herd-on-deck-refresh)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Picture a **speed-dating event with a giant deck of profile cards**. The matchmaker (the system) hands you cards one at a time, and you flip "yes" or "no" by swiping. You never see who flipped "yes" on you — it's a private decision. But if two people both flipped "yes" on each other, the matchmaker rings a bell and introduces you. That bell is a **match**.

It's also like the old **dating game show**: contestants don't see who picked them until they pick someone back. The mutual-yes is the moment of revelation — anything before that stays hidden, which is what makes it feel safe to swipe right. Or imagine a **photo wall at a high school reunion**: you walk past, look at faces, and decide who you'd want to talk to. The reunion organizer quietly tracks the overlap and only tells you about the people who also wanted to talk to you.

The interesting parts are all about how the matchmaker manages the deck:

- **The geo-stack of cards.** The matchmaker hands you cards from people who are physically nearby first, because nobody wants a date 2,000 miles away. The deck is sorted by proximity before anything else.
- **Don't show the same person twice.** Like a deck of cards — once you've swiped, that profile shouldn't reappear in your feed for a long time. The matchmaker keeps a list of every face you've seen and pulls those out of the next deal.
- **Hot profiles get swarmed.** The most popular person at the speed-dating event would be approached by everyone. The matchmaker has to gently regulate this so the most-wanted person's inbox doesn't drown and the system doesn't buckle under everyone reaching for the same card at once.
- **Match storage.** When two people both say yes, it's like signing a guest book together — that match is permanent until one person tears the page out (an unmatch).

### When the analogy breaks down

A real matchmaker is polite and one-at-a-time. Real Tinder uses ML ranking, Elo-like attractiveness scores that quietly tier users into pools, paid features (Boost, Super Like, Top Picks) that buy a card priority change, and fraud detection at scale to filter bots and romance scams — far beyond a polite matchmaker with a stack of cards.

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

**The race.** User A swipes YES on user B at T=0. User B swipes YES on A at T=0+10ms. Both swipe handlers run concurrently on different app servers. Each reads "the other hasn't swiped yet" before either has written. Result: no match is created, both users are convinced the other hasn't liked them. This is a classic lost-update race, and it destroys a core product guarantee — mutual interest must be detected with certainty.

**Why the naive approaches fail.**

1. **Poll the DB every N seconds.** Latent, expensive, and you spend 2B reads/day chasing 0.1% of rows that actually have reciprocal swipes. Rejected immediately.
2. **Cassandra Lightweight Transactions (LWT).** `IF NOT EXISTS`-style compare-and-set works within a single Cassandra partition. To use it you'd have to co-locate both swipe directions in the same partition — keyed by the sorted pair `(min_id, max_id)`. This works, but LWTs carry a 4× latency penalty (two round trips for the Paxos phase), adding 20–40ms to every swipe. On a 23K req/s swipe firehose, that latency compounds. Additionally, LWT does not give you a way to atomically produce a side-effect (like publishing to Kafka) in the same operation — you'd still need a separate step to detect and emit the match.
3. **Postgres `SERIALIZABLE` transaction.** Works at small scale but becomes a write bottleneck and doesn't distribute horizontally. Fine at Stage 1, unviable at Stage 4.

**The chosen solution: Redis + Lua scripting.**

Keep a Redis hash for each user pair, keyed on the canonical pair: `swipes:{min_id}:{max_id}`. Fields are `{swiper_id}_decision` set to `YES` or `NO`. The Lua script executed on swipe does the following in a single atomic step:

```lua
local key  = KEYS[1]           -- "swipes:{min_id}:{max_id}"
local field = ARGV[1]          -- e.g. "user_42_decision"
local other = ARGV[2]          -- e.g. "user_99_decision"

redis.call("HSET", key, field, "YES")
local other_decision = redis.call("HGET", key, other)
if other_decision == "YES" then
  return 1   -- match!
end
return 0
```

Lua scripts execute atomically on a single Redis shard — no command from any other client interleaves between the `HSET` and the `HGET`. Consistent hashing on the canonical pair key ensures both swipe directions always land on the same shard. The round trip is sub-millisecond. When the script returns 1, the swipe handler publishes to the Kafka `matches` topic.

**Durability and recovery.** Redis is not the system of record. Every swipe is also durably written to Cassandra (the Swipe Store) — this write can be async and slightly behind the Redis write without correctness risk, because the match decision itself is made in Redis. If a Redis node fails before its Cassandra write completes, the pair's match state can be rebuilt from Cassandra by replaying recent swipes for that pair. The rebuild is bounded because pair keys are TTL'd out of Redis once both users have swiped (or after a fixed window, e.g., 90 days of no activity).

**Hot-entity problem.** A celebrity profile may receive 50K incoming swipes per day. Every one of those swipes creates a unique pair key, spread across different shards — this is actually safe because the pair key distributes them. The problem is the opposite: the celebrity's Bloom filter and deck entries become extremely large. Those are handled separately (see Stage 5). The match detection mechanism itself scales naturally because each pair is an independent key.

**Why not just Cassandra single-partition?** Two compounding reasons: (a) per-pair partitions for a celebrity grow to millions of rows, making compaction painful; (b) LWT latency is 4× a normal write and eats into the 300ms swipe budget. Redis gives sub-millisecond atomicity; Cassandra absorbs the durable write asynchronously.

---

### 2. Swipe Deduplication (Don't Re-Show Profiles)

The feed must exclude every user this person has already swiped on. At 100 swipes/day × 5 years, a heavy user accumulates ~180K entries. The question is how to check those 180K exclusions on every feed generation without tanking latency.

**Options evaluated.**

1. **Query Cassandra for all swipes on feed generation, pass as a `NOT IN` list.** 180K IDs shipped over the network on every feed call is a non-starter — that's ~1.4MB of payload just for the filter set. Replication lag on Cassandra also means a just-swiped profile can slip back into the feed. Rejected.
2. **Client-side session cache of recent K swipes.** The client can keep today's swipes in memory and skip them during UI rendering. This works for the hot path within a single session but fails across devices, after app restarts, and for users whose swipe history exceeds the cache window. Rejected as the sole mechanism; acceptable as a supplementary client-side optimization.
3. **Bloom filter per user in Redis (chosen).** The Feed Service maintains a Bloom filter for each user's swipe history, stored at `bloom:{user_id}`. On every swipe, the target `user_id` is inserted into the filter. On every feed generation, each candidate is checked against the filter before being included in the deck.

**Bloom filter properties and sizing.** A Bloom filter with a 1% false-positive rate requires ~9.6 bits per inserted element. At 180K swipes, that's ~216KB per user. At 10M active users with hot filters resident in Redis, that's ~2TB — you'd tier this: hot users (active today) keep their filter in Redis; cold users spill to disk and reload on login. The critical property is **no false negatives**: if a user swiped on profile X, the filter will always return "maybe contains X" for X. A false positive at 1% rate means occasionally excluding a profile the user hasn't actually swiped — slightly conservative, but far better than the inverse (re-showing a swiped profile, which destroys user trust).

**Cache loss recovery.** If the Redis node holding a user's filter is lost, rebuild from Cassandra. This is a bounded read — scan the user's swipe partition in Cassandra and reinsert all target IDs. For a user with 180K swipes, this takes ~200ms once (amortized over their next session). The first feed generated after a cold start may show one previously-swiped profile (race between filter rebuild and first feed call) — acceptable because the user can simply swipe again and the match detection layer handles idempotency.

**NO swipes vs YES swipes.** The Bloom filter stores both YES and NO swipes — we don't want to re-show someone the user already passed on either. The Match table separately tracks YES swipes. Don't conflate the two.

---

### 3. Geo-Based Feed Generation

The feed needs candidates within the user's `max_distance_km`, matching their age/gender preferences, that they haven't swiped on, ranked by some relevance score — all returned in under 300ms.

**Why naive SQL fails.** `SELECT * FROM users WHERE lat BETWEEN x1 AND x2 AND lng BETWEEN y1 AND y2 AND age BETWEEN ... AND gender IN (...)` is a multi-column range scan. B-tree indexes handle one range dimension well; two range dimensions on lat/lng plus a third on age means the planner picks one index and scans the rest, degenerating to near-full-table scans at millions of users. The lat/lng bounding box also doesn't map cleanly to a circle — you overfetch by ~27% and filter in app. Dead on arrival past a few thousand users.

**Geohash sharding as a stepping stone.** Index users by 6-character geohash (~1.2km cells). To find users within 10km, query the user's cell plus its 8 neighbors (using the geohash neighbor algorithm). Post-filter by exact distance formula. This works and is easy to implement; the limitation is that combining the geohash prefix filter with age/gender filters still requires scanning many rows per cell, and the boundary discontinuity problem (two users 10m apart in different cells) means you must always include neighbors, making the query set larger than necessary.

**Elasticsearch with `geo_point` (chosen for the online query path).** Each document in the user index contains `location` (geo_point), `age`, `gender`, `interests[]`, and `last_active_at`. A single Elasticsearch query combines a `geo_distance` filter, boolean filters on age/gender, and a scoring function that weights `last_active_at` recency. ES returns ~200 candidates in under 50ms. The index is kept fresh via CDC: Postgres profile updates flow through Debezium → Kafka → an ES writer consumer. Profile edits propagate to the index within 1–2 seconds.

**Precomputed decks in Redis (chosen for the warm query path).** For each active user, a background deck-builder job queries Elasticsearch with that user's current filters and location, produces a ranked list of ~500 candidate user IDs, and stores it at `deck:{user_id}` in Redis as a sorted set (score = relevance rank). Feed calls pop the top N IDs from the deck and hydrate them from the Profile DB. When the deck falls below a low-water mark (e.g., 50 remaining candidates), a deck-refresh job is enqueued asynchronously. Decks have a TTL of ~1 hour to ensure location staleness doesn't accumulate.

**Why both?** Precomputed decks make the p99 feed call ~5ms — you're just doing a Redis sorted-set pop plus a batch key lookup in the profile cache. Elasticsearch handles the tail cases: new users whose decks haven't been built yet, users who just changed their location or preferences (deck is invalidated on profile edit), and deck underruns. The two-path architecture lets you tune each independently: Elasticsearch index freshness is decoupled from deck TTL.

**Ranking signals.** The deck-builder scores candidates on: (1) inverse distance — closer users rank higher; (2) activity recency — users active in the last 24 hours rank substantially higher than inactive users; (3) preference match quality — a user whose stated preferences closely match the querying user's profile ranks higher; (4) ELO-style desirability score (see Insider Tips). The exact weighting is tunable and can be A/B tested without changing the architecture.

---

### 4. Match Notification Fanout

When Redis Lua confirms a mutual match, the swipe handler publishes a match event to the Kafka `matches` topic. The event payload includes both user IDs and the canonical `match_id`. A Notification Service consumer processes each event with the following steps, all idempotent on `match_id`:

1. **Write the Match row** to Postgres — this is the durable, canonical source of truth. The insert is `ON CONFLICT DO NOTHING` on `match_id` to handle Kafka redeliveries.
2. **Fan out push notifications** to both users via APNS (iOS) and FCM (Android). Each payload includes the other user's profile card (name, primary photo, `match_id`) so the client can render the "It's a Match!" overlay immediately without a follow-up fetch.
3. **Write to each user's matches inbox** — a Redis sorted set `matches:{user_id}` scored by match timestamp, so the matches tab loads in a single `ZREVRANGE` call without hitting Postgres.
4. **In-app socket notification** (optional, for users currently in the app) — the Notification Service can also push over a WebSocket or SSE connection so the match overlay appears instantly rather than waiting for an APNS/FCM round trip.

**Decoupling via Kafka is load-bearing here.** The swipe hot path returns `matched: true` to the client as soon as the Lua script confirms the match — before any of the above steps complete. The client shows the overlay immediately. The Kafka consumer handles side effects asynchronously. This means a network partition between the Kafka broker and APNS will delay the push notification but will never stall the swipe response.

**Ordering guarantees.** Because both users' notifications are published from a single Kafka message, they are always processed together by the same consumer instance. There is no risk of user A getting the match notification while user B's write to the Match table is still pending — the consumer writes the Match row first, then notifies both. If the consumer crashes after the Postgres write but before the pushes, Kafka redelivers and the `ON CONFLICT DO NOTHING` on the Match row prevents a duplicate; the push notifications fire on the retry. APNS/FCM deduplication on `apns-collapse-id` / `collapse_key` prevents the user from seeing two notifications.

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

**Failure mode that pushes to next stage.** At ~500 concurrent users, the feed query starts taking 200ms+ because the lat/lng range scan sorts through growing tables, and you notice the monolith does inline push fanout which stalls the swipe response for 300–800ms when APNS is slow.

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

**Failure mode.** At ~500K DAU, two things hurt. First, Cassandra LWTs for atomic match detection cost 20–40ms each and you're doing them on the hot path — swipe p99 starts breaching 200ms. Second, Elasticsearch sync lag via the scheduled job means users who just updated their `max_distance` still see old-radius decks for minutes. Third, celebrities / very active users generate hot pair partitions in Cassandra that compaction can't keep up with.

---

### Stage 4: 100K–10M Users

**Goal.** Sub-300ms feed, strict match consistency at millions of concurrent swipes per minute, real-time index freshness.

**Architecture.**
- **Match detection moves to Redis + Lua** (the deep dive from earlier). Swipes still durably write to Cassandra, but the canonical match decision is made in a Lua script on the Redis shard that owns the pair key. Swipe hot path is now 5–10ms.
- **Cassandra is write-through only** for swipes; reads for "have these two swiped each other" are served by Redis. Cassandra stays as the durable backup used to rebuild Redis state.
- **CDC pipeline** from Postgres to Elasticsearch via Debezium + Kafka. Profile edits land in ES within 1–2 seconds. No more scheduled sync.
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

## Insider Tips and Tricks

### 1. The Swipe Deck Is Precomputed and Bounded

On every session start, a background job generates a deck of approximately 100 candidate profiles for the user and stores it in Redis. When the user swipes, they drain the deck; when the deck falls below a low-water mark (typically 20–30 remaining candidates), the background job asynchronously refills it. This architecture decouples two operations with wildly different latency profiles: swipe UX (Redis pop + profile hydration, ~5ms) and candidate selection (Elasticsearch geo-filter + ranking, ~150–200ms). If deck generation happened synchronously on the swipe path, every swipe would feel slow — users would notice a 200ms stutter after each tap. By precomputing and buffering, the feed feels instant to the user while the expensive query runs invisibly in the background. The deck size cap (100–200 candidates) also bounds memory usage per user in Redis.

### 2. Active-Users-First Dramatically Improves Match Rates

During deck generation, profiles of users who were active within the last 24 hours receive a strong ranking boost over profiles of users who haven't opened the app in weeks or months. This is a business-critical optimization for a non-obvious reason: a match requires **mutual** interest. If the deck is full of inactive users, the active user can right-swipe all of them and receive zero matches — those users are not opening the app to swipe back. This directly destroys the core value proposition. By surfacing active users first, every right-swipe has a realistic chance of producing a match, which drives engagement, which drives retention, which drives subscription conversion. The recency signal (`last_active_at`) is one of the highest-leverage ranking features in the entire system.

### 3. Mutual Match Detection Without Revealing Unmatched Swipes

When user A right-swipes user B, the system writes `(A → B, YES)` to the Swipe table and to the Redis pair key — but does **not** notify B in any way. B has no signal that A liked them. Only when B independently right-swipes A does the system detect the mutual match and notify both users simultaneously. This asymmetric privacy guarantee is a core product requirement, not an implementation detail. It protects users from harassment: if the app notified users every time someone liked them, recipients of high volumes of unsolicited likes would feel surveilled, and users who liked someone who didn't like back would experience embarrassment. The only way to learn that someone liked you is to also like them first. Architecturally, this means the match detection result (`matched: boolean`) returned from the swipe endpoint carries significant meaning — `true` means mutual interest confirmed; the absence of a response means nothing to the other party.

### 4. Geohash vs S2 vs H3 for Radius Queries

Three spatial indexing schemes are commonly discussed in interviews:

- **Geohash** divides the Earth into a hierarchical grid of rectangular cells identified by a base-32 string. Simple to implement and widely supported. The critical weakness is **boundary discontinuity**: two users standing 10 meters apart on opposite sides of a geohash cell boundary will have completely different cell prefixes and won't appear in a simple prefix query. You must always query all 8 neighboring cells to avoid this, which inflates the query set.
- **S2 (Google)** maps the Earth's surface onto a cube and recursively subdivides, producing cells with a hierarchical ID system. Cells are more uniform in size than geohash cells and the sphere-based geometry avoids the rectangular distortion of geohash at high latitudes.
- **H3 (Uber)** uses a hierarchical hexagonal grid. Hexagons have a uniquely useful property: **every neighboring hexagon's center is exactly the same distance from the current hexagon's center**. This means radius queries are geometrically uniform — you're not over-fetching corners or missing edges. H3 is the most accurate choice for proximity-based applications. For a dating app with distance-sensitive matching, H3 is the best long-term choice.

In an interview, geohash is sufficient to demonstrate the concept and is well-understood by interviewers. If asked to compare, explain the hexagonal uniformity advantage of H3 and the discontinuity limitation of geohash. Don't present geohash as the only option.

### 5. Precise GPS Coordinates Never Leave the Device

Sending exact GPS coordinates to the server (e.g., `37.775123, -122.419456`) is a GDPR and user privacy risk — a database breach would expose every user's precise home and workplace. The correct architecture is: the **client rounds coordinates to a geohash bucket** (e.g., a 6-character geohash cell, approximately 1.2km × 0.6km) before transmitting to the server. The server stores only the geohash bucket identifier, never the raw GPS point. Distance calculations between users are therefore approximate — "within 5 miles" is shown to the user, not "0.3 miles away." This deliberate imprecision is a feature, not a limitation: it prevents stalkers from triangulating a target's precise location via the app's distance indicator. This is sometimes called **location fuzzing**, and it's required under GDPR's data minimization principle. In an interview, proactively raising this shows product awareness beyond pure systems thinking.

### 6. You Don't Need Real-Time Matching

A 5–10 second delay between a swipe being recorded and the other user's candidate pool updating is completely imperceptible. Batch precomputation — rebuilding decks every few minutes for active users — is dramatically simpler than real-time pub/sub matching. Real-time systems require maintaining persistent connections, handling reconnects, managing fan-out to millions of concurrent users, and dealing with backpressure. Batch precomputation requires a worker queue and a Redis write. Reserve real-time infrastructure for the **match notification itself** (the moment both users have liked each other), not for the continuous flow of candidate selection. This is a common mistake in interview answers: candidates assume "real-time" everywhere because it sounds more sophisticated, when in practice the business requirement only demands real-time for the match event.

### 7. ELO-Style Desirability Scoring

Tinder originally assigned each user an internal "Elo score" (the same algorithm used in competitive chess) to rank desirability. The core mechanic: being right-swiped by a high-Elo user increases your Elo more than being swiped by a low-Elo user. Being left-swiped decreases it. Users with similar Elo scores are shown to each other, creating tiered pools. The architectural implication is that Elo scores must be recomputed as swipes arrive — this is a write-time update to the user's score in the Profile DB, or in a dedicated feature store. Tinder reportedly moved away from pure Elo because it created **feedback loops**: high-score users were only shown to other high-score users, concentrating at the top and making it hard for new or underscored users to gain visibility. Modern systems blend Elo-style signals with activity recency, preference match quality, and diversity sampling to break the feedback loop. In an interview, mentioning Elo and its failure mode at scale signals awareness of real-world trade-offs beyond textbook system design.

### 8. Swipe Rate Limiting Serves Two Purposes

Limiting free-tier users to approximately 100 right-swipes per day serves two distinct goals that are easy to conflate:

- **Bot prevention**: Bots and spam accounts auto-swipe right on everyone to maximize matches for phishing or romance scams. A rate limit at the Redis layer (per `user_id`, daily rolling window using `INCR swipes:{user_id}:{date}` with a 24-hour TTL) caps the blast radius of a compromised or bot account.
- **Monetization**: Tinder Gold and Tinder Platinum remove the swipe limit. The rate limit is a deliberately engineered constraint to create upgrade pressure, not an organic system limitation.

The architectural requirement is that the rate limit check must happen **before** the swipe is written to the database — not after. If you write first and check after, a client that retries on timeout will circumvent the limit (each retry fires the write before the check sees the previous write committed). The correct order is: check Redis counter → if under limit, increment counter and proceed with swipe write → if over limit, return 429. This is a subtle but interview-worthy point about check-then-act atomicity.

### 9. The Boost Feature Creates a Thundering Herd on Deck Refresh

Tinder's "Boost" feature makes a user's profile the top card in their area for 30 minutes, dramatically increasing their visibility. From a systems perspective, this creates a **fan-out problem**: when a user activates Boost, the system needs to rapidly insert that user's profile into the precomputed decks of potentially thousands of other nearby users. If you try to do this synchronously — inline in the Boost activation request — you're making thousands of Redis writes before returning a response, which is a classic thundering herd.

The correct solution is identical to the social feed fan-out pattern: on Boost activation, publish a `boost_activated` event to a Kafka topic. A pool of async Boost workers consumes the event and fans out the profile insertion across affected users' decks, rate-limited and batched. Each worker reads nearby active users from Elasticsearch, filters those whose preference criteria match the boosted user, and appends the boosted profile to the front of their Redis deck (sorted set with a priority score higher than existing candidates). The Boost activation API returns immediately; the fan-out completes asynchronously over the next few seconds. This is a useful pattern to name-drop because it shows you recognize structural similarity between apparently unrelated features (social feeds, dating app boosts) at the systems level.

---

## Expected Depth by Level

| Level | Breadth / Depth Split | What "Good" Looks Like on This Problem |
|---|---|---|
| **Mid (E4)** | 80 / 20 | Cleanly define the API. Draw a high-level design covering Profile, Feed, Swipe, Match. Identify that geo-filtering and swipe dedup need thought. Knows what a geohash or a Bloom filter is and can name-drop Elasticsearch / Redis without deep mechanics. Does not need to go deep on Cassandra internals or Lua scripting. |
| **Senior (E5)** | 60 / 40 | Sketches the basic design quickly and pivots into depth. Spends most of the interview on (a) atomic match detection, (b) feed freshness vs. latency trade-offs, (c) how the Elasticsearch index stays in sync. Proactively raises staleness, hot partitions, and the Redis-as-cache-vs-source-of-truth question. Can sketch a Lua script and a Bloom filter API. Mentions precomputed decks, active-user ranking, and the privacy guarantee around unmatched swipes. |
| **Staff+ (L6+)** | 40 / 60 | Breezes through requirements and high-level in the first 10 minutes, then treats the interviewer as a peer. Drives the deep dives — hot-entity isolation for celebrities, regional sharding for match detection, CDC pipeline correctness under Kafka rebalance, Bloom filter resizing strategy, graceful degradation when ES is down. Argues trade-offs with specifics: "we'd take 1% false-positive rate on the Bloom to keep it under 128KB per user; that's ~200K users per GB and we can fit the active cohort in a single Redis cluster." Raises Boost fan-out, Elo feedback loops, GPS fuzzing, H3 vs. geohash trade-offs, and rate-limit check-then-act ordering without being prompted. |
