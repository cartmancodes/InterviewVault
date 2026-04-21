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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

The frontier is more than a single FIFO queue. A naive queue fails politeness because URLs from the same domain cluster together and get bulk-fetched, effectively DDoSing target hosts. The canonical design is a two-level structure:

- **Front queues** bucket URLs by priority. Priority is computed from multiple signals: estimated PageRank of the source page, recency of last crawl (fresher = higher priority), link depth from seed (shallower = higher priority), and content quality heuristics. This is not pure BFS — BFS wastes budget on pagination and near-duplicate pages.
- **Back queues** are partitioned by domain — each back queue holds URLs for exactly one host, and a dedicated worker thread pulls from that queue at the domain's allowed rate.

A router moves URLs from front to back queues while a separate scheduler assigns back queues to fetcher threads, respecting per-domain crawl delay. This guarantees politeness without starving high-priority URLs.

**Durability is non-negotiable.** The frontier must survive crashes. Use SQS, Kafka, or a Redis list with AOF persistence so that an in-flight URL is either acked after successful fetch or re-delivered after a visibility timeout. At 10B URLs you cannot rebuild the frontier from scratch — treat it as a durable append-only log backed by disk-persistent storage (Kafka topic compaction or RocksDB). An in-memory frontier is a single-point-of-failure that invalidates the entire fault-tolerance goal.

**Frontier sizing:** At 10B URLs averaging ~100 bytes per URL record (URL string + metadata), the frontier itself is ~1 TB of durable storage. This rules out Redis-only approaches for large crawls — Kafka or a purpose-built disk-backed queue is required.

### 2. Politeness and Rate Limiting

Politeness is not a courtesy; it is a technical and legal requirement.

- Enforce a default of **1 request per second per domain**, overridden by `Crawl-Delay` in `robots.txt` if present.
- Track `last_request_time` and `next_fetch_time` per domain in Redis with a TTL. A fetcher checks `now >= next_fetch_time[domain]` before issuing a request; if not, it re-queues the URL with a delay rather than spinning. Sleeping in the fetcher thread wastes thread capacity — re-queue and move on.
- **Domain affinity is required for correctness.** Route URLs from the same domain to the same fetcher shard using consistent hashing on `hash(domain) % N`. If multiple fetcher shards can pull from the same domain's back-queue simultaneously, you need a distributed lock on `next_fetch_time[domain]` — an expensive hot path. Domain affinity makes politeness state local to one shard, eliminating cross-shard coordination on the critical path.
- Add **jitter** on retries (exponential backoff with ±20% jitter) to avoid synchronized thundering herds against the same host after a 429 or 503 response.
- Treat `Retry-After` headers as authoritative. A server telling you to wait 60 seconds means your `next_fetch_time[domain]` should be `now + 60s`, not `now + crawl_delay`.
- Log per-domain error rates. A domain returning >10% 5xx in a rolling window should have its crawl rate halved automatically. Persistent 4xx (404, 410) should trigger URL removal from the frontier, not retry.

### 3. Deduplication via Bloom Filter

Two distinct deduplication problems must be solved independently:

**URL dedup** ("have I already enqueued this URL?"):
- A billion-URL exact hash set at 32 bytes per URL requires 32 GB in RAM. A Bloom filter at 1% false-positive rate needs ~1.2 GB for 1B elements — a 96% reduction.
- Bloom filters have **no false negatives** (a URL we have seen is never incorrectly reported as new) but a ~1% **false positive rate** (a new URL is occasionally skipped). For a web crawler this tradeoff is entirely acceptable — missing 1% of valid URLs is unnoticeable at web scale.
- For higher confidence, layer a secondary exact check (DynamoDB lookup) only when the Bloom filter says "maybe seen." This two-tier design keeps the hot path fast (Bloom filter in Redis) while preserving correctness for important URLs.
- **URL normalization must happen before dedup.** `http://example.com/page?a=1&b=2` and `http://example.com/page?b=2&a=1` are the same page. Canonicalize by: lowercasing the scheme and host, sorting query parameters alphabetically, stripping fragment identifiers (`#section`), removing common tracking parameters (`utm_source`, `fbclid`, etc.), and resolving relative paths. Two URLs that normalize to the same canonical form count as one.

