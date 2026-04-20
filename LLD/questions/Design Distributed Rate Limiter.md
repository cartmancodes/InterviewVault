# Design Distributed Rate Limiter

> **Pattern**: Coordination / Counting
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/distributed-rate-limiter)

---

## Table of Contents

- [Understanding the Problem](#understanding-the-problem)
  - [Functional Requirements](#functional-requirements)
  - [Non-Functional Requirements](#non-functional-requirements)
- [Core Entities / Algorithms](#core-entities--algorithms)
- [API Design](#api-design)
- [High-Level Design](#high-level-design)
- [Deep Dives](#deep-dives)
  - [1. Algorithm Choice: Token Bucket vs Sliding Window](#1-algorithm-choice-token-bucket-vs-sliding-window)
  - [2. Consistency vs Performance](#2-consistency-vs-performance)
  - [3. Sync vs Async Counter Updates](#3-sync-vs-async-counter-updates)
  - [4. Multi-Node Coordination and Atomicity (Redis + Lua)](#4-multi-node-coordination-and-atomicity-redis--lua)
  - [5. Fail-Open vs Fail-Closed](#5-fail-open-vs-fail-closed)
- [Scaling Journey: 0 → ∞](#scaling-journey-0--)
  - [Stage 1: 0 – 100 RPS (MVP)](#stage-1-0--100-rps-mvp)
  - [Stage 2: 100 – 1,000 RPS](#stage-2-100--1000-rps)
  - [Stage 3: 1K – 100K RPS](#stage-3-1k--100k-rps)
  - [Stage 4: 100K – 10M RPS](#stage-4-100k--10m-rps)
  - [Stage 5: 10M+ RPS (Hyperscale)](#stage-5-10m-rps-hyperscale)
- [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A distributed rate limiter caps how often a client (user, IP, or API key) can call an API over a time window, protecting backends from abuse, runaway clients, and traffic spikes. The core tension is enforcing a global limit across many gateway nodes without adding meaningful latency to the critical path.

### Functional Requirements

**In scope:**
1. Identify the client per request via user ID, IP address, or API key
2. Enforce configurable rules (e.g., 100 req/min per user, 10 req/sec per IP, per-endpoint caps)
3. Reject excess traffic with HTTP 429 and informative headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`)
4. Support layered rules — most restrictive applicable rule wins

**Out of scope:** strong consistency, long-term audit/persistence of every request, billing-grade accuracy.

### Non-Functional Requirements

1. **Low latency**: < 10 ms overhead on the request path
2. **High availability**: eventual consistency is acceptable; brief counter drift across nodes is fine
3. **Scale**: target 1M+ requests per second across 100M+ DAU
4. **Graceful degradation**: the limiter must not itself cause outages
5. **Cheap**: per-request cost must be tiny — limiter runs on every call

---

## Core Entities / Algorithms

The "entities" in a rate limiter are really the algorithm choices. Each trades accuracy, memory, and burst handling differently.

| Algorithm | Idea | Memory per client | Pros | Cons |
|---|---|---|---|---|
| **Token Bucket** | Bucket of N tokens refills at rate R; each request costs 1 token | 2 fields (tokens, last_refill) | Handles bursts naturally; simple; cheap | Cold-start bursts; two params to tune |
| **Leaky Bucket** | Requests queue into a bucket draining at rate R | Queue / counter + timestamp | Smooth output rate | Queues add latency; doesn't allow bursts |
| **Fixed Window** | Count requests in discrete N-second buckets | 1 counter | Trivial to implement | Boundary doubling (2N in one second at window edge) |
| **Sliding Window Log** | Store every timestamp; drop those outside window | O(N) timestamps per client | Exact; no boundary effect | Memory blows up under heavy users |
| **Sliding Window Counter** | Weighted blend of current + previous fixed windows | 2 counters | Near-exact, cheap | Assumes uniform distribution inside windows |

**Default choice: Token Bucket** — best blend of simplicity, burst tolerance, and O(1) state per client.

---

## API Design

The rate limiter exposes a single internal decision primitive, invoked by the gateway on every request.

```
isRequestAllowed(clientId, ruleId)
  → { passes: bool, remaining: int, resetTime: unixTs }
```

On reject, the gateway returns:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit:     100
X-RateLimit-Remaining: 0
X-RateLimit-Reset:     1713590400
Retry-After:           12
```

Rule configuration itself lives behind a small admin API (CRUD on rules; rules keyed by `(scope, resource)`).

---

## High-Level Design

**Placement decision: at the edge (API gateway / L7 load balancer).**
- *In-process in each app server* — rejected: each node only sees its own slice of traffic, making the global limit unpredictable.
- *Dedicated limiter microservice* — viable but adds a per-request network hop.
- *Embedded in API gateway* — chosen: single enforcement point, already on the hot path, no extra hop.

**State store: centralized Redis.**
- All gateway nodes read/write the same counter keyed by `clientId`.
- Redis gives sub-millisecond ops, atomic primitives (`INCR`, `EXPIRE`), and Lua for read-modify-write.

**Request flow:**
1. Gateway extracts `clientId` from JWT / `X-Forwarded-For` / `X-API-Key`.
2. Resolves applicable rules (most restrictive wins).
3. Calls Redis via a Lua script that performs the token-bucket math atomically and returns allow/deny + remaining.
4. Attaches rate-limit headers, forwards or rejects.

```
Client → LB → API Gateway ──(Lua script)──→ Redis (shared state)
                    │
                    └─ on allow → Backend services
                    └─ on deny  → 429
```

---

## Deep Dives

### 1. Algorithm Choice: Token Bucket vs Sliding Window

**Token Bucket** wins on the happy path: O(1) state, burst-tolerant, trivially atomic in Lua (read tokens, compute refill since `last_refill`, decrement, write back).

**Sliding Window Counter** wins when fairness across the window boundary matters (e.g., billing APIs where a customer must not be able to fire 2x their quota at the minute boundary). The math:

```
approx_count = prev_window_count * (1 - elapsed_in_current_window / window_size)
             + current_window_count
```

Still two integer fields per client, still atomic in Lua. The approximation error is bounded and shrinks as windows shorten.

**Sliding Window Log** is usually wrong at scale — an active user can accumulate tens of thousands of timestamps per window and every check does an O(N) scan.

**Rule of thumb:**
- User-facing API with bursty legitimate traffic → Token Bucket
- Billing/quota-critical → Sliding Window Counter
- Regulatory/exact-count → Sliding Window Log (and pay the memory cost)

### 2. Consistency vs Performance

A perfectly consistent global counter requires either a single-leader store or distributed consensus — both kill the < 10 ms budget. Rate limiters exploit the fact that **strict consistency is not required**: if a user occasionally sneaks one extra request through during a race, that's fine.

- **Single Redis primary** per shard gives linearizable ops with sub-ms latency. This is the sweet spot.
- **Read replicas** are *not* used for rate-limit reads — replica lag means you'd under-count.
- **Multi-region active-active** uses per-region counters with async reconciliation; accept that a user gets a separate quota per region (often acceptable; sometimes desirable).

The explicit trade: we pick *availability + low latency* over strong global consistency because the cost of a few stray requests is trivial compared to adding 50 ms of consensus to every API call.

### 3. Sync vs Async Counter Updates

**Sync (default):** every request blocks on Redis until the counter is updated. Correct, adds ~1 ms on a warm connection, fine up to the Redis throughput ceiling (~50-100K ops/sec per instance).

**Async batching (optimization at scale):**
- Gateway keeps a *local approximate counter* in memory.
- Every M requests (or every T ms), flush the delta to Redis with `INCRBY`.
- Redis is the source of truth; local counters are advisory.
- Benefit: 10-100x reduction in Redis ops.
- Cost: slack window where a client can overshoot the global limit by up to `M × num_gateways` requests. Tune M to keep overshoot within tolerance.

**Hybrid (best for hyperscale):**
- Sync path for clients near their limit (say, >80% consumed) — accuracy matters here.
- Async batched path for clients far from their limit — the common case.
- A per-gateway local cache tracks "time until this client could possibly hit the limit" so we know when to switch modes.

### 4. Multi-Node Coordination and Atomicity (Redis + Lua)

Naive implementation:

```
tokens, last_refill = HMGET bucket:alice tokens last_refill
# ... compute new tokens in app ...
MULTI
  HSET bucket:alice tokens <new>
  HSET bucket:alice last_refill <now>
EXEC
```

This is **broken**: the read happens outside the transaction. Two gateways can read the same state, both compute "1 token left → allow", and both decrement. Classic lost-update.

**Fix: Lua script.** Redis runs scripts atomically; the entire read-compute-write is one operation:

```lua
-- KEYS[1] = bucket key, ARGV = { capacity, refill_rate, now }
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or tonumber(ARGV[1])
local ts     = tonumber(state[2]) or tonumber(ARGV[3])
local delta  = math.max(0, tonumber(ARGV[3]) - ts) * tonumber(ARGV[2])
tokens = math.min(tonumber(ARGV[1]), tokens + delta)
if tokens < 1 then
  return { 0, tokens }
end
tokens = tokens - 1
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[3])
redis.call('EXPIRE', KEYS[1], 3600)
return { 1, tokens }
```

All gateways running the same script against the same Redis primary produce a serializable order of operations. `EXPIRE` auto-cleans idle keys — critical when you have 100M clients most of whom are inactive at any moment.

**Sharding for horizontal scale:** hash `clientId` → shard via consistent hashing (or Redis Cluster's 16,384 slot scheme). Same client always hits same shard → the script's atomicity guarantee still holds globally for that client.

### 5. Fail-Open vs Fail-Closed

When Redis is unreachable, the gateway has to choose:

- **Fail-open**: allow the request through. API stays up, but rate limiting is off exactly when you might need it most (e.g., during a traffic spike that's *causing* the Redis pressure).
- **Fail-closed**: reject with 429 or 503. Safer for downstream services; painful for users.

Most production systems pick a **hybrid**: fail-open briefly (circuit breaker open for 1-2 seconds), then fail-closed if Redis stays down, to avoid a total outage caused by the limiter itself. Pair this with Redis primary-replica failover (Redis Sentinel or Cluster) so the unreachable state is rare and short.

---

## Scaling Journey: 0 → ∞

A rate limiter is measured by the traffic flowing through it, not the user count. Each stage below adds infrastructure only when the previous stage's bottleneck bites.

### Stage 1: 0 – 100 RPS (MVP)

**Goal:** protect a single-server API from obvious abuse.

**Architecture:**
- **In-process token bucket** in the app server (e.g., `golang.org/x/time/rate`, `express-rate-limit`, `bucket4j`).
- State lives in a local `Map<clientId, Bucket>` with LRU eviction.
- One process, one counter table, zero network hops.

**What you skip:** Redis, distributed coordination, any gateway tier.

**Failure mode that pushes to Stage 2:** you add a second app server behind a load balancer. Now each server only sees half the traffic → a client can fire 2× their quota by hitting both.

---

### Stage 2: 100 – 1,000 RPS

**Goal:** enforce a single global limit across a small fleet (2–5 app servers).

**Architecture:**
- Stand up a **single Redis instance** (or managed ElastiCache/Upstash) shared by all servers.
- Switch the bucket implementation to use Redis `INCR` + `EXPIRE` for fixed-window, or a small Lua script for token bucket.
- Keep the limiter logic in the app layer — no dedicated gateway yet.
- Connection pooling to Redis (persistent TCP; never open per request).

**What you skip:** sharding, replication, async batching. One Redis handles this comfortably.

**Failure mode that pushes to Stage 3:** traffic grows 100×. Redis CPU is fine, but the limiter logic is duplicated across services and a deploy bug in one service bypasses it entirely.

---

### Stage 3: 1K – 100K RPS

**Goal:** centralize enforcement and hit real production SLAs.

**Architecture:**
- **Move rate limiting to the API gateway / edge load balancer** (Envoy, Kong, AWS API Gateway, nginx + Lua). One enforcement point, no per-service reimplementation.
- **Atomic Lua scripts** for token bucket — eliminate the read-modify-write race described in Deep Dive 4.
- **Redis primary + replica** with Sentinel for automatic failover.
- **Dynamic rule config**: rules in a small DB, gateways poll every 30s and cache locally.
- **Structured metrics**: `limit_hit_total`, `limit_check_latency_p99`, `redis_errors_total`.

**What you skip:** Redis Cluster sharding, async batching, multi-region. One Redis primary still handles 50–100K ops/sec.

**Failure mode that pushes to Stage 4:** approaching 100K RPS, Redis CPU pins at 100%. A single primary is the bottleneck.

---

### Stage 4: 100K – 10M RPS

**Goal:** horizontally scale the limiter state tier.

**Architecture:**
- **Shard Redis** via consistent hashing on `clientId` (or Redis Cluster, 16,384 slots). Each shard handles ~50–100K ops/sec → 10 shards covers 1M RPS, 100 covers 10M.
- All requests from the same client always land on the same shard, preserving per-client atomicity.
- **Hot-key mitigation**: if a single viral API key saturates its shard, add a *replicated read counter* with async writes (sacrificing a bit of accuracy for that key), or promote the client to a dedicated shard.
- **Async counter batching** for the far-from-limit common case (Deep Dive 3): each gateway flushes deltas every 100 ms, cutting Redis load ~50×.
- **Circuit breaker around Redis** with short fail-open windows to keep the gateway usable during brief Redis blips.
- **Per-endpoint and per-IP rules** layered on top of per-user; most restrictive wins.

**What you skip:** multi-region active-active, cross-region reconciliation. Still one region.

**Failure mode that pushes to Stage 5:** the service goes global. Users in Europe pay transatlantic latency on every Redis check, blowing the 10 ms budget.

---

### Stage 5: 10M+ RPS (Hyperscale)

**Goal:** global, multi-region rate limiting with production-grade operations.

**Architecture:**
- **Per-region Redis clusters.** Each region enforces independently; most rate limits become "per region" by design. This is often a feature, not a bug (quota-by-region is what customers want).
- For truly global limits (e.g., total API quota), **async cross-region reconciliation**: every region periodically pushes deltas to a global aggregator; local counters self-correct. Overshoot is bounded by `reconciliation_interval × per_region_rate`.
- **Client-side approximation** for the hottest internal services: SDKs enforce a local budget and sync deltas asynchronously. The central limiter becomes an auditor rather than a gatekeeper. Trades strictness for latency and cost.
- **Tiered limits**: free / paid / enterprise tiers with different rules; premium customers get dedicated shards to avoid noisy-neighbor contention.
- **DDoS offload**: obvious attack traffic (single IP hammering with no auth) is shed at the CDN edge (Cloudflare, AWS Shield) before hitting the limiter at all.
- **Observability**: per-rule hit rates, per-shard latency histograms, anomaly detection on limit-hit patterns (sudden spike in 429s → likely attack or upstream bug).
- **Graceful degradation playbook**: explicit runbooks for Redis partition loss, regional failover, limit-config rollback.

**Key insight at this stage:** the rate limiter's own failure modes become the dominant risk. Every design decision is now judged by "does this make the limiter itself more or less likely to cause an outage?" Fail-open windows, circuit breakers, per-region isolation, and client-side approximation all exist because the limiter must never be the single point of failure for the entire API.

---

## Expected Depth by Level

| Level | Breadth / Depth | Focus |
|---|---|---|
| **Mid** | Breadth-first (~80/20) | Pick one algorithm (Token Bucket), place limiter at the API gateway, name Redis as shared state, acknowledge sharding exists |
| **Senior** | ~60/40 | Compare algorithms with trade-offs; articulate atomicity problem and Lua fix; discuss fail-open vs fail-closed; propose consistent-hashing shards and connection pooling without being prompted |
| **Staff+** | ~40/60 | Treat algorithm/store as solved; spend time on hot-key mitigation, async batching, hybrid sync/async, multi-region reconciliation, limiter-as-its-own-SPOF, observability and rollout strategy; draw from real-world operations experience |
