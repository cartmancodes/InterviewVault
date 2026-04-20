# Design Web Crawler

> **Pattern**: Distributed Queue / BFS
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/web-crawler)

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

A web crawler starts from a set of seed URLs, fetches each page, stores the HTML, extracts text content, discovers new outbound links, and repeats the process. It is essentially a breadth-first traversal of the web graph with hard constraints on politeness, scale, and fault tolerance.

### Functional Requirements

**Must have:**
1. Accept a list of seed URLs and begin crawling from them.
2. Download page content (HTML) for each URL.
3. Extract and persist text data from each page for downstream processing (e.g., LLM training, search indexing).
4. Discover new URLs from fetched pages and enqueue them for crawling.

**Out of scope:**
- Rendering dynamic JavaScript pages (headless browsers).
- Crawling pages gated by authentication.
- Non-text assets like images, video, or PDFs.
- Search ranking, indexing for lookup, or query serving.

### Non-Functional Requirements

**Must have:**
1. **Fault tolerance** - a crashed fetcher or parser must not lose URLs or force a restart from scratch.
2. **Politeness** - respect `robots.txt`, cap request rate per domain, and avoid denial-of-service on target hosts.
3. **Efficiency / throughput** - crawl ~10B pages within 5 days.
4. **Scalability** - horizontally scale fetchers, parsers, and the URL frontier to handle the full public web.

**Assumptions:**
- Average page size: ~2 MB of HTML.
- 10B pages x 2 MB = 20 PB of raw HTML (text extract is far smaller, but still petabyte scale).
- Required steady-state throughput: 10B / (5 * 86,400) ~= 23,000 pages/sec.

---

## Core Entities

| Entity | Purpose | Typical Store |
|---|---|---|
| **URL** | The unit of work traversing the system. Carries depth, priority, discovery timestamp, and parent URL. | URL frontier queue |
| **Page** | Raw HTML fetched for a URL plus metadata (status code, headers, fetch time, content hash). | Blob storage (S3) |
| **Content Store** | Extracted text output - the product the pipeline exists to produce. | S3 / object store, partitioned by domain or crawl date |
| **Metadata DB** | Per-URL and per-domain state: last-crawled time, content hash, robots rules, failure count. | DynamoDB / Cassandra |
| **Seen Set** | Dedup structure answering "have we already enqueued or fetched this URL?" | Redis set / Bloom filter |
| **Domain Record** | Per-domain politeness state: last request time, crawl-delay from robots, cached robots rules. | Redis with TTL |

---

## API Design

A crawler is a pipeline, not a request-response service, so the "API" is really its inputs and outputs plus a small operator-facing control plane.

**Ingress (operator or upstream system):**
- `POST /crawls` with a body containing seed URLs, crawl depth limit, optional allow/deny domain lists.
- `GET /crawls/{id}` returns progress: pages fetched, queue depth, error counts.
- `POST /crawls/{id}/pause` and `/resume` for operational control.

**Egress (downstream consumers):**
- Text blobs in `s3://content-store/{crawl_id}/{domain}/{url_hash}.txt`.
- An event stream on Kafka (`crawled.pages`) emitting `{url, content_hash, s3_path, fetched_at}` so indexers can consume incrementally.

No public user-facing API - the consumers are other internal systems (ML training pipelines, search indexers).

---

## High-Level Design

```
  Seed URLs
      |
      v
+------------+      +-------------+      +----------------+
| URL        | ---> | Fetcher     | ---> | Blob Store     |
| Frontier   |      | Workers     |      | (raw HTML, S3) |
| (queue)    |      +-------------+      +----------------+
+------------+             |                    |
      ^                    v                    v
      |             +-------------+      +----------------+
      |             | DNS Cache   |      | Parser Workers |
      |             +-------------+      +----------------+
      |                                         |
      |                                         v
      |                                  +----------------+
      |                                  | Text Store (S3)|
      |                                  +----------------+
      |                                         |
      |<----------- new URLs --------------------+
      
  Side channels used by every stage:
    - Metadata DB (DynamoDB): per-URL / per-domain state
    - Redis: seen-set, domain politeness counters, robots cache
```

