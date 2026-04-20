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
7. [Expected Depth by Level](#expected-depth-by-level)

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
| **URLMapping** | `short_code` (PK, ~8 bytes), `long_url` (~100 bytes), `custom_alias` (nullable), `expiration_date` (nullable), `created_at`, `creator_id` (nullable) | Row ~500 bytes with metadata/overhead. |
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

**Why 302 over 301:** 301 is cached by the browser, so the origin stops seeing hits and loses control (you cannot change the target, invalidate, or measure). 302 keeps the server in the loop at the cost of a round-trip per click — worth it for a link platform.

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
- **Hash + Base62 truncation:** Canonicalize the URL, SHA-256 it, Base62-encode, take the first 8 characters. Base62 uses `[a-zA-Z0-9]` (URL-safe — no `+` or `/` like Base64). `62^8 ≈ 218 trillion` codes. Deterministic (same URL always maps to same code) but truncation reintroduces collision risk, so writes still need a UNIQUE constraint and retry-with-salt on conflict.
- **Monotonic counter + Base62 (preferred):** Redis `INCR` returns a globally unique integer, which is Base62-encoded into a 6-7 char code. `62^6 ≈ 56B`, `62^7 ≈ 3.5T` — sufficient for 1B target with headroom. Single atomic op, no collisions by construction, codes stay short because they grow as `log_62(n)`.

**Tradeoff:** the counter approach leaks ordering (you can enumerate links) — mitigate by XOR-ing the counter with a secret before Base62 encoding, which preserves uniqueness but randomizes the visible code.

### 2. Collision Handling

**Problem:** When using hashing, truncating SHA-256 to 8 chars is not bijective — two different URLs can map to the same prefix. The counter scheme avoids this, but if you pick hashing you need a plan.

**Solution:** A `UNIQUE` constraint on `short_code` in the DB is the source of truth. On insert conflict, the write service appends a small random salt (or bumps a per-URL nonce) and re-hashes, retrying 3-5 times. After that many retries the odds of collision are astronomically low given the 218T space; a hard failure surface to the client is acceptable at that point.

### 3. Scaling Reads to 600k QPS

**Problem:** 100M DAU x ~5 redirects = 500M/day average ≈ 5.8k RPS; at 100x peak that's ~600k RPS. A single SSD-backed DB tops out around 100k IOPS — cannot serve peak directly.

**Solution:** A layered read path.

1. **B-tree index on `short_code`** (free if it's the PK) — O(log n) lookup, required baseline.
2. **In-memory cache (Redis / Memcached)** in front of the DB. Memory access is ~100ns vs ~100µs for SSD (roughly 1000x), and a single Redis node sustains 100k+ ops/sec. With strong locality (a small percentage of links get the majority of clicks — classic Zipfian), cache hit rates of 95%+ are realistic, dropping DB QPS into comfortable territory.
3. **Eviction & TTL:** LRU eviction; cache TTL must be `<=` the URL's `expiration_date` so expired links are not served from stale cache.
4. **Replica fan-out:** DB read replicas absorb the residual miss traffic; writes go to primary.

### 4. Edge / CDN-based Redirects

**Problem:** Even a perfectly cached origin has a WAN round-trip per click from distant regions, which hurts the <100ms target for global users.

**Solution:** Serve the short-link domain via a CDN and push the redirect logic to the edge (Cloudflare Workers, Lambda@Edge, Fastly Compute). The edge node caches the `short_code -> long_url` mapping; 302s are returned without ever hitting the origin. Invalidation is the hard part — use short TTLs on the edge cache plus explicit purge calls when a URL is deleted or expires. This is a real cost/complexity tradeoff: worth it for a global product, over-engineering for regional traffic.

### 5. Counter Coordination & Batching

**Problem:** If every write service instance hits Redis for each short code, Redis becomes the bottleneck (and a single point of failure).

**Solution:** Each write-service pod reserves a batch of IDs from Redis (`INCRBY 1000`), then allocates locally from that range until exhausted. Network calls to Redis drop 1000x. If a pod crashes mid-batch the unused IDs are simply lost — acceptable because the 62^7 space is effectively unbounded. Redis high availability comes from Sentinel or Cluster mode; even if a few batches are duplicated across a failover, the DB's `UNIQUE` constraint catches it.

### 6. Custom Aliases and Expirations

**Problem:** Custom aliases collide with generated codes; expirations need to be enforced without a full table scan.

**Solution:** Custom aliases take the same code path as generated ones — they are inserted into the URL mapping table with the same `UNIQUE` constraint. If the user-supplied alias exists, the API returns `409 Conflict`. To avoid stealing the generator's namespace, reserve a visual convention (custom aliases must be `>=` 5 chars or contain a `-`) or keep a separate "reserved" bloom filter. Expirations are enforced at read time: if the row's `expiration_date` is past, return `410 Gone` and evict from cache. A background job sweeps expired rows periodically to reclaim storage.

### 7. Multi-Region Deployment

**Problem:** A single global Redis counter forces every write to cross regions, and a single primary DB cannot serve global reads at low latency.

**Solution:** Partition the counter space by region — e.g., `us-east: [0, 1B)`, `eu-west: [1B, 2B)`, `ap-south: [2B, 3B)`. No cross-region coordination on writes. Each region has its own DB (or writes go home-region, reads go local replica). Reads are served from regional caches and CDN edges. Cross-region replication stitches the mapping table together asynchronously; the read cache absorbs the eventual-consistency window.

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

## Expected Depth by Level

| Area | Mid | Senior | Staff+ |
|---|---|---|---|
| **Requirements** | Captures shorten + redirect; asks about scale when prompted. | Proactively names read-heavy as the dominant constraint; quantifies QPS and storage. | Frames the whole design around the 1000:1 ratio from the first minute. |
| **Short code generation** | Proposes one approach (hash or counter). | Compares hash vs counter with tradeoffs; knows Base62 and why. | Brings up enumeration attacks and XOR-with-secret mitigation; discusses per-region counter ranges. |
| **Collision handling** | Mentions UNIQUE constraint when asked. | Describes retry-with-salt and why truncation reintroduces collisions. | Reasons about probabilistic bounds; picks retry count based on birthday math. |
| **Read scaling** | Says "add a cache" when prompted. | Designs cache + replicas + eviction/TTL; distinguishes TTL from URL expiration. | Leads with tiered cache (edge -> regional -> DB) and Zipfian hit-rate reasoning. |
| **Write path** | Single write service. | Read/write service split with independent scaling. | Counter batching, Redis HA, UNIQUE as final correctness net even on failover. |
| **Geo / CDN** | Not expected. | Mentions CDN for static; recognizes edge as an option. | Designs active-active regions with partitioned counter ranges and edge-executed redirects. |
| **Failure modes** | Names "DB down." | Walks through cache miss storms, Redis failover, write retries. | Chaos-tests the plan: region loss, counter-range exhaustion, cache stampedes, replication lag. |
| **Product thinking** | Handles custom alias as a field. | Designs alias collision path and expiration enforcement. | Treats abuse, cold storage tiering, and cost-per-click as first-class concerns. |
