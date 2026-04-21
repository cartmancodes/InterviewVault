# Design Bitly (URL Shortener)

> **Pattern**: Read-Heavy / Hash-based Lookup
> **Difficulty**: Easy
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/bitly)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Short Code Generation](#1-short-code-generation)
   - [2. Collision Handling](#2-collision-handling)
   - [3. Scaling Reads to 600k QPS](#3-scaling-reads-to-600k-qps)
   - [4. Edge / CDN-based Redirects](#4-edge--cdn-based-redirects)
   - [5. Counter Coordination & Batching](#5-counter-coordination--batching)
   - [6. Custom Aliases and Expirations](#6-custom-aliases-and-expirations)
   - [7. Multi-Region Deployment](#7-multi-region-deployment)
6. [Scaling Journey: 0 to infinity](#scaling-journey-0--)
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Bitly converts long URLs into compact short codes that redirect back to the originals. The core challenge is not functional complexity but operating a tiny lookup table under an extreme read-heavy load (roughly 1000 reads per write) with sub-100ms redirect latency and guaranteed short-code uniqueness.

### Functional Requirements

**In scope:**
1. A user can submit a long URL and receive a shortened URL.
2. A user can optionally specify a custom alias (e.g., `short.ly/my-team`).
3. A user can optionally specify an expiration date after which the short link stops working.
4. Anyone visiting a short URL is redirected to the original long URL.

**Out of scope:**
1. User authentication and account management.
2. Analytics (click counts, geo breakdown, referrer tracking).
3. Link editing after creation.
4. Abuse / spam / malware scanning.

### Non-Functional Requirements

1. **Scale:** 1B total shortened URLs stored; 100M daily active users.
2. **Traffic:** ~500M redirects/day (~5.8k RPS average, ~600k RPS at 100x peak); ~100k new shortens/day (~1 write/sec).
3. **Read:Write ratio:** ~1000:1 — the dominant design pressure.
4. **Latency:** redirects resolved in <100ms end-to-end.
5. **Availability:** 99.99%, with reads prioritized over writes (a broken redirect hurts more than a delayed create).
6. **Uniqueness:** every short code maps to exactly one long URL; collisions are never observed by users.
7. **Storage footprint:** ~500 bytes/row x 1B rows = ~500GB — small enough to fit on a single node if needed.

---

## Core Entities

| Entity | Fields | Notes |
|---|---|---|
| **URLMapping** | `short_code` (PK, ~8 bytes), `long_url` (~100 bytes), `custom_alias` (nullable), `expiration_date` (nullable), `created_at`, `creator_id` (nullable), `is_custom` (bool), `url_hash` (SHA-256 truncated, indexed) | Row ~500 bytes with metadata/overhead. `url_hash` enables deduplication without scanning variable-length URL strings. |
| **Counter** | `value` (int64) | Single logical counter (Redis) feeding short code generation; can be sharded into per-region ranges. |
| **User** *(out of scope here)* | `id`, `email` | Only referenced via `creator_id` if present. |

---

## API Design

```http
# Create a short URL
POST /urls
Content-Type: application/json
{
  "long_url": "https://example.com/some/very/long/path?x=1",
  "custom_alias": "my-team",          // optional
  "expiration_date": "2026-12-31T00:00:00Z"  // optional
}

200 OK
{
  "short_url": "https://short.ly/abc123"
}

# Resolve a short URL (the hot path)
GET /{short_code}

302 Found
Location: https://example.com/some/very/long/path?x=1

# Expired link
410 Gone
```

**Why 302 over 301:** 301 is a permanent redirect — browsers cache it indefinitely with no expiry header, so once a user's browser sees the 301, every future click goes directly to the destination without touching your server. You permanently lose analytics, cannot change the target, and cannot invalidate it short of the user clearing their browser cache. 302 is a temporary redirect that is not browser-cached, so every click travels through your server: trackable, changeable, revocable. For a link-management platform, the control 302 provides is non-negotiable. Use 301 only if you are permanently retiring a link and have consciously decided to trade analytics for reduced origin load.

---

## High-Level Design

```
                   WRITE PATH (~1 QPS)
 Client --POST /urls--> API Gateway --> Write Service
                                           |
                                           +--> Redis counter (INCR / batch)
                                           +--> DB insert (UNIQUE on short_code)
                                           +--> warm cache (optional)

                    READ PATH (~600k QPS peak)
 Client --GET /{code}--> CDN/Edge --> API Gateway --> Read Service
                                                        |
                                                        +--> Redis cache (L1)
                                                        |       hit -> 302
                                                        +--> DB lookup (B-tree on short_code)
                                                                miss -> fill cache -> 302
```

**Writes** are rare and can do extra work: generate a short code (counter INCR or hash), persist with a UNIQUE constraint as the final correctness guarantee, and optionally pre-populate the cache. **Reads** must be cheap — ideally a single memory lookup before returning 302. The two sides are scaled independently (different service fleets) because their QPS profiles differ by three orders of magnitude.

---

## Deep Dives

### 1. Short Code Generation

**Problem:** Map arbitrary long URLs to a short, unique, ~6-8 character code without collisions and with minimal coordination.

**Solution:** Three candidates, evaluated in order.

- **Naive prefix of long URL** — broken; `example.com/a` and `example.com/b` collide immediately.
- **Hash + Base62 truncation:** Canonicalize the URL, SHA-256 it, Base62-encode, take the first 8 characters. Base62 uses `[a-zA-Z0-9]` (URL-safe, unlike Base64 which introduces `+` and `/` that require percent-encoding in URLs). `62^8 ≈ 218 trillion` codes. Deterministic: the same URL always maps to the same code, which provides natural deduplication. The cost is that truncating a 256-bit hash to 8 characters reintroduces birthday-collision risk, so writes still need a UNIQUE constraint and retry-with-salt on conflict.
- **Monotonic counter + Base62 (preferred):** Redis `INCR` returns a globally unique integer, Base62-encoded into a 6-7 char code. `62^6 ≈ 56B`, `62^7 ≈ 3.5T` — sufficient for 1B stored URLs with four orders of magnitude of headroom. Single atomic op, no collisions by construction, codes stay short because they grow as `log_62(n)`. At 1B URLs the code is only 6 characters; you don't need 8 yet.

**Tradeoff — sequential enumeration:** the counter approach makes codes guessable in sequence, which enables crawlers to scrape all links. Mitigate by XOR-ing the counter value with a 64-bit secret before Base62 encoding. XOR is bijective so uniqueness is preserved, but adjacent counter values map to visually random codes. Never rely on obscurity as a security layer — use access controls for truly private links — but XOR defeats casual enumeration.

**Tradeoff — deduplication:** hashing gives free deduplication (same URL, same code). Counter-based schemes don't deduplicate by default. If deduplication matters, store a `url_hash` column (SHA-256 of the canonicalized URL, truncated to 32 bytes), put a UNIQUE index on it, and check for existing rows on write. This costs one read per write, which is acceptable since writes are ~1 QPS.

### 2. Collision Handling

**Problem:** When using hashing, truncating SHA-256 to 8 chars is not bijective — two different URLs can produce the same 8-character prefix. The counter scheme avoids this entirely, but if you choose hashing you need a collision-handling path.

**Solution:** The DB's `UNIQUE` constraint on `short_code` is the source of truth regardless of generation strategy. On an insert conflict due to a hash collision, the write service appends a small per-URL nonce (start at 0, increment on each conflict) to the input before re-hashing, and retries. The birthday-paradox math keeps collision rates negligible: `62^8 ≈ 218T` codes, so at 1B stored URLs the probability that any given new URL collides is `1B / 218T ≈ 0.00046%`. After 3-5 retries the odds of consecutive collisions are astronomically small (roughly `(0.00046%)^5`); a hard failure surfaced to the client at that point is acceptable.

**Common interview mistake:** performing a read-before-write on every insert to check if the code exists before inserting. This adds a DB round-trip to every write and creates a TOCTOU race. The correct pattern is optimistic insert: generate, attempt insert, catch the unique constraint violation, regenerate, retry. Let the database enforce uniqueness — it is doing that work anyway via the index.

### 3. Scaling Reads to 600k QPS

**Problem:** 100M DAU x ~5 redirects = 500M/day average ≈ 5.8k RPS; at 100x peak that's ~600k RPS. A single SSD-backed database instance tops out around 50-100k IOPS under a realistic mixed workload — it cannot serve peak traffic directly.

**Solution:** A layered read path.

1. **B-tree index on `short_code`** (free if it's the PK) — O(log n) lookup; at 1B rows this is ~30 comparisons even before any caching. Required baseline; costs nothing beyond making `short_code` the primary key.
2. **In-memory cache (Redis / Memcached)** in front of the DB. Memory access is ~100ns vs ~100µs for an SSD read (roughly 1,000x difference), and a single Redis 7.x node sustains 100k-300k ops/sec on commodity hardware. The key insight is traffic distribution: URL access follows a heavy-tailed Zipfian distribution where the top 1% of links receive ~80% of clicks. A hot-set cache of even a few million entries achieves 95%+ hit rates in practice, which drops DB QPS from 600k to ~30k — well within comfortable range for a replicated Postgres cluster.
3. **Eviction and TTL:** Use LRU eviction. The cache TTL must be set to `min(cache_default_ttl, url.expiration_date - now)` so that an expired URL cannot be served from a stale cache entry. A fixed 24-hour TTL with no expiration awareness is a correctness bug.
4. **Read replicas:** DB read replicas absorb the residual cache-miss traffic. Write traffic (creating short codes) goes to the primary. With a 95% cache hit rate, each replica only needs to handle ~30k QPS / number-of-replicas.
5. **Cache stampede protection:** if a hugely popular link's cache entry expires, thousands of concurrent requests simultaneously miss and all hit the DB. Mitigate with probabilistic early expiration (refresh the cache entry slightly before it expires based on a stochastic check) or a mutex/lock-on-miss pattern where only one request fetches from DB while others wait.

### 4. Edge / CDN-based Redirects

**Problem:** Even a perfectly cached origin has a WAN round-trip per click for users distant from the origin region. A user in Singapore hitting a US-east origin faces ~180ms of network latency alone, which blows the <100ms target before any application logic runs.

**Solution:** Serve the short-link domain through a CDN and push redirect logic to the edge (Cloudflare Workers, Lambda@Edge, Fastly Compute@Edge). The edge node caches the `short_code -> long_url` mapping and returns the 302 without ever reaching the origin. Practical considerations:

- **Edge TTL vs. analytics:** every hit served from edge cache is a hit the origin never sees, so click counts will be undercounted if analytics depend on origin-side logging. Production systems solve this by having the edge node emit an analytics event to a logging endpoint (fire-and-forget) even while returning the cached 302.
- **Invalidation:** when a URL is deleted, updated, or expires, the edge cache entry must be purged. CDN purge APIs (Cloudflare Cache Purge, CloudFront invalidation) propagate globally in seconds but are not instantaneous. Use short edge TTLs (30-300 seconds) plus explicit purge calls on mutations to bound the staleness window. There is an inherent tradeoff: shorter TTLs reduce stale-serve window but increase origin traffic.
- **Cost model:** CDN serving costs a fraction of origin compute costs at scale; for a global product with hundreds of millions of redirects per day, the edge approach pays for itself rapidly.
- **Verdict:** worth implementing for a global product; genuine over-engineering if traffic is regionally concentrated.

### 5. Counter Coordination & Batching

**Problem:** If every write-service instance makes a network call to Redis for each short code, Redis becomes both the performance bottleneck and a single point of failure. At 1 write/sec this is trivial, but the write service should be designed to scale to higher write rates without re-architecting.

**Solution:** Each write-service pod reserves a batch of IDs from Redis with a single `INCRBY 1000`, then allocates locally from that reserved range until exhausted, then fetches the next batch. Network round-trips to Redis drop by 1000x. If a pod crashes mid-batch, the unused IDs in that range are abandoned — they become gaps in the sequence, not collisions. This is safe because the `62^7` space is effectively unbounded for practical purposes; wasting a few IDs on crashes is inconsequential.

**Redis high availability:** run Redis with Sentinel (primary + 2 replicas + 3 sentinels) or Redis Cluster. On a primary failover, a brief window exists where two pods might receive overlapping batches from the old primary's state vs. the newly promoted replica. The DB's `UNIQUE` constraint catches any duplicates that result — the counter is a performance optimization, not the correctness guarantee.

**Alternative: Twitter Snowflake-style IDs.** Compose a 64-bit ID from: timestamp (41 bits, ~69 years of range), machine/datacenter ID (10 bits, 1024 nodes), sequence number (12 bits, 4096 IDs/ms/node). No coordination needed; every node generates globally unique IDs independently. The tradeoff: IDs embed a timestamp, which leaks creation time unless you XOR-obfuscate before Base62 encoding.

### 6. Custom Aliases and Expirations

**Problem:** Custom aliases can collide with generated codes and with each other; expirations need to be enforced without triggering expensive scheduled deletes on the hot write path.

**Solution for custom aliases:** Custom aliases write into the same `url_mapping` table with the same `UNIQUE` constraint on `short_code` — same correctness guarantee, different code path. Key implementation details:

- Store a boolean `is_custom` flag on each row to distinguish generated codes from user-chosen ones.
- Generated codes are short (6-7 chars); custom aliases are typically longer (a user types "my-team", "sale2024", etc.). This natural length separation reduces namespace collisions, but is not a hard rule — enforce at the API layer that custom aliases meet a minimum length or character pattern.
- If the alias is already taken, return `409 Conflict` immediately; do not silently remap.
- Rate-limit and authenticate custom alias creation separately from regular shortening, since they are a prime target for namespace squatting.

**Solution for expirations:** Never delete expired rows eagerly on the write path. Instead, store `expires_at` in the row and check it at read time: if `expires_at IS NOT NULL AND expires_at < now()`, return `410 Gone` and evict the entry from cache. This moves the cost from a latency-sensitive write operation to the read path where it is a cheap timestamp comparison. A background job (a cron or scheduled worker) runs periodically — every few hours, or nightly during low-traffic windows — and hard-deletes rows where `expires_at < now() - grace_period`. The grace period (e.g., 7 days) prevents races between the background delete and edge caches still serving the entry.

### 7. Multi-Region Deployment

**Problem:** A single global Redis counter forces every write to cross regions (adding 100-200ms latency per write for distant regions), and a single primary DB cannot serve global reads at low latency. Active-passive failover gives durability but not low-latency reads.

**Solution:** Partition the counter space by region at provisioning time — e.g., `us-east: [0, 1B)`, `eu-west: [1B, 2B)`, `ap-south: [2B, 3B)`. Each range is large enough to never exhaust in practice, and the regions never coordinate on writes. Writes are routed to the user's home region; each region runs its own Redis counter and Postgres primary. Cross-region replication (Postgres streaming replication or logical replication to regional read replicas) stitches the global mapping table together asynchronously, with typical replication lag of <1 second on a well-tuned setup.

**Read routing:** reads go to the nearest regional cache first, then the nearest read replica. For a code generated in us-east, a user in eu-west may hit a replication-lag window of a few hundred milliseconds after creation — the code doesn't exist in eu-west's replica yet. Mitigate by: (a) accepting the tiny window (most links are shared minutes to hours after creation, not milliseconds), or (b) doing a cross-region fallback read to the code's origin region on cache/replica miss.

**Consistency model:** this is eventually consistent for newly created codes (seconds-level lag) and strongly consistent for reads served from the origin region. The product implication is that a user who creates a link and immediately shares it might observe a brief period where recipients in other regions see a 404 — acknowledge this tradeoff explicitly in an interview.

---

## Scaling Journey: 0 → ∞

### Stage 1: 0-100 Users (MVP)

**Goal:** prove the redirect loop works; get shareable links into real conversations.

**Architecture:** Single server (Node/Go/Python) + Postgres on the same box. Short codes generated by a Postgres `BIGSERIAL` column, Base62-encoded in the app. One table: `urls(short_code PK, long_url, created_at)`. No cache, no CDN, no replicas.

**What you skip:** Redis, custom aliases, expirations, auth, analytics, multi-region — none justify their operational cost yet.

**Failure mode that pushes to Stage 2:** your first viral link hits 500 RPS and Postgres' OS page cache isn't enough — connection pool saturates, p99 latency blows past 100ms, some redirects fail. You need an explicit hot-path cache.

### Stage 2: 100-1,000 Users (Early Growth)

**Goal:** decouple the hot read path from the DB; stop coupling write traffic to read traffic.

**Architecture:** Put a Redis cache (single instance) in front of the DB. Reads consult Redis first, fall back to Postgres on miss, populate on miss. Still one app server, but add a read replica to Postgres so analytics / admin queries don't fight the hot path. Move static assets (the shorten form) to a CDN.

**What you skip:** sharding, multi-region, edge compute, counter-based ID generation. `BIGSERIAL` is still fine because writes are single-digit QPS.

**Failure mode that pushes to Stage 3:** the app server itself becomes the bottleneck — single process can't push 10k+ RPS through Redis, and a deploy drops all traffic. You need horizontal scale on the service tier.

### Stage 3: 1K-100K Users (Product-Market Fit)

**Goal:** make the system horizontally scalable and survive a single-node failure.

**Architecture:**
- Split into **Read Service** and **Write Service** behind a load balancer. Reads scale to N replicas; writes stay at 2-3 for HA.
- Replace `BIGSERIAL` with a **Redis counter + batched INCR** so any write pod can mint IDs without DB coordination.
- Postgres primary + 2+ read replicas. Replicas serve cache misses.
- Redis becomes a small cluster (primary + replica via Sentinel) for HA.
- Add **custom aliases** and **expirations** (product catching up with scale).

**What you skip:** CDN edge compute, geo-distribution, sharding the DB. Storage is still <100GB; a single primary is fine.

**Failure mode that pushes to Stage 4:** traffic becomes geographically global. EU and APAC users see 200-400ms redirects because every click crosses the Atlantic to hit the US-east Redis cache. Also, peak RPS starts brushing what a single Redis node can handle reliably.

### Stage 4: 100K-10M Users (Scale-Out)

**Goal:** serve global traffic with sub-100ms redirects and eliminate any single-region bottleneck.

**Architecture:**
- **CDN / edge redirects:** short-link domain fronted by Cloudflare / CloudFront. A Worker at the edge serves the 302 straight from edge cache for the hot set. Origin only sees misses and invalidations.
- **Multi-region origin:** active-active regions (us-east, eu-west, ap-south). Each region has its own Redis cache and DB replica. Writes go to the user's home region.
- **Partitioned counter space:** each region gets a disjoint ID range so writes don't coordinate cross-region.
- **Async replication** of the URL mapping table between regions. The cache layer hides the replication lag window.
- **Dedicated TTL/expiration worker** scans and evicts.

**What you skip:** sharding the DB by `short_code` is tempting but still unnecessary — 500GB fits. Hold off until row count pushes storage or index-maintenance cost.

**Failure mode that pushes to Stage 5:** total corpus crosses 10B URLs; the B-tree index no longer fits in memory on any single replica, p99 DB latency on cache miss degrades, and a single region handles enough traffic that one Redis node is saturated.

### Stage 5: 10M+ Users (Hyperscale)

**Goal:** push read latency toward single-digit ms at the edge, and keep origin cost sublinear in traffic.

**Architecture:**
- **Shard the URL table** by hash(`short_code`) across N shards per region. Every short code is deterministically routable without a lookup service.
- **Redis Cluster** (not just Sentinel) per region, sharded by the same key so cache and DB shards line up — no hot keys from skewed routing.
- **Tiered caching:** edge -> regional Redis -> per-shard in-memory caches on the read service. Hot-link working set pinned at the edge.
- **Abuse & bot defense at the edge:** the vast majority of "traffic" at this scale is crawlers and scanners; rate-limit and bot-challenge before work hits origin.
- **Cold storage tier:** move URLs with no clicks in N months to object storage (S3) with a small index pointer; they remain resolvable but not in the hot path.
- **Operational tooling:** chaos drills on regional failover, counter-range exhaustion runbooks, cross-region consistency dashboards.

Beyond this point, scaling is mostly operational and cost engineering rather than new architecture: negotiate CDN contracts, optimize Base62 codes for the corpus, and trim storage per row.

---

## Insider Tips and Tricks

### 301 vs 302 Redirect Has Massive Caching Implications

301 is a permanent redirect. Browsers cache it indefinitely — there is no expiry header semantics that constrains it, and clearing it requires the user to manually purge their browser cache. Once a user's browser has seen the 301, every future click goes directly to the destination without ever reaching your servers. You permanently lose: click analytics, the ability to change the destination URL, and the ability to invalidate the link. 302 is temporary and is not browser-cached, so every click routes through your server: trackable, updatable, and revocable. Bitly uses 302 for exactly this reason. The only legitimate reason to use 301 in a URL shortener is if you are permanently retiring a domain and consciously accepting the loss of all future analytics for reduced origin load — a decision almost no link-management product should make.

### Base62 vs Base58 vs NanoID

Base62 uses characters `[0-9a-zA-Z]` and is the standard choice for URL shorteners. The full set gives `62^n` combinations per n characters — 56 billion at 6 chars, 3.5 trillion at 7. The tradeoff is that it contains visually ambiguous characters: `0` vs `O`, `1` vs `l`. Base58 removes these four characters (used by Bitcoin addresses and IPFS CIDs) to make codes safer to transcribe by hand. For URL shorteners this distinction is irrelevant because codes are copy-pasted or clicked, never hand-typed — use Base62 for the larger code space. NanoID is a modern alternative that uses a cryptographically secure PRNG (CSPRNG) instead of a sequential counter, produces URL-safe codes, and has a well-audited implementation in most languages. Prefer NanoID over rolling your own Base62 encode when the generation strategy is hash-based or random rather than counter-based, particularly if short codes must be unpredictable for security reasons (e.g., one-time use links, private sharing links).

### Hash Collision Is Not Your Hot-Path Problem

A common interview mistake is proposing a read-before-write on every insert to check whether a generated code already exists. This adds a DB round-trip to every write and creates a time-of-check/time-of-use race condition. At 7 characters of Base62, the code space is `62^7 = 3,521,614,606,208` (~3.5 trillion). At 1 billion stored URLs, the birthday-paradox collision probability for any single new insertion is approximately `1B / 3.5T ≈ 0.000028%`, or about one collision per 3.5 million insertions. The correct approach is optimistic concurrency: generate the code, attempt the insert, catch the unique constraint violation from the database, regenerate with a nonce or salt, and retry. This handles collisions lazily with zero overhead on the 99.999972% of writes that don't collide. The database enforces uniqueness atomically through the index — a read before the write adds cost without adding correctness.

### ID Generation Is the Hidden Single Point of Failure

If short code generation relies on a single centralized counter — a Postgres sequence, a single Redis INCR node, or a single auto-increment column — that node is your single point of failure for all write traffic. Solutions in order of coordination cost:

- **Pre-allocated ID ranges:** each app server fetches a batch of IDs from a central counter (`INCRBY 1000`) and allocates locally until exhausted. Redis failover may duplicate a small batch range, but the DB unique constraint catches it. Low coordination cost, minor waste on pod restart.
- **Partitioned counter ranges per region:** assign non-overlapping ranges to each region at provisioning time. Zero runtime coordination. Wastes range space but eliminates cross-region writes entirely.
- **Twitter Snowflake / ULID:** compose IDs from timestamp + node ID + per-node sequence. Zero coordination; each node generates globally unique IDs. Codes embed creation time (leaks ordering unless obfuscated).
- **UUID + Base62 encode:** generate a v4 UUID (128 bits of randomness), Base62-encode it to ~22 characters. No coordination, no collision risk in practice, but codes are longer than desirable for a URL shortener.

Identify which of these applies to your design and name the SPOF explicitly — interviewers at senior+ levels expect you to call it out proactively.

### The Read:Write Ratio for URL Shorteners Is ~1000:1

A popular short URL shared in a viral social media post can receive millions of redirects within hours of a single share event. The write rate for creating new short codes is comparatively tiny — 100k new shortens per day is ~1 write/sec. This asymmetry is the central design constraint of the entire system: the read path (GET `/:code` → 302) must be aggressively optimized for throughput and latency, while the write path (POST `/shorten`) can tolerate hundreds of milliseconds of additional latency without user impact. Every architectural decision — caching, read replicas, CDN edge nodes, read/write service split — flows directly from this ratio. State it explicitly in the first two minutes of a system design interview and use it to justify every subsequent decision.

### Custom Aliases Are a Different Code Path

Custom aliases (where the user chooses the slug: `short.ly/my-product-launch`) bypass the ID generation system entirely and require their own handling. The full code path for a custom alias is: (1) validate the alias meets length and character requirements at the API layer, (2) attempt insert into `url_mapping` with the user-supplied value as `short_code`, (3) on unique constraint violation return `409 Conflict` — the alias is taken. Store an `is_custom` boolean flag on each row to distinguish generated codes from custom ones; this is useful for analytics, abuse detection, and cold-storage tiering decisions. The namespace overlap risk is real: if your generator produces 6-character codes starting from counter value 0, a user registering a 6-character custom alias like `abc123` could collide with a future generated code. Mitigate by enforcing a minimum length on custom aliases that exceeds the current maximum generated code length, or by reserving a separate character prefix for custom aliases.

### URL Expiration Is a Read-Time Check, Not a Delete

A natural but wrong instinct is to delete expired URLs from the database eagerly — either immediately at the expiration timestamp or via a cron job that runs frequently. Eager deletion is expensive: at scale it means constant DELETE operations that compete with reads on the hot path, fragment the B-tree index, and potentially trigger cascading cache invalidations. The correct pattern is lazy expiration: store `expires_at` on the row, leave the row in place, and check `expires_at < now()` at read time. If expired, return `410 Gone` and evict the cache entry. A background job runs periodically during off-peak hours to hard-delete rows past their expiration plus a grace period (e.g., 7 days to allow edge caches to drain and to handle timezone edge cases). This decouples expiration enforcement (latency-sensitive, happens on every read) from garbage collection (throughput-oriented, runs asynchronously). The same pattern applies to soft-deleted URLs.

### Analytics Are Eventually Consistent by Design

If you increment a click counter in Postgres synchronously on every redirect, you immediately transform your 600k RPS read-heavy workload into a 600k RPS write-heavy workload — the exact opposite of what the system is designed for. Production analytics pipelines decouple click recording from click serving entirely. The read service returns the 302 immediately, then asynchronously enqueues a click event to a streaming log (Kafka, Kinesis, or a write-ahead log). A separate analytics consumer reads the stream and aggregates counts into a time-series store (ClickHouse, Druid, or even Postgres with batched UPDATEs). The dashboard shows eventually-consistent counts that may lag real-time by seconds to minutes. The user-visible impact is minimal; the system-level impact is enormous. Acknowledge this tradeoff explicitly — stating "I would emit a Kafka event and aggregate asynchronously" signals that you understand the write-amplification problem that synchronous analytics would create.

### The Vanity URL Attack Surface

Without rate limiting on the POST `/shorten` endpoint, several attacks become trivial: (1) namespace exhaustion — an attacker registers all desirable short custom aliases (brand names, dictionary words, common phrases) before legitimate users; (2) code enumeration — an attacker generates thousands of short codes and uses the create-API response to map the code space; (3) phishing infrastructure — an attacker creates thousands of short codes pointing to phishing pages using free anonymous access. Defenses: rate-limit POST `/shorten` by IP (e.g., 10 creates/minute for anonymous users), require authentication for custom alias creation, enforce a CAPTCHA or proof-of-work for high-volume anonymous shortening, and block creation of aliases that match known brand names or reserved words. At Bitly's scale, abuse prevention is a significant engineering surface area — acknowledge it even if it is formally out of scope.

### Why You Don't Store the Full URL as the Primary Key

Deduplication by using the destination URL as a primary key — so that two requests to shorten the same URL return the same short code — seems elegant but is operationally dangerous. URLs can legally be up to 2,083 characters (Internet Explorer's historical limit) or longer in practice; some tracking URLs with deeply nested parameters run to 8,000+ characters. A 2,000-character primary key creates: an enormous B-tree index where each entry is kilobytes rather than bytes, slow index scans and comparisons, large storage overhead, and performance problems in replication and backup tooling that serializes key values. The correct approach for deduplication is to hash the canonicalized destination URL (SHA-256 truncated to 32 bytes) and store that hash in a separate indexed column (`url_hash`). Look up by `url_hash` to find existing codes; keep `short_code` as the primary key (8 bytes, fixed-width, fast). The hash column is small, fixed-width, and can be indexed efficiently even at billions of rows.

---

## Expected Depth by Level

| Area | Mid | Senior | Staff+ |
|---|---|---|---|
| **Requirements** | Captures shorten + redirect; asks about scale when prompted. | Proactively names read-heavy as the dominant constraint; quantifies QPS and storage. | Frames the whole design around the 1000:1 ratio from the first minute. |
| **Short code generation** | Proposes one approach (hash or counter). | Compares hash vs counter with tradeoffs; knows Base62 and why. | Brings up enumeration attacks and XOR-with-secret mitigation; discusses per-region counter ranges. |
| **Collision handling** | Mentions UNIQUE constraint when asked. | Describes retry-with-salt and why truncation reintroduces collisions. | Reasons about probabilistic bounds; picks retry count based on birthday math; avoids read-before-write anti-pattern. |
| **Read scaling** | Says "add a cache" when prompted. | Designs cache + replicas + eviction/TTL; distinguishes TTL from URL expiration. | Leads with tiered cache (edge -> regional -> DB) and Zipfian hit-rate reasoning; addresses cache stampede. |
| **Write path** | Single write service. | Read/write service split with independent scaling. | Counter batching, Redis HA, UNIQUE as final correctness net even on failover; names SPOF on counter node. |
| **Geo / CDN** | Not expected. | Mentions CDN for static; recognizes edge as an option. | Designs active-active regions with partitioned counter ranges and edge-executed redirects; discusses replication lag window. |
| **Failure modes** | Names "DB down." | Walks through cache miss storms, Redis failover, write retries. | Chaos-tests the plan: region loss, counter-range exhaustion, cache stampedes, replication lag. |
| **Product thinking** | Handles custom alias as a field. | Designs alias collision path and expiration enforcement. | Treats abuse, cold storage tiering, eventually-consistent analytics, and cost-per-click as first-class concerns. |