**Content dedup** ("is this page's content materially different from something I've already stored?"):
- Exact dedup (SHA-256 of full HTML) catches verbatim duplicates but misses near-duplicates: mobile vs. desktop versions, paginated versions of the same article, session-ID-parameterized pages, CDN mirrors.
- **SimHash** produces a 64-bit fingerprint where similar documents have small Hamming distances. Two documents with Hamming distance ≤ 3 are treated as near-duplicates. Store all SimHashes; a new page within distance 3 of an existing one is marked as near-duplicate and not re-indexed.
- Use a two-stage pipeline: exact hash first (cheap, handles verbatim duplicates), SimHash second (handles near-duplicates). Only novel content reaches the text store.

### 4. robots.txt and Crawler Ethics

`robots.txt` is not optional. Courts in the US (under CFAA) and EU have treated repeated violations as trespass-to-chattels or unauthorized computer access claims. Beyond legality, aggressive crawlers get entire IP ranges permanently blacklisted by major CDNs and hosts — progressively shrinking the addressable web for that crawler.

- On first contact with a domain, fetch `https://{host}/robots.txt` synchronously before any other request to that domain.
- Parse `User-agent`, `Disallow`, `Allow`, `Crawl-Delay`, and `Sitemap` directives. Your user-agent string must match the `User-agent` rules declared in robots.txt. Using a generic agent string to dodge restrictions is detectable and grounds for blacklisting.
- Cache parsed rules in Redis keyed by host, with a 24-hour TTL so updates propagate within a day.
- Every URL is checked against the domain's rules before fetch. Disallowed URLs are dropped and marked in the Metadata DB so they are not re-discovered and re-checked on every crawl cycle.
- If `robots.txt` is unreachable (503, timeout), apply conservative defaults: assume no restrictions but slow the crawl rate to 0.1 req/sec until the file is accessible. Do not assume unreachability means "crawl freely."
- Respect `nofollow` on anchors when extracting outbound links — both the link-level `rel="nofollow"` attribute and the page-level `<meta name="robots" content="nofollow">` directive.
- Sitemaps declared in `robots.txt` are a crawling shortcut — ingest `sitemap.xml` files into the frontier directly to discover deep URLs unreachable via the link graph. Sitemaps also carry `<lastmod>` timestamps useful for recrawl scheduling.

### 5. Distributed Crawling and Spider Traps

**Scaling fetchers:**
- Fetchers are stateless and horizontally scalable. Partition the frontier by `hash(domain) % N` so each fetcher owns a disjoint set of domains — this keeps politeness state local and avoids distributed locks.
- Parsers are also stateless and scale on queue depth. They do not need domain affinity because parsing has no politeness constraints.
- The Metadata DB and Redis are the only shared state. Everything else is pull-based from queues.
- Separate the frontier service from the fetcher service. These two components have completely different scaling profiles: the frontier is I/O-bound (reading/writing URL queues, dedup checks) and benefits from high storage throughput; the fetcher is network-bound (making HTTP requests, waiting for responses) and benefits from high concurrency with non-blocking I/O. Coupling them in one binary prevents independent scaling.

**Spider traps — the silent budget killers:**
Spider traps are URL spaces that expand infinitely and can consume the entire crawl budget. They exist both legitimately (calendar navigation: `?month=next` → `?month=next` from that page) and maliciously (adversarial sites designed to exhaust crawler resources).

Defenses must operate at multiple levels:
1. **Max URL depth limit**: stop crawling beyond N hops from the seed (typically 15-20). URLs at depth > N are dropped, not queued.
2. **Per-domain URL count cap**: stop after M URLs from any single domain per crawl run (e.g., 1M URLs). Emit an alert when a domain hits the cap — it signals either a trap or a legitimately large site that needs manual review.
3. **URL normalization**: collapse `?month=jan&year=2020` and `?year=2020&month=jan` to the same canonical URL before queuing. Many traps exploit parameter reordering.
4. **Per-domain discovery rate monitoring**: if a single domain is generating >10K new URLs/minute, flag it. Legitimate sites do not have infinite unique URL spaces.
5. **Path segment repetition detection**: URLs with repeated path segments (`/a/b/a/b/a/b/`) are almost always traps.

**Back-pressure:**
If blob storage or the text store slows down, parser consumers lag, queue depth grows, and auto-scaling adds parsers. Fetchers do not need to slow down unless the frontier itself backs up. Monitor queue lag metrics (not just queue depth) to distinguish "growing because we're producing fast" from "growing because downstream is slow."

### 6. DNS Resolution at Scale

