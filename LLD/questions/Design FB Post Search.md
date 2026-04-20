## Design FB Post Search

> **Pattern**: Inverted Index / Search
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/fb-post-search)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Facebook Post Search lets a user type a keyword and retrieve relevant posts, sorted by either the newest first or by number of likes. Unlike a general web search, the corpus here is large, continuously growing, and the freshness bar is tight: a post created now must be findable within a minute.

The interesting constraints sit at the intersection of write volume (posts and likes both touch the index), read latency (sub-second at p50), and the skewed distribution of popular keywords where a single token can map to tens of millions of posts.

### Functional Requirements

**Core**
- A user can create a post containing text content.
- A user can like a post (likes are aggregated as a count on the post).
- A user can search posts by keyword.
- Search results can be sorted either by recency (newest first) or by like count (most liked first).

**Below the line / out of scope**
- Fuzzy or typo-tolerant matching.
- Personalized ranking based on the searcher's graph.
- Privacy and visibility rules (friends-only posts, blocked users).
- Rich media content (images, video) in posts.
- Real-time streaming result updates as new matches arrive.
- Advanced relevance models (semantic, embeddings, BM25 tuning).

### Non-Functional Requirements

**Core**
- p50 search latency under 500ms.
- Sustain high query throughput across a large user base.
- Index freshness: a new post should be discoverable within one minute.
- Every post must be retrievable by search, even if older or rarely accessed posts are slower to surface.
- High availability on the read path; brief indexing delays are tolerable.

**Below the line**
- Strong consistency on like counts (eventual is fine for ranking).
- Multi-region active-active writes.
- Exact recall on obscure long-tail queries within the SLA.

---

## Core Entities

- **User** - creator of posts and author of likes.
- **Post** - the searchable unit. Holds the text content, creation timestamp, author, and a denormalized like count.
- **Like** - association between a user and a post. In the index, likes matter primarily as an aggregate count rather than a per-user record.

---

## API Design

```
POST /posts
Body: { content: string }
-> { postId, createdAt }

POST /posts/{postId}/like
-> 204 No Content

GET /search?keyword=<term>&sort_by=recency|likes&cursor=<opaque>&limit=<n>
-> {
     results: [ { postId, author, content, createdAt, likeCount } ],
     nextCursor: string | null
   }
```

The search endpoint uses a cursor instead of page numbers because the index shifts underneath (new posts appear, like counts change). A cursor encodes either the last seen timestamp (for recency) or the last seen (likeCount, postId) tuple (for likes) and is stable against concurrent writes.

---

## High-Level Design

At a glance, the system has three subsystems:

1. **Write path (post creation + likes)** - Post and Like services write canonical records to durable storage, then publish events onto a message bus.
2. **Indexing pipeline** - Consumers of the event bus tokenize content and apply updates to an inverted index keyed by token.
3. **Read path (search)** - A Search service takes a query, looks up posting lists in the inverted index, merges and ranks, then hydrates post bodies from the Post service.

```
[Client]
   |
   v
[API Gateway]
   |
   +--> [Post Service]  --> [Post DB] --+
   |                                    |
   +--> [Like Service]  --> [Like DB] --+--> [Kafka: post-events, like-events]
   |                                                    |
   |                                                    v
   |                                      [Indexing Workers]
   |                                                    |
   |                                                    v
   |                                     [Inverted Index: Redis cluster]
   |                                                    ^
   +--> [Search Service] --------------------------------+
                |
                v
         [Post Service] for hydration
```

The inverted index itself is the load-bearing design choice. Each token (word in a post) maps to a posting list of post IDs. Two parallel structures are kept per token:

- A **recency list** ordered by creation time - implemented as a Redis list (or sorted set keyed on timestamp) so the latest posts for a token can be read from the head cheaply.
- A **likes list** ordered by like count - implemented as a Redis sorted set where the score is the post's like count, allowing `ZREVRANGE` to pull the top-N popular posts for the token.

Maintaining both structures avoids expensive request-time sorting: if you only stored post IDs unordered, a query for a popular keyword might require pulling tens of millions of IDs, hydrating them, and sorting in memory, blowing the 500ms budget.

---

## Deep Dives

### 1. Inverted Index Design

An inverted index flips the relationship "post contains words" into "word appears in posts." For each token, store a posting list of post IDs.

**Tokenization.** When a post arrives, lowercase the text, strip punctuation, split on whitespace, and (optionally) drop stopwords. For a post "The cat sat on the mat," the tokens become `{cat, sat, mat}` after stopword removal. Each token gets the post ID appended to its posting list.

**Two indexes, two sort orders.** A single posting list cannot cheaply support both sort orders, so maintain:
- `idx:recency:<token>` - Redis list, prepend on insert so head = newest.
- `idx:likes:<token>` - Redis sorted set, score = current like count.

