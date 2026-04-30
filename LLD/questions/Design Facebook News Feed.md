# Design Facebook News Feed

> **Pattern**: Fan-out / Feed Aggregation
> **Difficulty**: Medium–Hard
> **Sources**: [Hello Interview](https://www.hellointerview.com/learn/system-design/problem-breakdowns/fb-news-feed) · Twitter/Meta/LinkedIn/Pinterest Engineering Blogs

---

## Table of Contents

- [Understanding the Problem](#understanding-the-problem)
- [Core Entities](#core-entities)
- [API Design](#api-design)
- [High-Level Design](#high-level-design)
- [Deep Dives](#deep-dives)
  - [1. Heavy Follower Lists (Fan-out on Read)](#1-heavy-follower-lists-fan-out-on-read)
  - [2. Celebrity Problem (Fan-out on Write)](#2-celebrity-problem-fan-out-on-write)
  - [3. Viral Post Hot Partitions](#3-viral-post-hot-partitions)
  - [4. Feed Ranking Pipeline](#4-feed-ranking-pipeline)
  - [5. Negative Feedback Signals](#5-negative-feedback-signals)
  - [6. Real-Time Sequence Features](#6-real-time-sequence-features)
  - [7. Pagination Correctness with Hybrid Fanout](#7-pagination-correctness-with-hybrid-fanout)
- [Fanout Strategy Tradeoff Matrix](#fanout-strategy-tradeoff-matrix)
- [Scaling Journey: 0 → ∞](#scaling-journey-0--)
- [Insider Tips and Tricks](#insider-tips-and-tricks)
- [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A news feed delivers a personalized, reverse-chronological (or ranked) stream of posts from followed accounts to billions of users, at sub-second latency. The core tension: writes create posts once, but reads consume those posts billions of times per day — and follower counts range from 0 to 100M+, making per-user fan-out wildly asymmetric.

**Real-world data point:** Twitter observed a **50:1 read-to-write ratio** — 300K read QPS vs 6K write QPS. This ratio is the single biggest architectural driver.

### Functional Requirements

**In scope:**
1. Users can create posts
2. Users can follow/unfollow other users
3. Users can view a feed of posts from accounts they follow, in reverse chronological order (with optional ranking)
4. Feed supports infinite scroll / pagination

**Out of scope:** likes, comments, privacy controls, recommendation/ranking (unless explicitly asked)

### Non-Functional Requirements

1. **High availability** over strong consistency — up to 1 minute of staleness is acceptable
2. **Low latency**: < 500ms for both post creation and feed retrieval (Twitter target: tweet appears in follower timelines within 5 seconds; inactive users see ~3s cold rebuild vs ~400ms warm)
3. **Scale**: 2B users; follower counts range from 1 to 100M+
4. **Read-heavy**: reads vastly outnumber writes; optimize for read path

---

## 🧒 Layman's Explanation

Strip away the jargon and the news feed is basically a **gossipy friend** — the one in your social circle who somehow knows what everyone's been up to and gives you the highlights every time you bump into them. They don't tell you everything (you'd be there for hours); they cherry-pick the 30 things you're actually likely to care about, sorted roughly by what they think will interest you most.

Another way to picture it: you're an **editor of a personal newspaper** that comes out fresh every time you open the app. You have 500 friends, all of whom file stories every day. The front page only fits 30 articles. Your job — well, the system's job — is to decide which 30 deserve the front page and in what order.

A simpler framing: a **bulletin board with limited space**. Hundreds of friends pinning notes. The board can't show them all, so it picks which to display first, demotes the boring ones, and refreshes constantly.

### The hard parts in plain language

- **Push (fan-out on write)**: when your friend posts a photo, the system *immediately copies that post into your pre-built feed list*. Your reads are then trivially fast — just read your own list. The downside: your friend with 100M followers triggers 100M writes per post. That's why we don't push for celebrities.
- **Pull (fan-out on read)**: for celebrities, we *don't* pre-copy. Instead, when you open the app, the system fetches the few celebrities you follow, queries their recent posts live, and merges them in. Reads are slower but writes stay sane.
- **Hybrid is the real answer**: push for normal accounts, pull for celebrities, merge at read time. Nearly every social network at scale does this.
- **Ranking**: pure newest-first feels nice but loses to ML-ranked feeds where each candidate post is scored on "how likely will this person engage?" Higher scores float up.
- **Cursor pagination**: as you scroll, new posts keep arriving at the top. If pagination used "skip 20, give me the next 20" you'd see duplicates and skips. Cursors freeze your reading position.

### When the analogy breaks down

The real Facebook News Feed is one of the most sophisticated production ML systems on Earth. It's retrained constantly on billions of engagement signals, weaves in ads from a real-time auction, balances political content under regulatory scrutiny, suppresses misinformation, and personalizes per user across multiple surfaces (feed, Reels, Stories, Marketplace). The friendly gossip analogy hides all of that — and the operational machinery (Kafka pipelines, sharded fan-out workers, hot-key mitigation, multi-region replication) needed just to keep the lights on at 2 billion DAU.

---

## Core Entities

| Entity | Description |
|---|---|
| **User** | An individual participant |
| **Follow** | Uni-directional edge: `follower_id → followed_id` |
| **Post** | Content authored by a user, visible to followers |
| **FeedEntry** | A precomputed reference (`userId → [postId, timestamp]`) in the feed cache |

---

## API Design

```
POST /posts
  body: { content, mediaUrls? }
  → { postId, createdAt }

PUT /users/{id}/follow          # idempotent
  → 200 OK

DELETE /users/{id}/follow
  → 200 OK

GET /feed?pageSize={n}&cursor={timestamp?}
  → { posts: Post[], nextCursor: string }
```

**Cursor design:** Use the `createdAt` timestamp of the oldest post on the current page as the cursor. Subsequent pages fetch posts older than that timestamp. This is stable under new writes — new posts arrive at the top and don't shift page offsets.

---

## High-Level Design

### Data Model

**Posts table** (DynamoDB / Cassandra):
```
PK: postId (UUID)
SK: -
Attrs: authorId, content, mediaUrls, createdAt

GSI: (authorId, createdAt DESC) — enables "latest posts by author" scan
```

**Follows table**:
```
PK: followerId
SK: followedId
GSI: (followedId, followerId) — reverse lookup: "who follows account X?"
```

**PrecomputedFeed table** (Redis Sorted Set per user):
```
Key:   feed:{userId}
Score: createdAt timestamp (Unix ms)
Value: postId

Capped at 200 entries via ZREMRANGEBYRANK after each insert.
```

### Write Path (Post Creation)

```
Client → API Gateway → Post Service → DynamoDB (posts table)
                                    → SQS (fanout event: {postId, authorId})
                                    ↓
                              Worker Fleet
                                    ↓
                    For each follower (if follower count < threshold):
                        ZADD feed:{followerId} {timestamp} {postId}
                        ZREMRANGEBYRANK feed:{followerId} 0 -201  (keep top 200)
```

### Read Path (Feed Retrieval)

```
Client → Feed Service
              ↓
         ZREVRANGEBYSCORE feed:{userId} +inf {cursor} LIMIT {pageSize}
              ↓                                        ↑
     For celebrity follows:                    (O(1) cache lookup for normal users)
         Query Post GSI (authorId, createdAt < cursor LIMIT 20)
              ↓
         Merge + sort + hydrate post content
              ↓
         Return to client
```

---

## Deep Dives

### 1. Heavy Follower Lists (Fan-out on Read)

**Problem:** A user following 5,000 accounts triggers 5,000 DB queries per feed load, then a merge-sort of potentially 100K posts — all on the read path.

**Solution — Precomputed Feeds (Fan-out on Write):**

Each user maintains a Redis sorted set (`feed:{userId}`) of up to 200 post IDs, scored by creation timestamp. On post creation, an async worker fleet fans out the post ID to each follower's sorted set.

Storage math: 200 posts × 16 bytes (postId + score) × 2B users ≈ **6.4TB** — well within range.

The read path becomes a single Redis `ZREVRANGEBYSCORE` — O(log N + M) where M is page size. No scatter-gather.

**Why cap at 200?** Deep pagination (page 10+) is rare. Users who scroll past 200 entries are served from the raw DB with a full scatter-gather — this is acceptable since it's an exceptional case.

---

### 2. Celebrity Problem (Fan-out on Write)

**Problem:** A user with 100M followers (Lady Gaga, Cristiano Ronaldo) creates 100M Redis writes per post. At even 1μs per write, that's 100 seconds of serialized work. Celebrity posts monopolize the worker fleet, delaying fanout for everyone else.

**Bad solution:** Direct synchronous writes from Post Service. Hits connection limits; single host does all the work.

**Good solution — Async worker queue:**
- Post Service enqueues `{postId, authorId}` to SQS (single message)
- Worker fleet picks up the message and fans out to followers
- Problem: variable work per message (1K followers vs 100M followers) — queue depth is a misleading health signal

**Better solution — Write-path worker sharding by authorId:**

Shard the fanout worker fleet by `authorId`, not by `followerId`. This is non-obvious but critical. If sharded by followerId, a celebrity's 100M follower updates would be processed by every shard simultaneously — spreading the load but making the queue depth unpredictable. If sharded by authorId, the celebrity's fanout is contained to a specific shard, making it predictable and isolatable without affecting other users posting simultaneously.

**Best solution — Hybrid model (production standard):**

Mark accounts above a follower threshold (e.g., 1M) as "non-precomputed" in the Follow table. Workers skip these accounts.

At read time, the Feed Service:
1. Reads the user's precomputed feed from Redis (normal accounts)
2. Queries the Post table's GSI for each celebrity the user follows: `(authorId, createdAt < cursor LIMIT 20)`
3. Merge-sorts the two streams

The celebrity set is typically small (most users follow < 5 celebrities), so the live query cost is manageable and bounded.

**Real-world validation:** Twitter explicitly does not fanout tweets from high-follower accounts. Celebrity tweets are fetched and merged at read time against the user's precomputed home timeline stored in Redis (Haplo/HybridList).

---

### 3. Viral Post Hot Partitions

**Problem:** A viral post gets millions of reads per second. DynamoDB (and most hash-partitioned stores) routes all requests for a given key to the same partition. One post = one hot partition = throughput cap hit.

**Good solution — Redis cache in front of DB:**
- Post content cached by `postId`
- LRU eviction, long TTL
- Flaw: if the cache is sharded, the hot key still hits one shard node

**Best solution — Replicated (not sharded) cache cluster:**
- Run N Redis replicas behind a load balancer
- Every replica holds a full copy of all cached posts (no sharding)
- A viral post's traffic is spread across all N replicas — effective throughput scales linearly with N
- Accepts higher memory cost (N × data) but eliminates the hot-shard problem entirely
- No inter-replica coordination required

**Additional technique — Local in-process cache (L1):**

For posts receiving millions of reads/second, add a small in-process LRU cache (e.g., Caffeine in Java, functools.lru_cache in Python) in each Feed Service instance. The cache holds the top ~1,000 hottest posts with a 1-5 second TTL. This eliminates even Redis round-trips for the hottest content. Twitter calls this pattern "multi-tier caching."

---

### 4. Feed Ranking Pipeline

Reverse-chronological order works but is suboptimal — a user who follows 2,000 accounts will miss high-quality posts that arrive during their working hours. At scale, feeds are ranked.

**Industry-standard multi-stage funnel (Meta, Instagram, LinkedIn, Pinterest, TikTok):**

```
Total eligible posts (1,000+ per user per day)
         ↓
  Candidate Retrieval (ANN embedding search)    → ~2,000 candidates
         ↓
  Pre-Ranking / Early-Stage (lightweight model)  → ~200 candidates
         ↓
  Full Ranking (heavy multitask neural network)  → ~50 candidates
         ↓
  Reranking (diversity, integrity, business rules) → final feed
```

**Why stages exist:**
- Full ranking models cannot run on 2,000 candidates within a 500ms latency budget
- Pre-ranking prunes "easy negatives" the full ranker would score very low anyway
- Reranking applies list-level constraints (diversity, deduplication, ad insertion) that pointwise scoring can't express

**Meta's 3-pass system specifically:**

- **Pass 0**: Lightweight model selects ~500 most-relevant posts from total inventory
- **Pass 1**: Multitask neural networks score each candidate. Scoring formula:
  `V = w₁·P(like) + w₂·P(comment) + w₃·P(share) + w₄·P(click) – w₅·P(hide)`
  Each weight is learned; the negative term for hide is explicit
- **Pass 2**: Contextual refinement — content-type diversity (prevent 5 consecutive videos), unread bumping, action bumping

**Pre-ranking distillation (Pinterest/Instagram pattern):**

Rather than training the pre-ranker to predict engagement directly, train it to predict the full ranker's scores (KL divergence distillation loss). The pre-ranker mimics the expensive model's outputs at a fraction of the compute. When the full ranker is updated, the pre-ranker automatically inherits improvements via retraining the distillation objective.

**Two-Tower retrieval (Instagram Explore):**

- One neural network encodes the user; one encodes the item (post)
- Item embeddings are pre-generated offline daily — they don't change per query
- User embeddings are computed on-demand
- Result: O(1) offline item embedding cost; only user encoding is real-time
- Similarity search via FAISS/HNSW returns nearest-neighbor candidates in <10ms

**Dwell time as a passive ranking signal (LinkedIn):**

Dwell time is measured when at least 50% of an item is visible on screen. LinkedIn found a natural threshold T_skip below which users consistently skip content — and this threshold is consistent across content formats. A logistic regression P(skip) model trained on dwell time features below this threshold provides a signal that complements explicit click/engagement signals and captures passive disinterest.

---

### 5. Negative Feedback Signals

This is rarely covered in standard interview prep but critical to production feeds.

**Meta's negative feedback tiers (differential weights):**

| Signal | Demotional Weight | Notes |
|---|---|---|
| **Report as spam/abuse** | Highest | Also feeds integrity detection |
| **Hide post** | High | User explicitly doesn't want this content |
| **See less / Show less** | Moderate | Softer preference; less penalty than Hide |
| **Angry reaction** | Ambiguous | Legitimate for news content; analyzed separately |
| **Survey: "not worth your time"** | Aggregate | Human-in-the-loop weight adjustment |

Key insight: Hide and See Less have different weights intentionally. A user hiding a post is a strong signal about that specific content. A user clicking "show less" is expressing a softer content-type preference.

**Unread Bumping and Action Bumping (Meta):**

- **Unread bumping**: Posts that arrived while the user was offline are recirculated in the next session. Prevents high-quality content from being buried under new posts just because the user was away.
- **Action bumping**: A post from 2 days ago that suddenly receives a burst of new comments is re-surfaced. Requires near-real-time monitoring of post engagement velocity and triggering re-insertion events into active user feeds.

Both are handled in Pass 2 of Meta's ranking pipeline — the contextual refinement stage that can see list-level state.

---

### 6. Real-Time Sequence Features

**Problem:** Static long-term user embeddings (updated daily) capture what a user likes in general but miss short-term intent shifts — "I'm in a sports mood right now" vs. "I'm interested in cooking this week."

**Pinterest's TransAct approach:**
- Input: last 100 user actions as a sequence: `(item_embedding, action_type, timestamp)` per action
- Action types include positive (repin, click) and negative (hide) — negative actions are first-class inputs
- Random time-window masking on recent actions prevents the model from memorizing positional recency rather than learning interest patterns
- Output compressed to first 10 tokens + max-pooling token — not full sequence flattening
- Measured impact: **+6% repin volume, +11% improvement for new/cold-start users, -10% hide volume**

**GPU serving requirement:** Serving TransAct-style sequence models on CPU increased latency 20× over baseline. GPU serving is mandatory at production scale — this is a non-obvious operational constraint.

**TikTok's Online Joiner (Flink):**
- Separate Kafka queues: one for user action events, one for item feature updates
- Apache Flink joins these streams to construct real-time training examples
- Two-tier storage: Redis cache for recent user features (fast), on-disk KV for older (memory bounded)
- Result: training data reflects user behavior from the last few minutes, not yesterday

---

### 7. Pagination Correctness with Hybrid Fanout

**Problem:** With hybrid fanout (precomputed feed + live celebrity queries), pagination breaks in a subtle way.

Scenario: User loads page 1 at T=100 (cursor=T100). A celebrity posts at T=110. User loads page 2 (cursor=T100). The live celebrity query always returns the most recent posts, so the T=110 post appears on page 2 — out of order, and the user may have never seen page 1 content from that celebrity.

**Production fix — snapshot the celebrity query upper bound:**

The first feed request establishes a session cursor: `upperBound = now()`. All celebrity queries in subsequent page loads are scoped to `createdAt < upperBound AND createdAt < pageCursor`. The T=110 post is invisible until the user starts a fresh session.

This ensures the merged timeline is temporally consistent across all pagination pages. This is the kind of correctness detail that separates Senior from Staff.

---

## Fanout Strategy Tradeoff Matrix

| Dimension | Fan-out on Read | Fan-out on Write | Hybrid (Production Standard) |
|---|---|---|---|
| Write latency | O(1) | O(followers) async | O(1) — always |
| Read latency | O(followees) scatter-gather | O(1) cache lookup | O(1) + small live merge for celebrities |
| Write amplification | None | 100M writes per celebrity post | Bounded by follower threshold |
| Read amplification | Extreme for dense follow graphs | None | Bounded by celebrity count per user |
| Freshness | Always fresh | Eventual (fanout queue delay) | Eventual for normal; near-instant for celebrities |
| Cache efficiency | Low | High (precomputed) | High for normal; live for celebrities |
| Celebrity handling | Natural | Impossible at scale | Explicit routing flag per account |
| Cold rebuild cost | Per read (expensive) | Once at post creation | Once for normal; per read for celebrity slice |

---

## Scaling Journey: 0 → ∞

### Stage 1: 0–100 Users (MVP)

**Goal:** Ship, validate the product exists.

**Architecture:**
- Single app server + single Postgres instance
- Follow, Post, User tables in Postgres
- Feed query:
  ```sql
  SELECT p.* FROM posts p
  JOIN follows f ON p.author_id = f.followed_id
  WHERE f.follower_id = $1
  ORDER BY p.created_at DESC
  LIMIT 20;
  ```
- No caching, no queues, no precomputation

**What you skip:** Everything.

**Failure mode → Stage 2:** DB CPU spikes on feed reads as follow graph densifies. Index on `posts(author_id, created_at DESC)` helps; hits wall when a user follows hundreds of accounts.

---

### Stage 2: 100–1,000 Users (Early Growth)

**Goal:** Handle 10× traffic without on-call pages.

**Changes:**
- Add composite index: `posts(author_id, created_at DESC)`
- Add Postgres **read replica** — route feed reads there, keep writes on primary
- Add Redis for session tokens and user profile caching (not feeds yet)
- Add load balancer + second app server instance
- Add structured logging + p99 latency metrics (Datadog/Grafana) — can't scale what you can't measure

**What you skip:** Precomputed feeds, message queues, sharding.

**Failure mode → Stage 3:** p99 feed latency creeps past 500ms when users follow 200+ accounts. The scatter-gather SQL query against the read replica starts taking 800ms+ at high follow counts.

---

### Stage 3: 1K–100K Users (Product-Market Fit)

**Goal:** Consistent sub-500ms feeds regardless of follow count.

**Changes:**
- **Precomputed feeds in Redis** (sorted sets, `feed:{userId}`, capped at 200 entries)
- **Async fan-out workers** via SQS — post creation enqueues `{postId, authorId}`; workers write to follower feed sets
- Feed Service reads become a single `ZREVRANGEBYSCORE` — O(1) in practice
- Media goes to S3 + CloudFront CDN (direct POST to S3 via presigned URLs, never through the app server)
- Post table migrates from Postgres to DynamoDB for elastic write throughput

**Why now:** At this scale, average follower count is ~150, so fan-out cost is modest. The write amplification (150 Redis writes per post) is well within a small worker fleet.

**Failure mode → Stage 4:** Some accounts hit 50K+ followers; their posts take 5–10 seconds to fan out. Worker fleet is dominated by a few power users. Redis memory pressure from 100K users' sorted sets.

---

### Stage 4: 100K–10M Users (Scale-Out)

**Goal:** Horizontal scale on every tier; first celebrity threshold.

**Changes:**
- **Introduce celebrity threshold** (e.g., 100K followers): flag accounts above threshold as "non-precomputed" in Follow table. Workers skip them entirely.
- **Hybrid read path**: Feed Service merges precomputed Redis feed + live Post GSI query for celebrity follows (bounded to ~5 celebrity queries per read)
- **Shard Redis** by `userId` (Redis Cluster). Feed storage scales linearly with users.
- **Shard worker fleet by `authorId`** — contains celebrity fan-out to specific worker shards, preventing monopolization
- **Multi-AZ** on all stateful tiers (RDS, DynamoDB, Redis Cluster)
- **Post content cache**: Add replicated Redis cluster for post hydration. Replicated (not sharded) to handle viral posts without hot shards.
- **DynamoDB on-demand billing** — absorbs burst traffic from large accounts without provisioned-capacity planning

**Failure mode → Stage 5:** Viral posts create 10M+ reads/sec against post content cache. Regional traffic grows — European users hitting US-origin Redis takes 100ms RTT, destroying p99.

---

### Stage 5: 10M–2B+ Users (Hyperscale)

**Goal:** Global, fault-tolerant, sub-100ms at the edge.

**Changes:**
- **Multi-tier post cache**: In-process LRU (L1, 1-5s TTL, ~1K hottest posts) in every Feed Service instance → replicated Redis cluster (L2, 60s TTL) → DynamoDB (source of truth). L1 eliminates Redis round-trips for top viral content.
- **Multi-region active-active**: Users read/write to nearest region (US-East, EU-West, AP-Southeast). Cross-region replication of social graph with last-writer-wins conflict resolution (acceptable under 1-min staleness budget).
- **Edge-cached public content**: Posts from public accounts (no privacy filter needed) cached at CDN PoPs with 30s TTL. Reduces origin load for globally trending content.
- **ML ranking pipeline**: Replace reverse-chron with multi-pass ranking (retrieval → pre-rank → full rank → rerank). Requires real-time feature pipeline (Kafka + Flink), embedding stores (FAISS shards), and model serving infrastructure.
- **Tiered storage**: Active post metadata in Redis/DynamoDB; posts older than 90 days archived to cheaper S3-backed cold storage with lazy hydration.
- **Real-time sequence features**: Session-level user behavior fed into ranking models every minute; GPU serving fleet for sequence models (CPU serving is 20× slower).
- **Graceful degradation**: Under SQS backlog (celebrity storm), serve stale precomputed feeds extended from 200 to 500 entries; disable ranking and serve reverse-chron if ML serving latency exceeds 300ms.
- **Capacity planning as discipline**: Dedicated SRE org, per-service load-shedding, synthetic canary traffic per region.

**Key insight:** Every architecture decision at this stage is a negotiation between availability, staleness tolerance, and cost. The 1-minute staleness budget in the NFRs is what makes the hybrid fanout, the eventual consistency of precomputed feeds, and the multi-region replication lag all acceptable. Strong consistency here would be prohibitively expensive.

---

## Insider Tips and Tricks

These are the details that distinguish candidates who have operated large-scale systems from those who have only studied them.

---

### The 50:1 Read/Write Ratio Changes Everything

The ratio — roughly 300K reads vs 6K writes per second at Twitter's 150M-user scale — is the single number that justifies precomputed feeds. Every engineering decision flows from it: why fanout-on-write is correct despite write amplification, why you invest in L1+L2+L3 caching rather than query optimization, and why you accept 1-minute staleness (the cost of going synchronous on writes would be prohibitive).

Mention this ratio in an interview. It shows you've internalized *why* the architecture is the way it is.

---

### Inactive Users Don't Have Precomputed Feeds

Twitter's production system only maintains Redis timelines for users active within the last 30 days. Inactive users' timelines are evicted from Redis under memory pressure. When they return, their timeline is **warm-rebuilt** from persistent storage (disk-backed sorted sets + post DB scatter-gather) — this takes ~3 seconds vs ~400ms for active users.

This means your precomputed feed system must handle the cold-path gracefully: detect cache miss, trigger async warm rebuild, serve stale data or a "building your feed" placeholder while the rebuild completes.

---

### Twitter's Redis Is Not Vanilla Redis

Twitter built a custom data structure called **HybridList** (part of the Haplo timeline service) on top of Redis. The problem: a standard Redis ziplist is memory-compact but expensive to modify for large lists. A standard doubly-linked list has per-node overhead. HybridList is a linked list of ziplists — when a ziplist exceeds a byte threshold, it spills into a new ziplist node. This gives memory-predictable storage without expensive reallocations.

Each timeline entry is small: `(tweetId, authorUserId, 4 bytes of metadata)` — just flags for retweet/reply. No text, no counts. Full content is hydrated on read via parallel multigets. This separation of the timeline index from post content is an important pattern: it means the timeline store can be extremely compact while the content store can be separately scaled.

---

### Sharding Workers by AuthorId, Not FollowerId

Intuition says shard by followerId (balance writes across followers). Production says shard by authorId. Reason: if you shard by followerId, a celebrity post is processed by every shard simultaneously. The celebrity's 100M-follower fanout consumes a proportional slice of every shard's capacity, making the queue depth across shards noisy and unpredictable.

Sharding by authorId means the celebrity's fanout queue lives on a specific shard. You can isolate it, rate-limit it, or give it dedicated capacity without affecting every other author posting at the same time. It's a containment strategy.

---

### The Celebrity Threshold Is Per-Account, Not Global

The follower threshold that determines whether an account gets precomputed fanout should be a per-account flag, not a global constant. This matters because:

1. The threshold that's "too expensive" depends on write rate, not just follower count. An account with 5M followers who posts once a week is cheaper than one with 500K followers who posts 50 times a day.
2. During traffic spikes (Super Bowl, breaking news), you may want to temporarily lower the threshold for specific accounts.
3. New accounts that cross the threshold mid-flight need their existing followers migrated gracefully.

In practice, this flag lives in the User or Follow table and is updated asynchronously by a background job that monitors per-account fanout metrics.

---

### Cursor-Consistent Merging Is Harder Than It Looks

The hybrid fanout pattern (precomputed feed + live celebrity queries) requires careful cursor management to avoid duplicate or out-of-order posts across page boundaries.

The correct implementation:
1. First page request establishes a session-level `upperBound = now()`
2. Precomputed feed cursor: `score < cursor`
3. Celebrity live query: `createdAt < min(upperBound, cursor)`
4. Both upper bounds are passed through all subsequent pages

If you don't snapshot `upperBound` at session start, a celebrity posting between page 1 and page 2 will appear on page 2 — the user sees a post out of order, and the feed appears to "jump." This is the kind of bug that doesn't show up in unit tests or low-traffic environments — it only appears when celebrities post frequently and users scroll slowly.

---

### Replicated Cache vs Sharded Cache: A Common Wrong Answer

Most candidates instinctively reach for sharded Redis to scale a hot key problem. This is wrong for viral posts.

Sharding by post ID puts the viral post on one shard — the problem is unchanged, just relocated.

The correct solution is **replication**: N identical Redis instances behind a load balancer, each holding the full hot dataset. A request for the viral post hits one of N replicas at random. The initial cache population requires N cache misses (one per replica) before the key is warm everywhere — but N (e.g., 10) is tiny compared to the millions of requests you're absorbing.

The cost is higher memory usage (N × data size). The benefit is linear throughput scaling with no coordination between replicas.

The interview answer that shows real experience: "Sharding distributes *keys* but not *load on a single key*. For hot keys, you need replication."

---

### Feed Quality: What You Don't Show Matters as Much as What You Do

Standard interview prep focuses entirely on how to surface posts. Production systems invest equal effort in what to suppress:

- **Consecutive same-author posts**: After showing 2 posts from the same author, drop a cooldown period before showing a 3rd — prevents the feed from feeling stalker-y.
- **Consecutive same-format posts**: After 3 videos, inject a text post. Prevents format fatigue.
- **Recirculation of seen content**: Track which posts a user has been served (not just engaged with). Seen posts should not re-appear unless action-bumped.
- **Integrity filtering inline in ranking**: Clickbait, misinformation, and low-quality outbound link detection runs as part of the ranking pipeline, not as a separate post-processing pass. This is a latency optimization — one model inference pass is cheaper than two sequential passes.

These rules are implemented in the reranking stage (Pass 2 in Meta's pipeline). They require list-level state — knowing what was already shown — which is why a pointwise scorer alone can't implement them.

---

### Dwell Time as a Passive Engagement Signal

Explicit signals (likes, comments, shares) represent ~1–3% of impressions. The other 97% of impressions have no explicit signal. Dwell time (how long a post is visible on screen) provides a weak but scalable signal for the silent majority.

LinkedIn's implementation:
- Measured when ≥50% of an item is in viewport
- Threshold T_skip exists below which users consistently skip — found to be content-format-agnostic
- A P(skip) logistic regression trained on sub-threshold dwell time provides a per-impression negative signal
- Adding this model improved ROC by ~10% and reduced scrolled-past impressions

For an interview: mention this as evidence that **passive signals can be extracted from user behavior without requiring any user action**, which is important for cold-start problems (new content, new users).

---

### Bounded Feed Cache Is a Feature, Not a Limitation

Capping the precomputed feed at 200 entries is a deliberate choice, not a cost-cutting measure. Beyond 200 entries, users almost never scroll. Supporting deep pagination would require either unbounded feed storage or a fallback to scatter-gather DB queries.

The correct design: cap the cache at a reasonable depth, serve deeper pagination from the raw DB with a scatter-gather query. The scatter-gather path has high latency but it doesn't matter — users at page 10 are a tiny fraction of traffic and willing to wait.

This pattern generalizes: **optimize the hot path aggressively; let the cold path be expensive**. Trying to make the cold path as fast as the hot path typically compromises both.

---

### ML Ranking Is Not "Just Add ML"

Adding a ranking pipeline requires:
- **Feature store**: user interest embeddings, author engagement stats, post freshness scores — precomputed and served with sub-millisecond read latency
- **Online inference infrastructure**: 2B users × 1,000+ candidates × multitask model = enormous inference throughput; typically requires dedicated GPU serving fleet
- **Training pipeline**: continuous retraining on recent engagement signals (LinkedIn: every few hours; Instagram: hourly; TikTok: batch-online continuous)
- **A/B testing framework**: ranking changes are A/B tested on engagement metrics, time-on-feed, user return rate, and negative signals simultaneously
- **Feedback loop management**: a model that optimizes clicks will generate clickbait; weighted multi-objective optimization (likes, comments, shares, time-on-feed, minus hides and reports) is required to avoid Goodhart's Law degrading feed quality

Mentioning this in an interview demonstrates you understand the operational cost of ML in production — not just the algorithm.

---

### The Angry Reaction Is an Ambiguous Signal

Facebook's internal research found that Angry reactions on content do not correlate cleanly with user dissatisfaction. News content (deaths, disasters, policy announcements) legitimately generates angry reactions while remaining high-quality content worth distributing. Treating Angry as purely negative results in news being suppressed.

The production handling: Angry reactions are analyzed separately by content category. For news pages, Angry is treated neutrally; for entertainment content, it carries a mild negative weight.

This is a real example of why "simple negative signal → demotion" doesn't work. Surface-level engagement signals require content-type context to be interpreted correctly.

---

### Why Timestamp Cursors Beat Offset Pagination

Offset pagination (`?page=3&size=20`) breaks for feeds because new posts arrive at the top. If 5 posts arrive between page 1 and page 2, page 2 starts 5 positions late — users see duplicate or skipped posts.

Timestamp cursors (`?cursor=1700000000000`) are stable: "give me posts older than this timestamp." New posts arriving at the top don't affect the cursor position. Posts can be inserted or deleted between pages without corrupting pagination.

The edge case: two posts with identical timestamps. Use a composite cursor `(timestamp, postId)` to break ties deterministically.

---

## Expected Depth by Level

| Level | Breadth / Depth | Focus |
|---|---|---|
| **Mid (E4)** | Breadth-first | Clean API + data model; working high-level design; aware that fan-out is a problem; not expected to solve celebrity problem fully |
| **Senior (E5)** | ~60/40 | Proactively surface fan-out problem and celebrity threshold without prompting; articulate hybrid fanout tradeoffs; at least one deep dive on caching or pagination correctness |
| **Staff+ (E6+)** | ~40/60 | Cover all deep dives; bring real numbers (50:1 ratio, cache sizing, latency targets); discuss multi-stage ranking pipeline; identify pagination correctness edge cases; mention operational challenges (feature store, A/B testing, feedback loops); minimal interviewer steering |