**Flow:**
1. Seed URLs are written to the **URL Frontier**.
2. **Fetcher workers** pop URLs, consult the **DNS cache** and **robots cache**, then issue HTTP GETs.
3. Raw HTML is written to **blob storage**; a pointer plus metadata (status, hash, fetched_at) is recorded in the **Metadata DB**.
4. **Parser workers** read the HTML, extract plain text into the **text store**, and extract outbound `<a href>` links.
5. Each discovered URL is normalized, checked against the **seen set**, and if new, pushed back into the frontier.
6. The frontier is drained over and over until it is empty or a depth/budget limit is reached.

---

## Deep Dives

### 1. URL Frontier

The frontier is more than a single FIFO queue. A naive queue fails politeness because URLs from the same domain cluster together. The canonical design is a two-level structure:

- **Front queues** bucket URLs by priority (e.g., PageRank-ish score, freshness need).
- **Back queues** are partitioned by domain - each back queue holds URLs for exactly one host, and a worker pulls at the domain's allowed rate.

A router moves URLs from front to back queues while a separate scheduler assigns back queues to fetcher threads, respecting per-domain crawl delay. This guarantees politeness without starving high-priority URLs.

Durability: the frontier must survive crashes. Use SQS, Kafka, or a Redis list with AOF persistence so that an in-flight URL is either acked after successful fetch or re-delivered after a visibility timeout.

### 2. Politeness and Rate Limiting

- Enforce a default of **1 request per second per domain**, overridden by `Crawl-Delay` in `robots.txt` if present.
- Track `last_request_time` per domain in Redis with a TTL. A fetcher checks `now - last_request_time >= crawl_delay` before issuing a request; otherwise it sleeps or yields the URL back to the frontier.
- Add **jitter** on retries to avoid synchronized thundering herds against the same host after a failure.
- Route URLs from the same domain to the same fetcher shard so politeness decisions are local (no distributed lock needed on the hot path).

### 3. Deduplication via Bloom Filter

Two kinds of dedup matter:

- **URL dedup** - "have I already enqueued this URL?" A billion-URL set at 32 bytes per URL would be 32 GB in RAM. A Bloom filter with 1% false-positive rate needs ~1.2 GB for 1B elements - dramatic savings.
- **Content dedup** - many URLs serve identical content (mirrors, session IDs, tracking params). Hash the normalized text (SHA-256 or SimHash) and dedup in the Metadata DB before writing to the text store.

Trade-off: a Bloom filter has **false positives** (skip a URL we have not actually seen) but **no false negatives**. For URL dedup this is acceptable - missing a rarely-linked URL is cheap; re-crawling a popular one is not. If precision matters, layer a secondary exact check (DynamoDB lookup) only when the Bloom filter says "maybe seen."

### 4. robots.txt and Crawler Ethics

- On first contact with a domain, fetch `https://{host}/robots.txt`.
- Parse `User-agent`, `Disallow`, `Allow`, `Crawl-Delay`, and `Sitemap` directives.
- Cache parsed rules in Redis keyed by host, with a 24-hour TTL so updates propagate.
- Every URL is checked against the domain's rules before fetch. Disallowed URLs are dropped, not retried.
- Respect `nofollow` on anchors when extracting outbound links.
- Sitemaps are a crawling shortcut - ingest them into the frontier directly to discover deep URLs that are not reachable via link graph.

### 5. Distributed Crawling

- **Fetchers** are stateless and horizontally scalable. Partition the frontier by `hash(domain) % N` so each fetcher owns a disjoint set of domains - this keeps politeness local.
- **Parsers** are also stateless and scale on queue depth. They do not need domain affinity because parsing has no politeness constraints.
- **Coordination**: the Metadata DB and Redis are the only shared state. Everything else is pull-based from queues.
- **Back-pressure**: if blob storage or the text store gets slow, parser consumers lag, SQS queue depth grows, and auto-scaling adds parsers. Fetchers do not need to slow down unless the frontier itself backs up.
- **Crawler traps**: cap traversal depth at ~15-20 hops from seed, cap URLs per domain per crawl, and detect pathological link farms by watching per-domain URL discovery rates.

### 6. Storage Layout