DNS is one of the most commonly overlooked bottlenecks in crawler design. At 23,000 pages/second, you need 23,000 DNS lookups/second. The OS DNS resolver (`/etc/resolv.conf`) is a single-threaded blocking stub resolver — it is not built for this load.

Solutions, in order of increasing scale:
- **Application-level DNS cache**: maintain a per-process cache of `domain → IP` mappings, expiring each entry at its TTL. This eliminates repeated lookups for the same domain, which is common since many URLs share domains.
- **Dedicated async resolver library**: use `c-ares` (C library with async DNS) or language-equivalent. This allows hundreds of concurrent DNS requests per fetcher process without blocking threads.
- **Local recursive resolver**: run Unbound or BIND locally on each fetcher host. Requests are served from the local resolver's cache, bypassing public DNS for repeat lookups. TTL-compliant — the resolver respects the actual record TTL.
- **Multiple upstream DNS providers**: configure failover between Cloudflare (1.1.1.1), Google (8.8.8.8), and a self-hosted resolver. Public resolvers rate-limit aggressively at crawler-scale query rates.
- **Pre-resolution**: batch-resolve all domains in the frontier before handing URLs to fetcher workers. Domains not resolvable after 3 retries are marked unreachable in the Metadata DB and skipped.

### 7. Storage Layout

- **Raw HTML**: S3, path `raw/{crawl_id}/{yyyy-mm-dd}/{sha1(url)}.html.gz` — gzip compressed, immutable objects. Retention policy: 30 days in S3 Standard, then Glacier for archival. Raw HTML is needed for reprocessing but is not on the hot read path.
- **Text content**: S3, partitioned the same way. For downstream ML pipelines, write Parquet files partitioned by domain and crawl date to enable efficient columnar scans.
- **Metadata**: DynamoDB with `url_hash` as partition key and a GSI on `domain` for per-domain queries (e.g., "how many URLs from example.com have we crawled?"). TTL attribute on records to auto-expire low-value URL metadata.
- **Seen set and domain counters**: Redis Cluster, sharded by key hash. RedisBloom module for the Bloom filter; standard Redis hashes for per-domain `next_fetch_time` and error counts.
- **Frontier**: Kafka topics partitioned by `hash(domain) % partitions`. Topic retention sufficient to hold the full frontier depth (days, not hours). Consumer group per fetcher fleet. Key compaction for the "current state" topic (one record per URL).
- **Event stream for downstream consumers**: Kafka topic `pages.extracted` emitting `{url, content_hash, s3_path, fetched_at, domain, depth}`. Consumers (search indexers, ML pipelines) are fully decoupled from the crawl pipeline.

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

## Insider Tips and Tricks

### Ignoring robots.txt Has Legal Consequences, Not Just Reputational Ones
The Hierarchical Exemption From Compliance (HEFC) principle in robots.txt is advisory, but courts in the US and EU have treated ignoring it as a basis for trespass-to-chattels or Computer Fraud and Abuse Act claims. Beyond legality, aggressive crawling results in your IP ranges being permanently blacklisted by major sites. Respect `Crawl-delay` directives and the `Disallow` paths, or your crawler will have a shrinking addressable web.

### Crawl Budget: Every Page Visit Has a Cost
Google's concept of "crawl budget" — the number of URLs a crawler will fetch from a domain in a given period — applies to your own crawler too. Spending crawl budget on thin, duplicate, or low-value pages means high-value pages get crawled less frequently. Prioritize URLs by predicted content quality (page rank estimate, content freshness signals, link depth) in the URL frontier, not pure BFS order. BFS crawlers waste budget on pagination and near-duplicate pages.

### Bloom Filter False Positive Rate Is an Acceptable Tradeoff
A Bloom filter answers "have I seen this URL before?" with no false negatives (never misses a seen URL) but ~1% false positive rate (occasionally thinks a new URL is old). The consequence: ~1% of new, valid URLs are skipped. For a web crawler, this is entirely acceptable — the web is vast enough that missing 1% is unnoticeable. The benefit: a Bloom filter for 10B URLs uses ~10GB RAM vs hundreds of gigabytes for a hash set.

### The URL Frontier Must Be Persistent, Not In-Memory
If the URL frontier (the queue of URLs to crawl) lives in memory and the process crashes, you lose all frontier state. At 10B URLs, you cannot rebuild from scratch in reasonable time. The frontier must be backed by disk-persistent storage (RocksDB, a dedicated Kafka topic, or a database). Checkpointing progress is not optional for a large-scale crawler; treat the frontier as a durable append-only log.

