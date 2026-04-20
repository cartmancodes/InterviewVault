# Design Yelp

> **Pattern**: Geospatial Search / Reviews
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/yelp)

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Geospatial Search by Radius](#1-geospatial-search-by-radius)
   - [2. Review Aggregation](#2-review-aggregation)
   - [3. Caching Popular Locations](#3-caching-popular-locations)
   - [4. Photo Uploads](#4-photo-uploads)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Yelp is a local-business discovery platform. A user standing on a street corner in San Francisco wants to answer "what good ramen is within half a mile of me that's open right now?" Under the hood this is a geospatial query joined with reviews, categories, and operating hours, sorted by a relevance signal. The primary read pattern is spatial-and-filtered search; the primary write pattern is a trickle of reviews and a slow cadence of business edits.

### Functional Requirements

**In scope (core):**
1. A user can search for businesses by name, geographic location (lat/long or city), and category.
2. A user can view a business detail page including its metadata, aggregate rating, and reviews.
3. A user can leave a review on a business with a required 1 to 5 star rating and optional text body.

**Out of scope:**
- Business owner/admin tooling for claiming or editing listings.
- An interactive map UI layer (we design the query API, not the map widget).
- Personalized ranking or recommendations.
- Reservations, ordering, or check-ins.

### Non-Functional Requirements

**In scope (core):**
- **Low read latency**: search results in under 500 ms p99.
- **High availability over strong consistency**: a stale review count for a few seconds is acceptable.
- **Scale target**: 100M daily active users and roughly 10M businesses.
- **Read-heavy workload**: reads dominate writes by orders of magnitude, which shapes every caching and indexing decision.

**Out of scope:**
- GDPR / data residency plumbing.
- Abuse, fraud, and spam-review detection.
- Detailed disaster recovery and multi-region failover protocols.

---

## Core Entities

| Entity | Key Fields | Notes |
| --- | --- | --- |
| **Business** | business_id (PK), name, category_ids, lat, lng, address, phone, hours, avg_rating, review_count | Geospatial row; avg_rating and review_count are denormalized for fast read. |
| **Review** | review_id (PK), business_id (FK), user_id (FK), stars (1-5), body, created_at | Unique (business_id, user_id) to prevent duplicate reviews per user. |
| **User** | user_id (PK), name, email, created_at | Kept thin in this scope. |
| **Location** | Usually modeled as (lat, lng) on Business, optionally normalized as city_id / neighborhood_id for named-location searches. | A secondary Location table is useful if we want "search in Mission District" style queries. |
| **Photo** (supporting) | photo_id, business_id, user_id, s3_key, created_at | Stored as metadata; bytes live in object storage. |

---

## API Design

A small, REST-style surface is enough. The search endpoint is the hot path.

```
GET /v1/businesses/search
  ?query={string}           # optional name substring
  &lat={float}&lng={float}  # center of the search
  &radius={meters}          # defaults to e.g. 5000
  &category={string}        # optional
  &sort={relevance|rating|distance}
  &page_token={opaque}
-> 200 {
     results: [{ business_id, name, category, distance_m, avg_rating, review_count, thumbnail_url }],
     next_page_token
   }
```

```
GET /v1/businesses/{business_id}
-> 200 { business_id, name, category, lat, lng, address, hours,
         avg_rating, review_count, photos: [...], top_reviews: [...] }
```

```
POST /v1/businesses/{business_id}/reviews
  Authorization: Bearer <jwt>
  Body: { stars: 1..5, body?: string, photo_ids?: [string] }
-> 201 { review_id, created_at }
  409 if the user already has a review for this business
```

```
GET /v1/businesses/{business_id}/reviews
  ?page_token=&sort={newest|highest|lowest|helpful}
-> 200 { reviews: [...], next_page_token }
```

```
POST /v1/photos:initiate-upload
  Body: { business_id }
-> 200 { photo_id, upload_url, upload_fields }   # S3 presigned POST

POST /v1/photos/{photo_id}:finalize
-> 200 { photo_id, url }
```

Notes:
- User identity is pulled from the JWT, never from the request body, so clients cannot impersonate reviewers.
- Pagination is cursor-based; offset pagination falls apart at scale when results shift.

---

## High-Level Design

```
           +----------+         +--------------+
 Client -->|  CDN /   |-------->|  API Gateway |
           |  Edge    |         |  + AuthN/Z   |
           +----------+         +------+-------+
                                       |
                    +------------------+------------------+
                    |                  |                  |
              +-----v-----+      +-----v-----+      +-----v-----+
              |  Search   |      | Business  |      |  Review   |
              |  Service  |      |  Service  |      |  Service  |
              +-----+-----+      +-----+-----+      +-----+-----+
                    |                  |                  |
              +-----v------------+     |                  |
              | Elasticsearch    |     |                  |
              | (geo+filters)    |     |                  |
              +-----+------------+     |                  |
                    |                  v                  v
                    |           +------------------------------+
                    +---------->|  Postgres + PostGIS (source  |
                                |  of truth: business, review) |
                                +--------------+---------------+
                                               |
                                    +----------v----------+
                                    |  Redis (hot results,|
                                    |  avg rating cache)  |
                                    +---------------------+

   Photos upload directly to S3 via presigned URLs.
   CDC from Postgres -> Kafka -> indexers update Elasticsearch and Redis.
```

**Request flow for search:**
1. Client hits `/search` with lat, lng, radius, filters.
2. Search service checks Redis for a cache key derived from (geohash_prefix, category, sort).
3. On miss, it queries Elasticsearch using a `geo_distance` filter plus category and text match, then writes the result into Redis with a short TTL.
4. Business and review data in results come pre-denormalized in the Elasticsearch document so we do not fan out to the DB per hit.

**Request flow for review write:**
1. Review service validates the user, inserts into Postgres with a unique `(business_id, user_id)` constraint.
2. A CDC stream (Debezium on Postgres WAL) emits the change to Kafka.
3. A consumer updates the business's `avg_rating` and `review_count` incrementally and re-indexes the Elasticsearch document.
4. Hot-location caches are invalidated by geohash prefix.

---

## Deep Dives

### 1. Geospatial Search by Radius

The central question: given `(lat, lng, radius)`, return nearby businesses efficiently. Three serious options:

**A. Naive bounding box in a B-tree.** Index lat and lng separately, filter `lat BETWEEN ? AND ?` and `lng BETWEEN ? AND ?`. Works for small data; breaks at scale because the composite selectivity is poor and you still compute Haversine distance on every candidate.

**B. Geohash.** Encode each business's lat/lng as a base-32 string where shared prefix implies spatial proximity. Index the geohash as a string. To search within radius, compute the geohash of the center, then query the prefix plus the 8 neighboring cells to avoid edge cases. Pros: cheap, works in any KV/SQL store, composes nicely as a Redis cache key. Cons: rectangular cells, jagged radius, you over-fetch at cell boundaries and filter in application code.

**C. PostGIS / R-tree (GiST index).** Store location as `geography(Point, 4326)` and use `ST_DWithin(location, ST_MakePoint(lng, lat)::geography, radius_m)`. The GiST index gives true 2D spatial locality. This is what you pick as the source of truth.

**D. Elasticsearch `geo_point` + `geo_distance` filter.** For search where you also want text relevance, category facets, and "open now," Elasticsearch is a better fit than raw PostGIS because it combines all filters into one scored query. Kept in sync from Postgres via CDC.

**Recommendation:** Postgres + PostGIS as source of truth, Elasticsearch as the read-optimized search index, geohash as the cache key in Redis for hot queries.

**Edge cases worth calling out:**
- Earth is a sphere; use the `geography` type, not `geometry`, to get accurate meter distances.
- At the 180th meridian and at the poles, geohash neighbor logic breaks; PostGIS handles this natively.
- Radius searches in dense areas like Manhattan return thousands of candidates; always paginate and cap `radius`.

### 2. Review Aggregation

Each business detail and each search hit shows `avg_rating` and `review_count`. Computing these on the fly is prohibitive at 10M businesses with hundreds of millions of reviews.

**Approach: incremental denormalization.**
- Store `avg_rating` and `review_count` as columns on the Business row.
- On review insert, update in the same transaction:
  ```
  UPDATE business
  SET review_count = review_count + 1,
      avg_rating = ((avg_rating * review_count) + :new_stars) / (review_count + 1)
  WHERE business_id = :id;
  ```
- This keeps the aggregate numerically stable enough for 1-5 ratings. For edits/deletes, recompute from a running sum stored alongside.

**Alternative: async aggregation.** Stream reviews into Kafka, have a consumer maintain aggregates in a separate service (or materialized view), and write back to the Business table periodically. This removes contention on the business row during write spikes but adds lag; acceptable given the eventual-consistency NFR.

**Pitfall:** floating-point drift. Store both `sum_stars` (int) and `review_count` (int), compute average on read. This is exact and survives arbitrary numbers of updates.

### 3. Caching Popular Locations

Most search traffic is not uniform across the globe. A small number of metros (NYC, SF, LA, London, Tokyo) generate the majority of queries.

**Layered cache strategy:**
1. **Edge cache / CDN** for logged-out, generic queries keyed by `(geohash_prefix, category)`. TTL in minutes; invalidated by review/business updates in the region.
2. **Redis** in front of Elasticsearch, keyed by the normalized query. For hot cities, precompute and prewarm the top N queries (e.g., "top 50 restaurants near Union Square") nightly.
3. **Application-level memoization** for the business detail page - cache the fully assembled response for a few seconds.

**Tile-based precomputation:** for each geohash cell at a chosen precision (e.g., 6-char geohashes, about 1.2 km x 600 m), precompute the top businesses per category and store in Redis. A radius search becomes "find the covering tiles, union their precomputed top lists, filter by exact distance." This turns the hot path into a handful of KV lookups.

**Invalidation:** driven by the CDC stream. When a business or review changes, compute its geohash tile and publish an invalidation message. A small fan-out to neighboring tiles keeps radius queries correct.

### 4. Photo Uploads

Uploading photo bytes through your API servers is a waste of bandwidth and a scaling anti-pattern. Let clients talk to object storage directly.

**Flow:**
1. Client calls `POST /v1/photos:initiate-upload` with `business_id`.
2. Server creates a `Photo` row in `PENDING` state and returns an **S3 presigned POST URL** with a short expiry (e.g., 15 minutes), a max content-length, and an allowed content-type.
3. Client PUTs the bytes straight to S3.
4. S3 fires an event (S3 -> SQS or S3 -> Lambda) on successful upload.
5. A worker validates the object (size, content-type sniff, optional NSFW/EXIF scrub), generates thumbnails, moves state to `READY`, and writes a CloudFront URL onto the Photo row.
6. Client either polls `GET /v1/photos/{id}` or receives a push notification before displaying the photo.

**Why this matters:**
- API servers never see the bytes, so uploads do not cap your API throughput.
- S3 handles durability (11 9s) and multipart uploads for large files.
- CloudFront serves the thumbnails globally with edge caching.
- Orphaned `PENDING` rows are reaped by a sweeper after TTL.

---

## Scaling Journey: 0 to Infinity

This is the Yelp-specific scaling arc: where do you start, and what breaks next?

### Stage 1: 0 to 100 Users

**Goal:** ship something end-to-end and get real usage.

**Architecture:**
- Single region, single VM (or one container) running a monolithic API.
- Postgres on the same host, with a `businesses` table that stores `lat`, `lng` as plain numeric columns.
- No cache. No search engine. Distance computed in SQL with Haversine over a bounding-box prefilter.
- Photos uploaded to S3 with presigned URLs from day one (this is cheap and avoids painful migration later).

**What you skip:** PostGIS, Elasticsearch, Redis, CDC, sharding, multi-region, prewarming, fancy pagination.

**Failure mode that forces the next stage:** queries beyond a small dataset start to take hundreds of milliseconds because Haversine across a bounding box scans too many rows and the review list on a business page does a full table scan.

### Stage 2: 100 to 1K Users

**Goal:** keep p99 search under 500 ms on a real-but-small dataset.

**Architecture:**
- Enable the **PostGIS** extension. Store location as `geography(Point, 4326)` with a GiST index. Radius queries use `ST_DWithin`.
- Add B-tree indexes on `business.category`, `review.business_id`, and a unique `(business_id, user_id)` on `review`.
- Add a Postgres read replica; send search reads there.
- Introduce a small Redis for simple response caching on the business detail page (TTL 60 s).

**What you skip:** Elasticsearch, full text search beyond ILIKE/pg_trgm, CDC pipelines, tile precomputation, service decomposition.

**Failure mode:** as the data set grows and users start typing partial names, search becomes a mix of geo + text + filter. PostGIS is great at geo, weaker at combined relevance ranking, and read replicas saturate on the hot metros.

### Stage 3: 1K to 100K Users

**Goal:** support filtered search (category, name substring, rating, open now) at low latency, and start protecting the write path.

**Architecture:**
- Split the monolith into **Search**, **Business**, **Review**, and **Photo** services behind an API gateway.
- Introduce **Elasticsearch**. Each business document contains a `geo_point`, category tags, denormalized `avg_rating`/`review_count`, hours, and text fields. Queries use `bool { must: match, filter: geo_distance + terms + range }`.
- Introduce **Debezium** on the Postgres WAL, publishing to **Kafka**. Consumers project into Elasticsearch and maintain Redis caches.
- Maintain incremental `sum_stars` and `review_count` columns on Business; compute `avg_rating` on read. Aggregation update runs in the same transaction as review insert to keep it simple.
- Redis now caches search responses keyed by `(geohash6, category, sort)` with short TTLs.

**What you skip:** tile precomputation, regional sharding, cross-region replication, advanced ranking.

**Failure mode:** hot cities (NYC, SF) dominate traffic. A single Elasticsearch cluster sized for average load melts during lunch/dinner rushes in those cities, and cache miss storms after invalidation are painful.

### Stage 4: 100K to 10M Users

**Goal:** absorb hot-city spikes, stabilize write throughput, and ensure a new review shows up within seconds.

**Architecture:**
- **Tile-based precomputation**: a batch job plus a streaming top-up job maintain per-geohash-cell top business lists per category in Redis. Most searches become "cover the radius with tiles, union, filter, done" without hitting Elasticsearch.
- **Request coalescing** (single-flight) in the search service to prevent thundering herds when a popular tile expires.
- **Async review aggregation**: move from in-transaction aggregate updates to a Kafka consumer that updates `sum_stars`/`review_count` and republishes to Elasticsearch. This removes lock contention on heavily-reviewed businesses.
- **Write-behind indexing** with bounded lag SLOs; clients reading their own write get an in-memory "optimistic" overlay for a few seconds.
- **Sharded Postgres** for reviews by `business_id`; businesses themselves stay on a single cluster with read replicas since 10M rows is small.
- **Multi-AZ** for everything; Elasticsearch with replica shards sized for hot-city load.

**What you skip:** full regional sharding, independent stacks per continent.

**Failure mode:** cross-ocean latency becomes the ceiling. A user in Tokyo pays 150 ms of RTT to hit a US-East cluster before any work happens. Regulatory and data-gravity pressure to keep EU data in the EU starts mattering.

### Stage 5: 10M+ Users

**Goal:** global low-latency, regional isolation, and graceful degradation.

**Architecture:**
- **Regional sharding by metro/continent**. Businesses are geographically static, so shard by a coarse geographic key (e.g., continent + country + metro bucket). Each region owns its slice of businesses and reviews end-to-end: Postgres, Elasticsearch, Redis, workers.
- **Geo-DNS / anycast routing** sends users to their nearest region. Cross-region searches (rare: "restaurants near this address I'm about to travel to") are handled by a thin cross-region federation layer that scatter-gathers across regions.
- **Global business directory** (small, slowly changing) is replicated to every region so name-only searches can hit locally. Reviews are regional and not replicated globally.
- **CDN-fronted precomputed tiles** for logged-out, generic queries. A search like "coffee near Times Square" may never reach your origin.
- **Tiered storage for reviews**: hot reviews (recent, most helpful) live in Postgres + Elasticsearch; cold reviews (multi-year-old, low-signal) migrate to a cheaper store and are lazily loaded.
- **Chaos testing** for the failure modes that now matter: region failover, Kafka lag spikes, Elasticsearch shard loss.

**What you skip:** nothing meaningful at this scale; the work becomes operational (SLOs, cost, spam/fraud, ranking quality) rather than architectural.

**Failure mode:** not a stage boundary anymore - the system now degrades gracefully under load (serving slightly stale tiles, falling back to PostGIS when Elasticsearch is unhealthy) rather than collapsing.

---

## Expected Depth by Level

| Area | Mid-Level | Senior | Staff+ |
| --- | --- | --- | --- |
| **Requirements** | Lists the three core functional requirements and basic NFRs. | Explicitly scopes out admin, map UI, recommendations; justifies eventual consistency. | Negotiates requirements; challenges the 500 ms budget and 100M DAU target with back-of-envelope math and questions the read/write ratio assumptions. |
| **API** | Defines CRUD endpoints with correct verbs and auth. | Uses cursor pagination, presigned S3 uploads, unique review constraint; returns denormalized fields to avoid fan-out. | Discusses idempotency keys for review posts, backward-compatible API evolution, rate limiting and abuse surface. |
| **Data model** | Normalized Business/Review/User; stores lat/lng. | Adds composite unique `(business_id, user_id)`, denormalized `avg_rating`/`review_count`, PostGIS `geography` column. | Argues about `sum_stars` vs floating average, cold/hot review tiering, shard keys, and CDC contract with downstream consumers. |
| **Geospatial search** | Knows the bounding-box + Haversine approach. | Picks PostGIS with GiST; understands geohash as a cache key; knows why Elasticsearch helps for combined filters. | Compares geohash vs quadtree vs R-tree; handles 180th meridian, pole, and dense-city edge cases; designs tile precomputation. |
| **Caching** | Adds a Redis in front of the DB with a TTL. | Caches by geohash key, sizes TTLs around staleness tolerance, invalidates on writes. | Designs multi-tier caching (CDN + Redis + tiles), single-flight for thundering herds, region-aware cache layout. |
| **Review aggregation** | Computes average on the fly or stores average in the row. | Maintains `sum_stars`/`count` incrementally in the write transaction. | Moves aggregation off the write path via Kafka; reasons about ordering, exactly-once via idempotent upserts, reprocessing. |
| **Photos** | Mentions S3. | Uses presigned URLs end-to-end with a two-phase PENDING/READY state machine. | Adds event-driven post-processing (thumbnails, moderation), orphan reaping, signed CDN URLs, and abuse mitigation. |
| **Scaling** | Read replicas and a cache. | Splits into services, introduces Elasticsearch and CDC, shards reviews by `business_id`. | Regional sharding by metro, cross-region federation for travel queries, global directory replication, degradation modes, cost modeling. |
| **Failure modes** | Mentions availability. | Identifies hot-key, cache stampede, and DB write contention. | Articulates SLOs per path, designs graceful fallback (Elasticsearch down -> PostGIS), and plans for chaos/load testing. |