- **Raw HTML**: S3, path `raw/{crawl_id}/{yyyy-mm-dd}/{sha1(url)}.html.gz` - gzip compressed, immutable.
- **Text**: S3, partitioned the same way. Columnar formats (Parquet) are tempting for downstream analytics.
- **Metadata**: DynamoDB with `url_hash` as partition key and a GSI on `domain` for per-domain queries.
- **Seen set and domain counters**: Redis cluster, sharded by key hash.

---

## Scaling Journey: 0 to Infinity

Each stage builds on the previous. The goal is to understand the failure mode that forces the next step, not to design the final architecture on day one.

### Stage 1: 1K Pages/day (MVP)

**Goal**: Prove the end-to-end pipeline works. One developer, one laptop, a handful of seed URLs.

**Architecture**:
- Single Python process with an in-memory `deque` as the frontier.
- A Python `set` as the seen set.
- Synchronous `requests.get()` for fetching, `BeautifulSoup` for parsing.
- Write extracted text to local disk as flat files.
- `robots.txt` fetched and cached in a dict.

**What you skip**:
- Distributed queues, Redis, DynamoDB, S3.
- Bloom filters (a Python set is fine at this scale).
- Horizontal scaling, health checks, retries beyond a simple try/except.

**Failure mode**: At ~100K URLs the process either runs out of RAM (the seen set and frontier grow unbounded) or crashes and loses all progress because nothing is persisted. You need durable state.

### Stage 2: 100K Pages/day

**Goal**: Survive restarts and parallelize within a single machine.

**Architecture**:
- Replace the in-memory `deque` with a **Redis list** as the frontier - survives process crashes.
- Replace the Python `set` with a **Redis set** for the seen URLs.
- Run ~50 async fetcher coroutines (`aiohttp`) to overlap network IO.
- Persist crawl metadata (url, status, fetched_at) to SQLite or Postgres.
- Write raw HTML and text to S3 instead of local disk so the data survives host loss.
- Politeness enforced by a simple `last_fetched[domain]` dict in Redis with a `WAIT_UNTIL` timestamp.

**What you skip**:
- Multi-machine sharding - a single beefy VM with 16 cores and 64 GB RAM handles this easily.
- Bloom filters - the Redis set for 100K-10M URLs is still cheap.
- Kafka, domain partitioning, sophisticated scheduling.

**Failure mode**: At ~10M URLs the Redis `SET` for seen URLs balloons past 2-3 GB (at ~100-200 bytes per URL key), single-node Redis becomes a bottleneck, and one fetcher host cannot saturate outbound bandwidth. You need to shard and scale out.

### Stage 3: 10M Pages/day

**Goal**: Scale across multiple machines with durable queuing and efficient dedup.

**Architecture**:
- Frontier moves to **Kafka** (or SQS) with topic partitions keyed by `hash(domain)`. Each partition is consumed by a dedicated fetcher, guaranteeing per-domain serialization without cross-host locks.
- Seen set becomes a **RedisBloom** Bloom filter sized for ~1B URLs at 1% FPR (~1.2 GB), with exact-check fallback to DynamoDB on "maybe seen."
- Fetcher fleet: 10-20 autoscaled containers; parser fleet: another 10-20 scaling on queue lag.
- Metadata DB migrates from Postgres to **DynamoDB** or **Cassandra** to handle write volume.
- Centralized **DNS cache** layer (Unbound or a dedicated resolver pool) to avoid hammering public DNS.
- Raw HTML and extracted text still land in S3; a Kafka topic `pages.extracted` is emitted for downstream consumers.

**What you skip**:
- Multi-region crawling.
- Custom TCP tuning or specialized fetch hardware.
- Complex priority scheduling - a single priority class still works.

**Failure mode**: At 100M+ pages/day, DNS becomes a bottleneck (public resolvers rate-limit you), single-region egress bandwidth caps out at tens of Gbps, and noisy domains - link farms, CDN-proxied mirrors - start to dominate the frontier. You need domain-aware scheduling and more egress capacity.

### Stage 4: 1B Pages/day

**Goal**: Hit Google-adjacent scale with fair domain scheduling and massive parallel egress.

