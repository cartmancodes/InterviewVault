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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Imagine you walk into a massive library and ask for a book about "World War II naval battles." You don't grab a flashlight and start reading every book on every shelf — you'd be there for years. Instead, you go to the **card catalog**, look up the topic, and walk away with a tidy list of call numbers. A search engine builds that catalog for you. The technical name is an **inverted index**, but it's really just a topic-to-locations map. Open any cookbook and flip to the back — that alphabetical list ("chicken... 12, 47, 89") is exactly the same idea: each ingredient maps to the pages it appears on.

Now scale that up. Facebook is a giant game of "Where's Waldo" with 10 billion posts. You're hunting for the one post that mentioned "purple bicycle." Reading every post is impossible — even at a million posts per second, it takes hours. So Facebook keeps a directory: "purple bicycle → posts 14, 392, 7821." Every word in every post becomes a key, and each key points to the list of posts containing it. Searching becomes "intersect the word lists" instead of "scan everything."

Three things make this hard at Facebook scale:

- **It doesn't fit on one machine.** Trillions of posts means the index is **sharded** across thousands of machines — usually split by word, so all entries for "bicycle" live together.
- **Ranking.** Search "wedding" and you get billions of hits. Which 20 do you show? The system ranks by recency, by your social graph (your friends' posts first), and by engagement — like a thoughtful librarian who knows you and recommends accordingly.
- **Real-time updates.** You post something now and expect to find it 30 seconds later. The index has to update *fast*, usually via a **Kafka pipeline** that streams new posts straight into the indexers.

### When the analogy breaks down

A real Facebook search has to handle **typos** ("becycle" should still find "bicycle"), **synonyms** ("vehicle" should find "car"), **multilingual** queries, **privacy filtering** (you can't search posts from people who blocked you), and **ranking models** trained on billions of clicks. The cookbook index is a gentle introduction — the production system is closer to a librarian who speaks every language, reads minds, and quietly hides books from people who shouldn't see them.

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
- `idx:recency:<token>` - Redis list, prepend on insert so head = newest. Capped at 10k entries via `LTRIM` on every insert.
- `idx:likes:<token>` - Redis sorted set, score = current like count. `ZREVRANGE` returns top-N in O(log N + page_size) time.

**Read pattern.** For `GET /search?keyword=cat&sort_by=likes&limit=20`, the Search service runs `ZREVRANGE idx:likes:cat 0 19 WITHSCORES`, gets 20 post IDs, then calls the Post service (or a cache) to hydrate bodies. For recency, it runs `LRANGE idx:recency:cat 0 19`.

**Multi-word queries.** For `"cat mat"`, intersect the posting lists of both tokens. A naive intersection on two large sorted sets is expensive. Mitigations:
- Pull a bounded window (top-1k) from each and intersect in-memory at the service layer — acceptable when posting lists are capped.
- For hot phrase combinations, precompute **bigram / shingle indexes** keyed on the ordered pair `cat_mat` so the lookup is a single Redis read rather than an intersection.
- For Elasticsearch-backed queries, a boolean `must` clause handles intersection natively and benefits from Lucene's skip-list optimized merge.

**Memory sizing.** At 1k post IDs per token (8 bytes each) the recency list is 8KB per token. At 1 billion posts with 10 tokens per post, that is 10 billion token-to-post associations. The hot working set (tokens that appear in the last 7 days of posts) is a fraction of that and fits comfortably in a Redis cluster sized at tens of terabytes.

**Durability.** Redis RDB/AOF provides crash recovery, but the true source of truth is Postgres. If the Redis index is lost, it can be rebuilt by replaying Kafka topics or by running a backfill job that reads all posts from Postgres and re-indexes them.

### 2. Sharding the Search Index

A single Redis instance cannot hold the full posting structure for a large corpus, nor can it absorb the write rate on popular tokens.

**Shard key: token.** Partition by hashing the token to a Redis shard. All writes and reads for `cat` land on the same shard, which is what we want because a search query for a single keyword only needs one shard round-trip. Consistent hashing (used natively by Redis Cluster) ensures that adding shards minimizes key migration.

**Hot-key mitigation.** A celebrity token like `bts` or `ukraine` can hot-spot a single shard. Two mitigations:
- **Read replicas** for hot shards: the Search service reads from any replica for `LRANGE` / `ZREVRANGE`. Writes still go to the primary.
- **Key splitting** for extreme hot keys: detect via a sampling proxy and automatically expand `idx:likes:ukraine` into `idx:likes:ukraine#0` through `idx:likes:ukraine#N`, spreading writes across N shards. Reads fan out and merge at the service layer. This is a last resort because it adds code complexity.

**Cap posting list length.** Each `idx:recency:*` and `idx:likes:*` is capped at 1k-10k entries. If a token has more candidates, the overflow lives in cold storage (Elasticsearch warm/cold nodes or S3-backed Lucene segments) and is consulted only when a user pages past the hot cap. This bounds the memory cost per token regardless of how popular the term becomes.

**Multi-word fan-out.** For a two-token query, the Search service hits two shards in parallel and intersects results at the service layer. Latency is determined by the slower of the two round-trips, not their sum. Keep page sizes small (top 100-1000 per shard) to bound intersection cost.

### 3. Ranking (Recency, Likes, Relevance)

The problem statement allows only two sort orders: recency and likes. This keeps ranking simple, but understanding why precomputed ordering exists and what real ranking looks like is critical for senior conversations.

**Recency.** Newest timestamps win. A Redis list with `LPUSH` on insert lets you `LRANGE` from the head cheaply. `LTRIM` after every insert caps the list length. This is O(1) per insert and O(page_size) per read — effectively free.

**Likes.** A sorted set with score = like count. `ZREVRANGE` returns top-N in O(log N + M) time. For tie-breaking (two posts at identical like counts), append the post ID into the score as a fractional component or enforce a secondary sort in the Search service layer.

**Why not sort at query time?** Sorting at query time means materializing the entire posting list, pulling like counts for every ID, and sorting, which for a popular keyword with 10M posts is catastrophic. A single `ZREVRANGE` returning the precomputed top-20 replaces what would otherwise be millions of reads and an N log N sort. Precomputing sort order in the index turns the hot path into an O(log N + page_size) operation — this is the core insight worth articulating clearly in an interview.

**Why BM25 alone is wrong for social search.** BM25 (the industry-standard text relevance formula used by Elasticsearch) ranks by term frequency, inverse document frequency, and field length normalization. In a social context this is insufficient. A post with lower BM25 score from a close friend is almost always more relevant to the searcher than a high-scoring post from a stranger. Social signals — social graph distance, whether the author is a followed public figure, prior engagement history with the author — outweigh text relevance. The two-sort-order simplification is acceptable for this problem scope, but naming this gap in a senior interview demonstrates awareness of production social search.

**Relevance nuance.** Real-world search layers in BM25 or a learned ranker (CTR, engagement, freshness decay). The problem treats this as below the line, so the two-index approach is enough. If asked to extend, name the signals: freshness penalty (score decays by sqrt(age)), engagement boost (comments, shares), author authority, and personalization (searcher's graph distance to the author).

### 4. Indexing Pipeline

The pipeline has to absorb creates and likes with very different volumes and reliability requirements.

**Post creation flow.**
1. Client writes to Post service, which persists to the Post DB (Postgres).
2. Rather than having the application publish to Kafka directly (which creates a dual-write problem — Postgres write succeeds but Kafka publish fails), use Debezium CDC on the Postgres WAL. Debezium captures every committed row change and publishes a `post-created` event to the `post-events` Kafka topic atomically with the database commit.
3. Indexing workers consume from `post-events`, tokenize the post content, and for each token issue an `LPUSH idx:recency:<token> <postId>` and `ZADD idx:likes:<token> 0 <postId>`. Workers batch writes (Redis pipelining) to amortize network overhead.
4. Kafka's consumer group model handles worker failures automatically — if a worker crashes, another picks up the uncommitted partition offset.

**Like flow.** Every like ideally updates the `idx:likes:<token>` score for every token in the liked post. But likes happen far more frequently than creates (a viral post can attract thousands of likes per second), and updating N tokens per like can saturate Redis.

**Milestone updates.** Only update the index score when the like count crosses a meaningful threshold: powers of 2 (1, 2, 4, 8, 16 ...) for the low end, powers of 10 (10, 100, 1000, 10k, 100k ...) for the high end. This collapses a million like-events into roughly 20 index writes per token. The like counter itself is maintained accurately in Postgres; the index score is an approximation sufficient for sort-order purposes.

**Query-time reconciliation.** After pulling the top-N post IDs from the sorted set, the Search service calls the Like service (or reads the Post DB) for the authoritative current like count and uses it for the displayed count — even though the sort order was determined by the approximate indexed score. The sort order remains approximately correct because milestone jumps preserve relative ordering among the top posts.

**End-to-end indexing lag.** With CDC + Kafka, a new post flows from Postgres commit to Elasticsearch/Redis index in roughly 1-5 seconds under normal conditions. This is well within the one-minute freshness SLA. Kafka partition lag monitoring is the key operational metric — if consumers fall behind, lag grows and freshness degrades. Auto-scaling consumer groups on lag is the standard mitigation.

**Idempotency.** Indexing workers must handle duplicate deliveries (Kafka at-least-once). For post creation, `LPUSH` on an already-indexed post ID creates a duplicate entry in the recency list. Mitigate by checking post ID existence before pushing, or accept duplicates and deduplicate at read time (the Search service deduplicates the hydrated results page). For like milestones, `ZADD` with the new score is naturally idempotent — reprocessing the same milestone event just sets the same score again.

### 5. Incremental / Real-Time Index Updates

Keeping the index fresh within a minute for creates is straightforward; keeping like counts accurate is the real challenge.

**Freshness for creates.** Kafka end-to-end latency plus indexing time typically lands well under a minute. If a worker lags, the consumer group rebalances and another worker picks up the partition. Monitoring consumer lag (via Kafka consumer group offsets) surfaces freshness degradation before users notice it.

**Like count updates — the naive approach.** Update `idx:likes:<token>` for every token on every like. For a post with 20 tokens and 1000 likes per second, that is 20,000 Redis writes per second per post — and a viral post receiving 50k likes/second generates 1 million Redis writes per second directed at the same set of token shards. This melts the cluster.

**Milestone updates in practice.** The Like service maintains an authoritative counter in Postgres (or a sharded counter store using Redis `INCR`). A Kafka consumer compares the current count against the last indexed milestone and emits an index-update event only on boundary crossings. The consumer is stateful (it must know the last indexed milestone), so its state is checkpointed to the same Postgres row or a dedicated table.

**CDC as the preferred alternative.** Rather than having the Like service explicitly publish milestone events, a Debezium CDC stream on the Like DB's WAL can feed the indexing pipeline directly. The indexer computes milestone crossings from the streamed rows. This decouples the application from the messaging layer and provides replay capability: if the ES/Redis index is corrupted, replay from the earliest WAL offset to rebuild.

**Soft real-time expectation.** For likes, a 1-5 second indexing lag is acceptable. For post creation, a 5-30 second lag is acceptable (the SLA is one minute). Neither requires synchronous writes to the search index on the hot write path — asynchronous CDC provides both durability and decoupling.

### 6. Handling Large-Scale Queries

**Result caching.** Cache the first page of results for `(keyword, sort_by)` in a distributed cache with a TTL under the freshness SLA (say 30-60s). Popular queries hit the cache and bypass Redis and Elasticsearch entirely. The key insight is that the long tail dominates: 90% of queries are unique and cannot be cached. Caching is only effective for the 10% of trending or common queries. Do not over-invest in caching infrastructure — it provides diminishing returns.

**CDN edge caching.** For logged-out or unpersonalized results, set `Cache-Control: public, s-maxage=30` so CDN edges absorb the load and return results in tens of milliseconds. This is a significant win for trending topic queries from unauthenticated users.

**Posting list caps.** Cap each `idx:recency:*` and `idx:likes:*` at 1k-10k entries. If a token has more candidates, the overflow lives in cold storage (S3 + a secondary index) and is consulted only for queries that paginate past the cap. The cap must be set high enough that the top-N results for any sort order are fully contained within the hot index — for a keyword with 10M matching posts, only the top 10k by likes and top 10k by recency need to be in Redis.

**Cold / hot split.** Tokens that haven't been searched in weeks get demoted to a cold tier. Promotion happens on first query: the Search service detects a cold-tier miss, warms the Redis cache from Elasticsearch, and serves the result (with higher latency on the first request). Subsequent requests hit the warm Redis tier.

**Scatter-gather at Elasticsearch layer.** For deep pagination or queries that exhaust the Redis hot tier, the Search service falls through to Elasticsearch. A query scatters across all ES shards, each shard returns its top-N candidates, and the coordinating node gathers and merges them. The cost scales with shard count and posting list sizes. Explicit routing (routing queries to a subset of shards by some affinity) can reduce scatter-gather cost but requires careful index design.

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

**Failure mode that pushes to next stage.** `ILIKE '%term%'` cannot use a B-tree index because the leading wildcard prevents index use, forcing a full sequential table scan. At ~10k posts the query goes from milliseconds to seconds, and every concurrent search competes for the same scan. Adding `sort_by=likes` would require sorting the full result set per query. At 1 billion posts this is fatal — any solution involving a leading wildcard is disqualifying at scale.

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

**Failure mode that pushes to next stage.** Postgres FTS is viable up to roughly 50-100M rows. Beyond that, GIN index updates slow down writes (GIN index maintenance on high-concurrency inserts serializes), and concurrent searches on popular terms saturate the single primary. Sort-by-likes with a tsvector filter plus an `ORDER BY like_count` cannot use the GIN index for both; Postgres falls back to filter-then-sort, and the sort becomes expensive on popular keywords. Elasticsearch is required at billions of documents.

### Stage 3: 1K-100K Users

**Goal.** Move search off the primary database and onto a system designed for it. Start decoupling write path from index.

**Architecture.** Introduce a single-node Elasticsearch (or OpenSearch) cluster. Posts in Postgres remain the source of truth. Instead of application-level dual writes, introduce Debezium CDC: it captures row-level changes from the Postgres WAL, publishes to Kafka, and an indexer consumer transforms and writes to the `posts` index in Elasticsearch. This canonical CDC pattern (Postgres → Kafka → Elasticsearch) decouples the write path — the application writes only to Postgres, and the indexing lag is typically 1-5 seconds.

- Search service queries Elasticsearch with a `match` on content and a `sort` on either `@timestamp` or `like_count`.
- Elasticsearch's default 1-second refresh interval makes new documents searchable. At this stage that is fine; at higher write throughput, the refresh interval becomes a tuning knob.

Likes are batched: the Like service increments in Postgres synchronously and the CDC stream carries the update. A consumer throttles updates to Elasticsearch to every N seconds per post, avoiding per-like index writes.

**What you skip.** Sharded Elasticsearch, hot/cold separation, CDN, milestone thresholds. Ranking is still just two fixed sort orders.

**Failure mode that pushes to next stage.** A single ES node can hold maybe 50-100GB of index and a few thousand QPS. Beyond that, Lucene segment merges and shard rebalancing stall both reads and writes. Posting lists for celebrity terms grow without bound, and like updates, even batched, become the dominant write load.

### Stage 4: 100K-10M Users

**Goal.** Distribute the index across many machines and tame the hot-key problem for viral posts.

**Architecture.** Elasticsearch cluster with explicit sharding: say 32 primary shards with 2 replicas each. Documents are sharded by post ID for even write distribution. Queries scatter across all shards (scatter-gather), each shard returns its top-N, and the coordinating node merges — this is document sharding, the standard ES production approach. The alternative (term sharding — route all documents containing "python" to one shard) enables single-shard queries but creates hotshards for common terms and is almost never used in practice.

For single-keyword queries where ES fan-out is expensive, introduce a Redis-based inverted index as a first-stage filter:
- `idx:recency:<token>` - Redis list capped at 10k, LPUSH on insert, LTRIM.
- `idx:likes:<token>` - Redis sorted set capped at 10k, ZADD with like count as score.

Partition the Redis cluster by token hash. The Search service checks Redis first; only if it needs to paginate deeper or the token is cold does it fall through to Elasticsearch.

Switch like updates to milestone writes: the Like service maintains an authoritative counter in Postgres, and only emits an index-update event when the counter crosses a power-of-2 boundary. At query time, the Search service hydrates posts and calls the Like service for the current count to display.

Introduce CDN edge caching for logged-out search with a 30s cache-control header. Add an application-level result cache in Redis for logged-in queries, acknowledging that only the 10% non-long-tail queries benefit from it.

Replace the application-level Kafka publish with CDC on the Postgres WAL (Debezium) to guarantee no event is lost when the application crashes mid-write. This is a correctness fix, not just a scaling fix.

**What you skip.** Cross-region replication of the full index, geo-aware routing, ML ranking. Still two fixed sort orders.

**Failure mode that pushes to next stage.** At Facebook scale, the corpus is tens of billions of posts. Even a 10k cap per posting list holds the hot set, but long-tail queries — searching for a specific phrase in a post from 2015 — cannot be satisfied by the in-memory index. Cross-region latency matters; a user in Singapore hitting a US index cluster pays 200ms on the network alone.

### Stage 5: 10M+ Users

**Goal.** Serve billions of posts with sub-500ms p50 globally, while keeping index storage and write amplification tractable.

**Architecture.**

- **Hot / cold tiering.** The Redis inverted index holds only the top 10k most-recent and top-10k most-liked posts per token. Everything else lives in a cold tier: Elasticsearch warm/cold nodes (ILM policies automate the transition — posts older than 7 days move to warm-tier nodes with cheaper SSD storage, posts older than 30 days to cold-tier with slower latency). Cold queries are slower (a few seconds is acceptable) and are triggered only when a user pages past the hot cap.
- **Regional read replicas.** The inverted index is asynchronously replicated to each region. Writes flow to the home region; reads are local. Freshness in remote regions lags by a few seconds — well within the one-minute SLA.
- **Real-time indexing via CDC.** Debezium streams Postgres WAL into Kafka. A per-region indexer consumes and applies to the regional Redis and ES clusters. No application code participates in the write-to-index handoff — it is infrastructure-level. End-to-end indexing lag is 1-5 seconds.
- **Hot shard replication and key splitting.** For tokens whose write rate exceeds what a single Redis shard can absorb (more than 50k ops/s), split the token across N sub-shards with a suffix (`idx:likes:ukraine#0`, `#1`, `#2`), and fan out reads to all sub-shards, merging at the service layer. Detect hot keys with a sampling proxy and split them automatically.
- **Precomputed bigram index.** For frequent two-word queries (`taylor swift`, `world cup`), maintain a shingle index so the query is a single lookup instead of an intersection.
- **Tiered result cache.** CDN at the edge, application cache in Redis per region, and a query-plan cache that memoizes shard routing decisions. Invest heavily only in the 10% of non-long-tail queries that can actually be served from cache.
- **Like update backpressure.** Milestone updates use powers of 10 beyond 1000 likes (1k, 10k, 100k, 1M), collapsing a million-like event stream into five index writes per token. Query-time reconciliation against the Like service provides the display count.

**What you skip.** Nothing is really skipped at this stage — instead, each component is horizontally scaled, multi-region, and observability-heavy. The trade-off is operational: more moving parts, more on-call, more tuning knobs.

**Failure mode beyond this.** Further scale is a matter of shard count and hardware. The architecture does not have a new qualitative failure mode; the next frontier is qualitative product changes — semantic search, personalization, multimodal content — which require a different kind of index (vector stores, learned rankers) rather than another scaling step for the keyword index.

---

## Insider Tips and Tricks

### LIKE '%query%' Is a Table Scan — Never Use It

A leading wildcard in a SQL `LIKE` or `ILIKE` clause prevents the query planner from using a B-tree index, forcing a full sequential scan of the table. At 10,000 rows this is slow. At 1 billion rows it is fatal — every concurrent search ties up I/O capacity for seconds. There is no configuration change or hardware upgrade that rescues this pattern at scale.

The correct progression: Postgres full-text search with a GIN index on a `tsvector` column is acceptable for low millions of rows. It supports tokenization, stopwords, and stemming natively. Beyond 50-100 million rows (depending on write concurrency), GIN index maintenance becomes a write bottleneck and query concurrency saturates the primary. At billions of rows, Elasticsearch or OpenSearch is required — they are built specifically for this workload. Name this progression explicitly in an interview to show you understand why different technologies exist.

### Document Sharding vs Term Sharding

Elasticsearch shards by document: each shard holds a random subset of documents (determined by a hash of the document ID). A query for "python tutorial" must be sent to all shards, each shard returns its top candidates, and the coordinating node merges the results into a global top-N. This is called scatter-gather and is the standard production approach for document-sharded indexes.

The alternative is term sharding: shard by term, so all documents containing "python" go to one shard. This means a single-keyword query hits only one shard — no scatter-gather. The problem: common terms like "the", "a", or "python" appear in billions of documents, so the shard holding those terms receives all writes and reads for those terms. This creates catastrophic hotshards. Term sharding sounds appealing in theory but is almost never used in production search systems. In an interview, mentioning this distinction and explaining why document sharding with scatter-gather is the standard approach signals strong depth.

### Index Refresh Interval Is a Hidden Write Bottleneck

Elasticsearch's default refresh interval is 1 second. A refresh makes newly indexed documents searchable by flushing in-memory write buffers to a new Lucene segment on disk. Refreshing every second means a Lucene segment merge happens every second — at high write throughput (thousands of documents per second), this causes garbage collection pressure from small segment proliferation and periodic write stalls as merge threads compete with indexing threads.

Two practical mitigations: bulk indexing pipelines disable the refresh interval during the bulk load (`index.refresh_interval: -1`), index in large batches, then re-enable. For near-real-time requirements (new posts searchable within 1-5 seconds), set the interval to `5s` instead of `1s` — this reduces merge frequency by 5x with minimal user-visible impact. The key interview point: indexing lag is not 0ms. Accepting a 1-5 second indexing delay is correct engineering, not a deficiency.

### Social Signals Outweigh Text Relevance

BM25 is the industry-standard text relevance formula: it ranks documents by term frequency, inverse document frequency, and field length normalization. Applied naively to social search, it produces the wrong results. A post from your close friend mentioning "coffee" ranks below a high-engagement public post about coffee from a celebrity you don't follow — but the friend's post is almost certainly more relevant to you.

In production social search, the dominant ranking signals are social: graph distance (1st-degree connection vs. 2nd-degree vs. stranger), author relationship (close friend vs. followed vs. public figure), and prior engagement history with the author (have you liked, commented on, or shared their posts before). BM25 text score becomes a tiebreaker among socially-equidistant candidates. For this problem, pure text ranking (recency and likes) is explicitly in scope and social personalization is out of scope — but naming this gap in a senior or staff interview demonstrates that you understand what a production social search system actually optimizes for.

### Typeahead Is a Completely Different System

Autocomplete — surfacing query suggestions as the user types ("pyth" → ["python", "python tutorial", "python jobs"]) — is not full-text search. They solve different problems, use different data structures, and have different latency budgets.

Typeahead is a prefix lookup problem: given a prefix string, return the highest-frequency queries that start with that prefix. The canonical implementations are: a trie (prefix tree) with frequency scores at each node; Redis sorted sets where members are full query strings and scores are query frequencies (a `ZRANGEBYLEX` on a common prefix returns candidates in O(log N + M)); or a prefix-compressed finite state transducer (FST) for memory-efficient in-process lookup. Typeahead must return results in under 50ms to feel instant while typing — it cannot touch Elasticsearch (which has 5-20ms network latency before any query execution) and requires a dedicated in-memory data structure, often served from a separate typeahead service backed by Redis or an in-process FST. Conflating typeahead with search in a design interview reveals a gap in understanding the product.

### Hot/Cold Index Tiers Save Cost and Improve Latency

The access pattern for a search index is highly skewed by time: posts from the last 7 days receive the overwhelming majority of search traffic. Posts from 6 months ago are rarely searched and can tolerate higher query latency.

Elasticsearch Index Lifecycle Management (ILM) automates tiered storage: a hot tier uses high-memory nodes with NVMe SSDs optimized for fast indexing and query throughput; a warm tier uses nodes with slower SSDs and more storage density; a cold tier uses object storage (S3) with the index loaded on demand. ILM policies automatically move index shards between tiers based on age and query frequency. In the context of this problem, maintaining a separate Redis-based hot index for the last 7 days of posts per token, with fallback to Elasticsearch for older posts, mirrors this same principle at the application layer. The result: p50 latency drops because the hot path (Redis) is sub-millisecond, while cost drops because old posts live on cheap storage.

### CDC Pipeline: Postgres → Kafka → Elasticsearch

The canonical pattern for keeping a search index synchronized with a relational database is: Debezium captures row-level changes from the Postgres write-ahead log (WAL) and publishes them to Kafka; a consumer reads from Kafka and indexes into Elasticsearch. This is superior to application-level dual writes (write to Postgres AND synchronously call Elasticsearch) for three reasons: it eliminates dual-write consistency failures (the Postgres commit is the source of truth, not the application's perception of success); it provides a replay capability (if Elasticsearch falls behind or is rebuilt, replay from the earliest Kafka offset); and it decouples the write path (the application does not wait for Elasticsearch — the indexing lag is asynchronous and observable). End-to-end indexing lag with this pipeline is typically 1-5 seconds. For this problem's one-minute freshness SLA, that is a 10x margin.

### Privacy Enforcement at Query Time, Not Index Time

A naive implementation only indexes public posts, making private posts unsearchable. This is wrong: users need to search their own posts, and friends may need to search posts shared with them. The correct approach is to index all posts with ACL (access control list) metadata — visibility flags, friend list identifiers, group memberships — attached to each document. At query time, the Search service applies a post-filter: after Elasticsearch retrieves candidates by text relevance, it filters to documents the searcher has permission to see. Elasticsearch field-level security and post-filter clauses implement this natively.

The tradeoff is performance: query-time filtering adds latency proportional to the number of candidates that must be examined and filtered. If a user searches a rare term that appears in 10 private posts and 2 public posts, the filter examines all 12 candidates but returns 2 — acceptable. If the term appears in 10 million posts with mixed visibility, the filter may need to examine thousands of candidates to fill a page of results. Mitigation: index visibility as a high-cardinality numeric field and use Elasticsearch's bitset-cached filters to make post-filtering nearly free for common visibility patterns.

### The "Long Tail Query" Problem

The distribution of search queries follows a power law: a small number of queries (trending topics, celebrity names, common phrases) are searched millions of times per day, while the vast majority of queries are searched once or a handful of times. In practice, roughly 90% of distinct search queries are unique — they have never been seen before in that exact form and will never be seen again. These long-tail queries cannot be served from a result cache.

The practical implication: aggressive result caching with Redis provides a large win for the 10% of hot queries (trending terms, popular hashtags) but zero benefit for the 90% long tail. Cache hit rates for a search system are structurally lower than for content delivery. Do not architect your system around a cache hit rate assumption of 80% or 90% — the actual rate may be 10-30% depending on the query distribution. The correct investment is in making the uncached path fast (well-sharded index, capped posting lists, efficient scatter-gather), not in trying to cache your way out of the problem.

---

## Expected Depth by Level

| Level | Breadth vs Depth | What to nail | What to drive proactively |
|---|---|---|---|
| Mid | ~80% breadth, ~20% depth | Clear APIs, correct data model, both write and read paths present, basic awareness of caching and TTLs. Accept interviewer nudges toward optimizations without being thrown off. | Get to a working end-to-end design. One deep dive (usually the inverted index itself) is enough. |
| Senior | ~60% breadth, ~40% depth | Move through the initial design quickly, then focus the conversation on the critical path: the inverted index structure, how writes fan out, how reads stay under 500ms. Name trade-offs explicitly (memory vs latency, freshness vs write amplification). Articulate why LIKE '%query%' fails and why Elasticsearch uses document sharding rather than term sharding. | Proactively surface the hot-key problem, the like-update volume, the need for sharding, and the CDC pipeline as the correct write-decoupling pattern before being asked. |
| Staff+ | ~40% breadth, ~60% depth | Multiple deep dives with concrete configuration choices (Redis sorted set vs list, shard count, milestone thresholds, CDC vs app-level events, ES refresh interval tuning, ILM policy configuration). Draw on real operational experience: segment merges, hot shard mitigation, regional consistency, privacy enforcement at query time vs index time. Articulate why social signals dominate text relevance in production. | Identify non-obvious issues before the interviewer (duplicate event delivery, index drift after a replay, sort-order skew from milestone approximation, long-tail query cache hit rate assumptions, typeahead as a distinct system) and propose concrete mitigations with novel angles. |
