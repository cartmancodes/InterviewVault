# Design News Aggregator (Google News)

> **Pattern**: Content Ingestion / Clustering
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/google-news)

---

## Table of Contents

- [Understanding the Problem](#understanding-the-problem)
  - [Functional Requirements](#functional-requirements)
  - [Non-Functional Requirements](#non-functional-requirements)
- [Core Entities](#core-entities)
- [API Design](#api-design)
- [High-Level Design](#high-level-design)
- [Deep Dives](#deep-dives)
  - [1. Ingest Pipeline](#1-ingest-pipeline)
  - [2. Clustering and Deduplication](#2-clustering-and-deduplication)
  - [3. Personalization](#3-personalization)
  - [4. Freshness and Breaking-News Spikes](#4-freshness-and-breaking-news-spikes)
- [Scaling Journey: 0 → ∞](#scaling-journey-0--)
  - [Stage 1: 0 – 100 Users](#stage-1-0--100-users)
  - [Stage 2: 100 – 1K Users](#stage-2-100--1k-users)
  - [Stage 3: 1K – 100K Users](#stage-3-1k--100k-users)
  - [Stage 4: 100K – 10M Users](#stage-4-100k--10m-users)
  - [Stage 5: 10M+ Users](#stage-5-10m-users)
- [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A news aggregator like Google News pulls articles from thousands of publishers worldwide, groups articles that cover the same story, and presents a single browsable feed. Users land on a home page, scroll through an endless list of stories, and click out to the publisher when they want the full text. The aggregator never hosts the article body — it surfaces headline, thumbnail, source, and a redirect link.

### Functional Requirements

**In scope:**
1. Pull articles continuously from thousands of publisher feeds (RSS, sitemaps, partner APIs).
2. Present users with a reverse-chronological or ranked feed that supports infinite scroll.
3. Redirect clicks to the original publisher URL (no content hosting).

**Out of scope:** bookmarking, saved articles, social sharing, comments, and full-text hosting.

### Non-Functional Requirements

1. **Availability over consistency** — users tolerate a slightly stale feed, but the home page must never be down.
2. **Freshness**: a newly published article should appear in the feed within ~30 minutes of its publish time.
3. **Low feed latency**: under 200 ms for the initial feed load and each scroll page.
4. **Spike resilience**: breaking-news events can multiply read traffic 10–50x in minutes.
5. **Read-heavy**: reads dominate writes by several orders of magnitude.

---

## Core Entities

| Entity | Description |
|---|---|
| **Article** | A single news item ingested from a publisher. Fields: `articleId`, `sourceId`, `url`, `title`, `summary`, `thumbnailUrl`, `publishedAt`, `language`, `rawText`, `shingleHash`, `clusterId`. |
| **Source (Publisher)** | An outlet the system pulls from (NYT, BBC, local blog). Fields: `sourceId`, `feedUrl`, `type` (RSS/API/sitemap), `trustScore`, `lastPolledAt`, `pollInterval`. |
| **Cluster (Story)** | A group of articles describing the same real-world event. Fields: `clusterId`, `representativeArticleId`, `topic`, `category`, `firstSeenAt`, `hotness`, `articleCount`. |
| **User** | A feed consumer. Fields: `userId`, `locale`, `region`, `categoryAffinity`, `sourceAffinity`, `lastFeedCursor`. |

Clusters are the user-facing unit. A user scrolling the feed sees one card per cluster; tapping a cluster expands into its member articles.

---

## API Design

```
GET /v1/feed?cursor={opaque}&limit={n}&category={optional}
  → { clusters: [{ clusterId, headline, summary, thumb, topSources, publishedAt }...],
      nextCursor }

GET /v1/clusters/{clusterId}
  → { clusterId, articles: [{ articleId, url, title, source, publishedAt }...] }

POST /v1/click
  body: { articleId, clusterId }
  → 302 Redirect to publisher URL

GET /v1/categories
  → [{ id, label }]
```

The feed endpoint returns clusters, not raw articles. Cursor is opaque and encodes a `(score, clusterId)` tuple for stable pagination when the ranking shifts slightly between calls.

---

## High-Level Design

The system splits cleanly into an **ingest plane** (write path) and a **serve plane** (read path), connected by a shared article/cluster store.

**Ingest plane:**
1. **Feed Poller** — a scheduler iterates registered sources on their polling cadence (1–30 min) and fetches RSS/sitemap deltas.
2. **Fetcher** — downloads the article HTML, runs readability extraction for title, summary, image, and clean text.
3. **Normalizer** — canonicalizes URLs, strips tracking params, detects language, generates a content fingerprint (SimHash / MinHash shingles).
4. **Deduper** — checks fingerprints against a rolling window to drop exact or near-exact republishes.
5. **Clusterer** — groups new articles with existing live clusters based on fingerprint similarity and title/entity overlap; creates new clusters when no match is found.
6. **Indexer** — writes the cluster and article records to the primary store and pushes searchable documents into Elasticsearch.

**Serve plane:**
1. **Feed Service** — builds a user's page by pulling the top-K fresh clusters filtered by language/region/category and applying a personalization re-rank.
2. **Cache Layer** — Redis holds a global "hot feed" and per-user personalized pages; CDN fronts static assets and thumbnails.
3. **Click Tracker** — logs the click event asynchronously and 302s to the publisher.

Article text is never served — only the headline, summary, and a thumbnail URL.

---

## Deep Dives

### 1. Ingest Pipeline

The poller is the throttle point. A naive per-minute sweep of 100K sources would hammer publisher servers and burn bandwidth. Instead, each source gets an adaptive `pollInterval` derived from its historical publish rate: a 24/7 wire service gets polled every 60s; a weekly blog every 6h. A priority queue of `(nextPollAt, sourceId)` entries is consumed by a pool of fetcher workers.

Fetches fail often (timeouts, 403s, malformed feeds). The pipeline treats each source independently — one bad publisher cannot stall the queue. Failures use exponential backoff capped at the source's normal interval; repeated failures trigger an operator alert.

After fetch, extraction runs through a library like Readability or Trafilatura. The extracted text is **not stored long-term** — only the fingerprint and summary survive, which keeps storage cost linear in cluster count rather than article count.

A message broker (Kafka) separates fetch, extract, dedupe, and cluster so each stage scales independently and a slow clustering worker cannot block the fetchers.

### 2. Clustering and Deduplication

Two distinct problems:

**Deduplication** catches the same article republished at different URLs (wire services, syndication). A SimHash over the article's shingles produces a 64-bit signature; articles within Hamming distance ≤ 3 are considered duplicates and collapsed to a single canonical article. Signatures live in Redis keyed by a 16-bit prefix bucket so lookup is O(bucket size) instead of O(N).

**Clustering** groups different articles about the same story. This is online clustering — articles arrive continuously and must be placed without re-partitioning the world. The approach:

1. Extract named entities and a TF-IDF vector from the article title + summary.
2. Compute MinHash signatures and query an LSH (locality-sensitive hashing) index keyed on shingles to find candidate clusters.
3. Score each candidate with cosine similarity of the TF-IDF vector plus entity-overlap bonus.
4. If the top score clears a threshold, join that cluster; otherwise mint a new cluster.

Clusters have a **lifespan**: a cluster stops accepting new members 48 hours after its first article, because a story that re-surfaces later is usually a follow-up worth its own cluster. Expired clusters drop out of the hot index but remain queryable in cold storage.

Trade-off: tighter thresholds over-split (many small clusters for one story); looser thresholds merge unrelated stories. The system ships with a threshold tuned on a labeled dev set and re-evaluated offline.

### 3. Personalization

The out-of-the-box feed is a global hot list. Personalization is a re-ranker on top, not a separate feed.

**Signals:**
- Explicit: chosen categories, followed sources.
- Implicit: click history, dwell time, source preferences derived from past clicks, device locale.

**Flow:**
1. A feature service computes a per-user vector of category weights and source weights, updated nightly in batch plus a lightweight online update after each click.
2. On a feed request, the service fetches the top 500 candidate clusters from the global hot list for the user's locale.
3. A lightweight scorer (logistic regression or gradient-boosted tree over ~30 features) ranks those 500 down to the 20 returned per page.
4. Diversity logic enforces a cap per source and per category so one publisher cannot dominate.

Scoring runs in ~5 ms at the feed server; the expensive feature generation is pre-computed. Candidate generation is cached per-region for 30–60s because the hot list changes slowly relative to request rate.

### 4. Freshness and Breaking-News Spikes

Two tensions: articles must appear within 30 min of publish, but the feed must cache aggressively to stay under 200 ms.

**Freshness mechanism:**
- A "new articles" Kafka topic feeds a side process that invalidates cached feed pages whenever a cluster's hotness changes materially (new members, sudden click velocity).
- The global hot-list cache has a short TTL (30–60 s). Personalized pages use a longer TTL (2–5 min) because a given user's re-rank is stable over that window.
- Cache keys include a `contentVersion` stamp so a new version is published as a cache-aside write; old keys expire naturally.

**Breaking news** produces a thundering herd — everyone requests the same trending cluster. Defenses:
- Edge CDN caches the cluster detail response for 10–30 s; every POP absorbs most load.
- A request-coalescing layer at the feed service dedupes concurrent upstream fetches for the same cluster to a single DB read.
- Auto-scaling on the feed service keyed on request rate, not CPU, because the service is largely cache-reads.
- The clusterer itself must absorb a flood of correlated incoming articles on a breaking event. It shards cluster ownership by `clusterId` hash, so a single hot cluster is still pinned to one worker — this worker keeps the cluster's fingerprint cache in memory, making membership checks O(1).

---

## Scaling Journey: 0 → ∞

### Stage 1: 0 – 100 Users

**Goal:** prove the product — can we pull articles and show a feed?

**Architecture:**
- One box running a Python script triggered by cron every 5 minutes. It walks a hand-curated list of ~50 RSS feeds, parses them with `feedparser`, and writes rows into SQLite.
- A Flask/FastAPI app serves `GET /feed` with `SELECT * FROM articles ORDER BY published_at DESC LIMIT 50`.
- Deduplication is literally `WHERE url NOT IN (existing_urls)`.
- No clustering. Every article is its own card. No personalization.

**What you skip:** Kafka, Elasticsearch, clustering, caching, personalization, multi-region, authentication. You don't even have users yet — the "feed" is public.

**Failure mode → next stage:** two articles about the same story show up side by side from different wires. The homepage looks like a spammy RSS reader. You need deduplication, and the cron job starts missing its window as the source list grows to a few hundred feeds.

---

### Stage 2: 100 – 1K Users

**Goal:** kill visible duplicates and keep the feed fresh as the source list and traffic grow.

**Architecture:**
- Migrate SQLite → Postgres. Add a `sources` table so polling cadence is data-driven.
- Replace the single cron with a small worker pool using a database-backed job queue (e.g., RQ or a `next_poll_at` column polled by workers).
- Introduce Redis. Cache the `/feed` response for 60 seconds. Store a rolling set of URL + SimHash fingerprints for the last 72 hours of articles; the fetcher rejects near-duplicates by looking up the SimHash bucket in Redis.
- Add a thumbnail resizer writing to S3, fronted by CloudFront.
- Basic readability extraction replaces raw RSS summaries so cards look consistent.

**What you skip:** real online clustering (duplicates are killed, but articles about the same story from different outlets still appear as separate cards), search, personalization, ML ranking.

**Failure mode → next stage:** during a big news moment, the feed is dominated by ten near-identical takes on the same event from ten different outlets — dedupe doesn't catch them because the text is substantially different. Users complain the feed is repetitive. Time for clustering.

---

### Stage 3: 1K – 100K Users

**Goal:** cluster articles into stories and make the serve path truly fast.

**Architecture:**
- Introduce Kafka with topics: `raw-fetched`, `extracted`, `deduped`, `clustered`. Each stage is a separate worker fleet scaled independently.
- **Clustering worker**: for each new article, compute MinHash shingles, query an LSH index (stored in Redis or a dedicated service like Elasticsearch with custom similarity) for candidate clusters within a 48-hour window, score candidates with TF-IDF cosine + entity overlap, join or mint.
- **Elasticsearch** indexes both articles and clusters. It powers category filters (`category:tech`), text search, and the candidate-retrieval step for ranking.
- Feed service reads the top-N clusters from a Redis sorted set keyed by `(region, category)` with score = hotness. The sorted set is rebuilt every 30 seconds by a background job.
- Per-user state is minimal: a locale and optional category filter. Personalization is still "choose your categories," not ML.
- Infra: services run on an orchestrator (ECS/Kubernetes). Postgres gets a read replica.

**What you skip:** ML personalization, multi-region, edge caching, request coalescing. The system is single-region.

**Failure mode → next stage:** traffic hits 100K DAU with regional spikes. European users suffer 400+ ms from the US-east region, the sorted-set rebuild job becomes a bottleneck, and the product team wants personalized feeds tied to reading history.

---

### Stage 4: 100K – 10M Users

**Goal:** personalize the feed and keep p99 latency sane across regions.

**Architecture:**
- **Precomputed personalized feeds**: for each active user, a nightly batch job (Spark) computes a category/source affinity vector. A streaming job updates the vector after each click. On feed request, the service pulls the top 500 candidate clusters for the user's region from Elasticsearch and re-ranks with a gradient-boosted model.
- **Cache strategy**: two tiers. L1 is a per-user precomputed page held in Redis for 2–5 minutes. L2 is the regional hot list cached for 30 s. Cache miss for L1 triggers on-demand re-ranking.
- **Click tracking**: Kafka `user-events` topic feeds both the online feature updater and an analytics warehouse (BigQuery / Snowflake).
- **Multi-region**: deploy ingest in one primary region (to keep clustering globally consistent) and replicate the cluster/article store to two additional regions. Feed services run regionally and read the local replica.
- **Thumbnail delivery** moves to a global CDN with long cache-control headers.
- **Source tier**: 50K+ publishers, polled by a dedicated poller cluster with a distributed priority queue (Redis ZSET or a custom scheduler).

**What you skip:** edge personalization (personalization still happens in a regional data center, not at the POP), ML-driven clustering, cross-region active-active writes.

**Failure mode → next stage:** a breaking global story produces a write-hot cluster receiving thousands of candidate articles, and the clustering worker for that shard stalls. Simultaneously, a launch into a new country puts users 200 ms away from the nearest region and the home page feels sluggish.

---

### Stage 5: 10M+ Users

**Goal:** absorb global breaking news without degradation and cut user-perceived latency to near-zero.

**Architecture:**
- **Edge compute for personalization**: push a light-weight re-ranker to CDN workers (Cloudflare Workers, Lambda@Edge). The origin publishes a regional candidate list (top 1000 clusters) once every 30 s; the edge personalizes it per request using a cookie-borne user vector. Feed responses originate from the POP — p99 under 100 ms globally.
- **Multi-region active serve**: every region has a full read replica of the cluster and article stores and its own Elasticsearch cluster fed from a global change-data-capture stream.
- **Clustering workers shard by clusterId hash**, and the hot-cluster shard keeps its fingerprint table in process memory. Within-shard updates are single-threaded per cluster, avoiding locks.
- **Request coalescing + negative caching** at the feed service stop stampedes: a miss on a popular cluster is filled once and shared across all concurrent waiters.
- **Autoscaling** on feed service keyed on RPS per region with pre-warmed capacity triggered by a "breaking-news detector" watching cluster hotness velocity.
- **Storage tiering**: hot clusters (<48h) in Redis + Elasticsearch; warm (<30d) in Postgres/DynamoDB; cold archive in object storage with a batch-served historical API.
- **Cost controls**: reduce poll frequency for low-yield sources automatically; sample click events for analytics; compress thumbnails aggressively at the edge.

This is where the system stops being a CRUD app and becomes a pipeline-plus-CDN, with the edge doing real per-user work. The next failure modes are organizational — content policy, source trust scoring, and ML quality — rather than infrastructure.

---

## Expected Depth by Level

| Level | Expected Depth |
|---|---|
| **Mid (L4)** | Functional/non-functional requirements laid out cleanly. A working high-level design with ingest, store, serve split. At least one deep dive on deduplication or freshness with concrete mechanisms (SimHash, caching). Acknowledges but does not implement clustering and personalization. |
| **Senior (L5)** | All of the above plus a credible clustering design (LSH / MinHash, threshold tuning, cluster lifespan). Discusses cache hierarchy (L1 per-user, L2 regional) and freshness vs. latency trade-off. Identifies the hot-cluster write problem and proposes shard-by-clusterId. Covers breaking-news spikes and request coalescing. |
| **Staff (L6+)** | Drives the conversation end-to-end. Proposes edge-side personalization with origin-published candidate lists. Discusses multi-region write topology for the ingest plane versus regional serve replicas. Quantifies trade-offs with rough math (storage per article, fingerprint lookup cost, cache hit-rate targets). Brings up content policy, source trust, cold-storage economics, and how the clustering quality is measured and retrained offline. |