**Architecture**:
- **Domain-partitioned fetcher fleets**: hundreds of fetcher nodes, each owning a slice of the domain hash space. Within a node, a two-level frontier (front queues by priority, back queues by domain) enforces per-domain crawl delay.
- **Politeness quotas**: each domain gets a token bucket in Redis. Fetchers pull tokens before issuing a request. High-quality domains (news, Wikipedia) get larger quotas; link farms get throttled or skipped.
- **Recrawl scheduler**: separate service decides when to re-fetch a URL based on change frequency. Freshly-crawled pages go to a "recrawl in N days" queue; the frontier is a merge of new-discovery and recrawl streams.
- **Multiple DNS providers** behind a resolver pool - fail over between Cloudflare, Google, and a self-hosted resolver to avoid any single provider rate-limiting.
- **Tiered storage**: hot HTML in S3 Standard for 30 days, aged to Glacier for long-term archival.
- **Content SimHash** index to catch near-duplicate pages (templated mirror sites) that exact hashing misses.

**What you skip**:
- True geo-distribution (still one or two regions).
- Specialized hardware for TLS termination.
- Full machine-learning-based URL prioritization - a simple PageRank approximation is enough.

**Failure mode**: At tens of billions of pages, transoceanic latency dominates fetch time for pages on distant continents, single-region egress costs explode, and some regions block traffic from US data centers. You need crawlers physically close to the content.

### Stage 5: 10B+ Pages/day (Google-scale)

**Goal**: Continuously crawl and recrawl the full public web with regional compliance.

**Architecture**:
- **Geo-distributed crawl fleets**: independent fetcher fleets in NA, EU, APAC. Each fleet crawls domains whose authoritative DNS or CDN POPs are in its region. Regional placement cuts latency by 5-10x and reduces egress cost.
- **Global frontier coordinator** reconciles seen-sets across regions using a sharded Bloom filter replicated asynchronously - each region owns its shard, cross-region lookups happen on dedup conflicts.
- **Per-region metadata stores** (regional DynamoDB / Spanner) with cross-region replication for the parts of the URL graph shared between fleets.
- **Adaptive politeness**: ML model predicts per-domain safe crawl rate from past response latency, error rates, and 429/503 signals. Replaces the static 1-rps default.
- **Compliance layer**: per-region rules engine handles GDPR, regional takedown requests, and domain blacklists. Content flagged in EU is not necessarily removed in NA.
- **Streaming re-index pipeline**: extracted text flows through Kafka into a feature store that feeds search indexers, LLM training, and freshness-sensitive products in near-real-time.

**What you skip**: Nothing. This is the asymptote.

**Failure mode**: Not a scaling failure - more a diminishing-returns regime. Further gains come from smarter prioritization (what to crawl), not more throughput (how fast to crawl). The next frontier is quality, not quantity.

---

## Expected Depth by Level

| Level | Breadth / Depth | What the interviewer looks for | Red flags |
|---|---|---|---|
| **Mid (E4)** | 80 / 20 | Describes the pipeline: frontier -> fetcher -> parser -> store. Knows `robots.txt` exists and must be respected. Produces a rough back-of-envelope estimate. Picks a reasonable queue (SQS). | Cannot explain why duplicates happen. Forgets `robots.txt`. Uses a relational DB as the frontier. |
| **Senior (E5)** | 60 / 40 | Two-level frontier with domain back-queues. Explains Bloom filter trade-off for the seen set. Articulates politeness as both rate limit and `Crawl-Delay`. Identifies DNS as a bottleneck. Justifies blob-storage for HTML vs DB. | Hand-waves politeness. Ignores fault tolerance on fetcher crash. Picks Bloom filter without mentioning false positives. |
| **Staff+ (E6+)** | 40 / 60 | Deep mastery of 3+ areas. Designs domain-partitioned fetcher fleets with per-node back-queues. Discusses recrawl scheduling separately from discovery. Reasons about near-duplicate detection (SimHash) vs exact dedup. Addresses geo-distribution and regional compliance. Offers a concrete plan to reach 10B pages in 5 days with numerical justification. | Only describes a single-region design. Ignores recrawl. No plan for crawler traps or malicious domains. |