**Read pattern.** For `GET /search?keyword=cat&sort_by=likes&limit=20`, the Search service runs `ZREVRANGE idx:likes:cat 0 19 WITHSCORES`, gets 20 post IDs, then calls the Post service (or a cache) to hydrate bodies.

**Multi-word queries.** For `"cat mat"`, intersect the posting lists of both tokens. A naive intersection on two sorted sets costs O(min(len)). For popular combinations, precompute **bigram / shingle indexes** keyed on the ordered pair `cat_mat` so hot phrases are effectively a single lookup.

### 2. Sharding the Search Index

A single Redis instance cannot hold the full posting structure for a large corpus, nor can it absorb the write rate on popular tokens.

**Shard key: token.** Partition by hashing the token to a Redis shard. All writes and reads for `cat` land on the same shard, which is what we want because a search query for a single keyword only needs one shard round-trip.

**Hot-key mitigation.** A celebrity token like `bts` or `ukraine` can hot-spot a single shard. Two mitigations:
- **Replicate hot shards** with read replicas; the Search service reads from any replica.
- **Cap posting list length** (see storage optimization) so the hot shard's memory cost stays bounded.

**Multi-word fan-out.** For a two-token query, the Search service hits two shards in parallel and intersects results at the service layer. This is acceptable as long as each posting list is capped to O(1k-10k).

### 3. Ranking (Recency, Likes, Relevance)

The problem statement allows only two sort orders: recency and likes. This keeps ranking simple.

**Recency.** Newest timestamps win. A Redis list with LPUSH on insert lets you LRANGE from the head cheaply. To cap memory, LTRIM to the top N (say 10k) on every insert.

**Likes.** A sorted set with score = like count. `ZREVRANGE` returns top-N in O(log N + M) time.

**Why not sort at query time?** Sorting at query time means materializing the entire posting list, pulling like counts for every ID, and sorting, which for a popular keyword with 10M posts is catastrophic. Precomputing sort order in the index turns the hot path into an O(log N + page_size) operation.

**Relevance nuance.** Real-world search layers in BM25 or a learned ranker (CTR, engagement, freshness decay). The problem treats this as below the line, so the two-index approach is enough.

### 4. Indexing Pipeline

The pipeline has to absorb creates and likes with very different volumes.

**Post creation flow.**
1. Client writes to Post service, which persists to the Post DB.
2. Post service publishes `post-created` to Kafka topic.
3. Indexing workers consume, tokenize the post, and for each token issue an `LPUSH idx:recency:<token> <postId>` and `ZADD idx:likes:<token> 0 <postId>`.
4. Workers batch writes to amortize network overhead and use Redis pipelining.

**Like flow.** Every like ideally updates the `idx:likes:<token>` score for every token in the liked post. But likes happen far more frequently than creates (a viral post can attract thousands of likes per second), and updating N tokens per like can saturate Redis.

**Throughput target.** To sustain roughly 10k posts/s, partition the Kafka topic by post ID and scale consumers horizontally. The index shards absorb the fanned-out writes.

### 5. Incremental / Real-Time Index Updates

Keeping the index fresh within a minute for creates is straightforward; keeping like counts accurate is the real challenge.

**Freshness for creates.** Kafka end-to-end latency plus indexing time typically lands well under a minute. If a worker lags, the consumer group rebalances and another worker picks up the partition.

**Like count updates - the naive approach.** Update `idx:likes:<token>` for every token on every like. For a post with 20 tokens and 1000 likes, that is 20,000 Redis writes. For a viral post, this melts the cluster.

**Milestone updates.** Only update the index score when the like count crosses a meaningful threshold: powers of 2 (1, 2, 4, 8, 16 ...) or powers of 10 (10, 100, 1000 ...). This collapses 1000 like events into about 10 index updates.

**Query-time reconciliation.** At search time, after pulling the top-N post IDs from the sorted set, call the Like service for the authoritative current like count and use it for the displayed count (even if the sort order is based on a slightly stale score). The sort order will be approximately correct because the milestone jumps preserve relative ordering among the top posts.