### Per-Domain Politeness Is Infrastructure-Level, Not Application-Level
Rate limiting your crawler to 1 request/second per domain is not done in application code — it must be enforced in the fetcher tier. Implementation: maintain a per-domain "next fetch time" value in Redis. Before fetching, check if `now >= next_fetch_time[domain]`; if not, re-queue the URL. This requires the URL-to-fetcher assignment to be consistent (same domain always goes to the same fetcher shard) to avoid inter-shard coordination for per-domain state.

### Spider Traps Can Consume Infinite Crawl Budget
Infinite URL spaces exist legitimately (calendar navigation: `?month=next`, `?month=next` from that page, etc.) and maliciously (adversarial sites to waste crawler resources). Defenses: (1) max URL depth limit (stop crawling beyond N hops from the seed); (2) per-domain URL count cap (stop after M URLs from any single domain); (3) URL normalization (collapse `?month=jan&year=2020` and `?year=2020&month=jan` to the same canonical URL before queuing).

### DNS Resolution Is a Throughput Bottleneck at Scale
A crawler fetching 10,000 URLs/second needs 10,000 DNS lookups/second. The OS DNS resolver is not built for this. Solutions: maintain a local DNS cache keyed by domain with a TTL equal to the record's TTL; use a dedicated DNS resolver like `c-ares` (asynchronous DNS) or a local unbound/bind instance; pre-resolve all domains in the URL frontier in batch before handing them to fetchers.

### Content Deduplication via SimHash Prevents Near-Duplicate Indexing
The web has massive duplication: mobile vs desktop versions, HTTP vs HTTPS mirrors, paginated versions of the same article. Exact deduplication (hash the full content) misses near-duplicates. SimHash produces a 64-bit fingerprint where similar documents have Hamming distances < 3. Store all SimHashes in a lookup structure; when a new page's SimHash is within distance 3 of an existing one, mark it as a near-duplicate and don't index it (but do record the crawl to prevent re-crawling).

### Separate the URL Frontier Service from the Fetcher Service
These two components have completely different scaling profiles. The frontier is I/O-bound (reading/writing URL queues, dedup checks) and benefits from high storage throughput. The fetcher is network-bound (making HTTP requests, waiting for responses) and benefits from high concurrency with non-blocking I/O. Coupling them in one binary means you can't scale each independently. The frontier scales with URL volume; the fetcher scales with target site response times.

### JavaScript-Rendered Content Is Inaccessible to HTTP-Only Crawlers
About 30% of the modern web requires JavaScript execution to render meaningful content (SPAs, React/Vue apps). A simple HTTP fetcher gets raw HTML with `<div id="root"></div>` and no content. Solutions: (1) maintain a separate JavaScript rendering pool (headless Chrome via Puppeteer/Playwright) for known JS-heavy domains — expensive but necessary; (2) fetch both raw HTML and rendered HTML, use the one with more content; (3) explicitly decide your crawler won't support JS rendering and document the limitation.

---

## Expected Depth by Level

| Level | Breadth / Depth | What the interviewer looks for | Red flags |
|---|---|---|---|
| **Mid (E4)** | 80 / 20 | Describes the pipeline: frontier -> fetcher -> parser -> store. Knows `robots.txt` exists and must be respected. Produces a rough back-of-envelope estimate. Picks a reasonable queue (SQS). | Cannot explain why duplicates happen. Forgets `robots.txt`. Uses a relational DB as the frontier. |
| **Senior (E5)** | 60 / 40 | Two-level frontier with domain back-queues. Explains Bloom filter trade-off for the seen set. Articulates politeness as both rate limit and `Crawl-Delay`. Identifies DNS as a bottleneck. Justifies blob-storage for HTML vs DB. | Hand-waves politeness. Ignores fault tolerance on fetcher crash. Picks Bloom filter without mentioning false positives. |
| **Staff+ (E6+)** | 40 / 60 | Deep mastery of 3+ areas. Designs domain-partitioned fetcher fleets with per-node back-queues. Discusses recrawl scheduling separately from discovery. Reasons about near-duplicate detection (SimHash) vs exact dedup. Addresses geo-distribution and regional compliance. Offers a concrete plan to reach 10B pages in 5 days with numerical justification. | Only describes a single-region design. Ignores recrawl. No plan for crawler traps or malicious domains. |