**CDC as an alternative.** Rather than having the Like service publish events, a CDC stream (Debezium on the Like DB's WAL) can feed the indexing pipeline, giving durability guarantees for free and decoupling the application from the messaging layer.

### 6. Handling Large-Scale Queries

**Result caching.** Cache the first page of results for `(keyword, sort_by)` in a distributed cache with a TTL under the freshness SLA (say 30-60s). Popular queries hit the cache and bypass Redis entirely.

**CDN edge caching.** For logged-out or unpersonalized results, set `Cache-Control: public, s-maxage=30` so CDN edges absorb the load and return results in tens of milliseconds.

**Posting list caps.** Cap each `idx:recency:*` and `idx:likes:*` at 1k-10k entries. If a token has more candidates, the overflow lives in cold storage (S3 + a secondary index) and is consulted only for queries that paginate past the cap.

**Cold / hot split.** Tokens that haven't been searched in weeks get demoted to a cold tier. Promotion happens on query: the first hit warms the cache and rebuilds the hot list from the durable Post DB.

---

## Scaling Journey: 0 to Infinity

This section is my own analysis of how a post-search system evolves from a weekend project into a Facebook-scale index. Each stage picks the simplest thing that works at that volume and names the bottleneck that forces the next step.

### Stage 1: 0-100 Users

**Goal.** Prove the feature. Anyone can create a post and search it. Latency does not matter; correctness does.

**Architecture.** Single Postgres instance. Posts live in a `posts` table with a `content` column. Search is:

```sql
SELECT * FROM posts
WHERE content ILIKE '%' || $1 || '%'
ORDER BY created_at DESC
LIMIT 20;
```

A monolithic backend handles create, like, and search. No cache, no queue, no index beyond the default B-tree on `created_at`.

**What you skip.** Tokenization, inverted index, Kafka, Redis, sharding, CDN. No ranking by likes yet - just offer recency.

**Failure mode that pushes to next stage.** `ILIKE '%term%'` cannot use a B-tree index, so every query is a full sequential scan. At ~10k posts the query goes from milliseconds to seconds, and every concurrent search competes for the same scan. Adding `sort_by=likes` would require sorting the full result set per query.

### Stage 2: 100-1,000 Users

**Goal.** Make search fast enough to feel instant on a corpus of a few million posts, and support like-based sorting.

**Architecture.** Switch to Postgres full-text search. Add a `tsvector` column materialized from `content`, a GIN index on it, and a trigger that updates the tsvector on insert/update.

```sql
ALTER TABLE posts ADD COLUMN tsv tsvector;
CREATE INDEX posts_tsv_idx ON posts USING GIN(tsv);

SELECT id, content, created_at, like_count
FROM posts
WHERE tsv @@ plainto_tsquery($1)
ORDER BY
  CASE WHEN $2 = 'recency' THEN created_at END DESC,
  CASE WHEN $2 = 'likes'   THEN like_count END DESC
LIMIT 20;
```

Denormalize `like_count` onto the `posts` row so sort-by-likes is a column read, not a join-and-aggregate. Update the counter from the Like service with a simple `UPDATE posts SET like_count = like_count + 1 WHERE id = $1`.

Add a Redis cache in front of the Search endpoint keyed on `(keyword, sort_by, cursor)` with a 30s TTL.

**What you skip.** Dedicated search engine, Kafka, sharding, milestone index updates. Tokenization lives inside Postgres's text search config.

**Failure mode that pushes to next stage.** Postgres FTS starts to struggle past 50-100M posts. GIN index updates slow down writes, and concurrent searches on popular terms saturate the single primary. Sort-by-likes with a tsvector filter plus an `ORDER BY like_count` cannot use the GIN index for both; Postgres falls back to filter-then-sort, and the sort becomes expensive on popular keywords.

### Stage 3: 1K-100K Users

**Goal.** Move search off the primary database and onto a system designed for it. Start decoupling write path from index.

**Architecture.** Introduce a single-node Elasticsearch (or OpenSearch) cluster. Posts in Postgres remain the source of truth; a Kafka topic carries `post-created` and `post-updated` events.

- Post service writes to Postgres and publishes to `post-events`.
- An indexer consumer reads from Kafka, transforms, and writes to the `posts` index in Elasticsearch.
- Search service queries Elasticsearch with a `match` on content and a `sort` on either `@timestamp` or `like_count`.

Likes are batched: the Like service increments in Postgres synchronously and enqueues a `like-updated` event. A separate consumer throttles updates to Elasticsearch to every N seconds per post, avoiding per-like index writes.

**What you skip.** Sharded Elasticsearch, hot/cold separation, CDN, milestone thresholds. Ranking is still just two fixed sort orders.

**Failure mode that pushes to next stage.** A single ES node can hold maybe 50-100GB of index and a few thousand QPS. Beyond that, segment merges and shard rebalancing stall both reads and writes. Posting lists for celebrity terms grow without bound, and like updates, even batched, become the dominant write load.

### Stage 4: 100K-10M Users

**Goal.** Distribute the index across many machines and tame the hot-key problem for viral posts.

**Architecture.** Elasticsearch cluster with explicit sharding: say 32 primary shards with 2 replicas each. Shard routing key is the post ID for write distribution, but searches fan out to all shards because a token can appear on any shard.

For single-keyword queries where fan-out is expensive, introduce a Redis-based inverted index as a first-stage filter:
- `idx:recency:<token>` - Redis list capped at 10k, LPUSH on insert, LTRIM.
- `idx:likes:<token>` - Redis sorted set capped at 10k, ZADD with like count as score.

Partition the Redis cluster by token hash. The Search service checks Redis first; only if it needs to paginate deeper or the token is cold does it fall through to Elasticsearch.

Switch like updates to milestone writes: the Like service maintains an authoritative counter in Postgres (or a sharded counter store), and only emits an index-update event when the counter crosses a power-of-2 boundary. At query time, the Search service hydrates posts and calls the Like service for the current count to display.

Introduce CDN edge caching for logged-out search with a 30s cache-control header. Add an application-level result cache in Redis for logged-in queries.

Replace the application-level Kafka publish with CDC on the Postgres WAL (Debezium) to guarantee no event is lost when the application crashes mid-write.

**What you skip.** Cross-region replication of the full index, geo-aware routing, ML ranking. Still two fixed sort orders.

**Failure mode that pushes to next stage.** At Facebook scale, the corpus is tens of billions of posts. Even a 10k cap per posting list holds the hot set, but long-tail queries - searching for a specific phrase in a post from 2015 - cannot be satisfied by the in-memory index. Cross-region latency matters; a user in Singapore hitting a US index cluster pays 200ms on the network alone.

### Stage 5: 10M+ Users

**Goal.** Serve billions of posts with sub-500ms p50 globally, while keeping index storage and write amplification tractable.

**Architecture.**

- **Hot / cold tiering.** The Redis inverted index holds only the top 10k most-recent and top-10k most-liked posts per token. Everything else lives in a cold tier: a sharded, on-disk index (ES warm/cold nodes backed by slower SSD, or a custom format on S3 with Lucene segments). Cold queries are slower (a few seconds is acceptable) and are triggered only when a user pages past the hot cap.
- **Regional read replicas.** The inverted index is asynchronously replicated to each region. Writes still flow to the home region; reads are local. Freshness in remote regions is best-effort (a few seconds of lag), which is acceptable given the one-minute SLA.
- **Real-time indexing via CDC.** Debezium streams Postgres WAL into Kafka. A per-region indexer consumes and applies to the regional Redis and ES clusters. No application code participates in the write-to-index handoff - it is infrastructure-level.
- **Hot shard replication and key splitting.** For tokens whose write rate exceeds what a single Redis shard can absorb (say more than 50k ops/s), split the token across N sub-shards with a suffix (`idx:likes:ukraine#0`, `#1`, `#2`), and fan out reads to all sub-shards, merging at the service layer. Detect hot keys with a sampling proxy and split them automatically.
- **Precomputed bigram index.** For frequent two-word queries (`taylor swift`, `world cup`), maintain a shingle index so the query is a single lookup instead of an intersection.
- **Tiered result cache.** CDN at the edge, application cache in Redis per region, and a query-plan cache that memoizes shard routing decisions.
- **Like update backpressure.** Milestone updates use powers of 10 beyond 1000 likes (1k, 10k, 100k, 1M), collapsing a million-like event stream into five index writes per token. Query-time reconciliation against the Like service provides the display count.

**What you skip.** Nothing is really skipped at this stage - instead, each component is horizontally scaled, multi-region, and observability-heavy. The trade-off is operational: more moving parts, more on-call, more tuning knobs.

**Failure mode beyond this.** Further scale is a matter of shard count and hardware. The architecture does not have a new qualitative failure mode; the next frontier is qualitative product changes - semantic search, personalization, multimodal content - which require a different kind of index (vector stores, learned rankers) rather than another scaling step for the keyword index.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What to nail | What to drive proactively |
|---|---|---|---|
| Mid | ~80% breadth, ~20% depth | Clear APIs, correct data model, both write and read paths present, basic awareness of caching and TTLs. Accept interviewer nudges toward optimizations without being thrown off. | Get to a working end-to-end design. One deep dive (usually the inverted index itself) is enough. |
| Senior | ~60% breadth, ~40% depth | Move through the initial design quickly, then focus the conversation on the critical path: the inverted index structure, how writes fan out, how reads stay under 500ms. Name trade-offs explicitly (memory vs latency, freshness vs write amplification). | Proactively surface the hot-key problem, the like-update volume, and the need for sharding before being asked. |
| Staff+ | ~40% breadth, ~60% depth | Multiple deep dives with concrete configuration choices (Redis sorted set vs list, shard count, milestone thresholds, CDC vs app-level events). Draw on real operational experience: segment merges, hot shard mitigation, regional consistency. | Identify non-obvious issues before the interviewer (duplicate event delivery, index drift after a replay, sort-order skew from milestone approximation) and propose concrete mitigations with novel angles. |
