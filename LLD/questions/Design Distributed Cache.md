# Design Distributed Cache

> **Pattern**: Consistent Hashing / In-memory Store
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/distributed-cache)

---

## Table of Contents

- [Understanding the Problem](#understanding-the-problem)
  - [Functional Requirements](#functional-requirements)
  - [Non-Functional Requirements](#non-functional-requirements)
- [Core Entities](#core-entities)
- [API Design](#api-design)
- [High-Level Design](#high-level-design)
- [Deep Dives](#deep-dives)
  - [1. Consistent Hashing and the Ring](#1-consistent-hashing-and-the-ring)
  - [2. Eviction Policies: LRU, LFU, TTL, FIFO](#2-eviction-policies-lru-lfu-ttl-fifo)
  - [3. Replication and Availability](#3-replication-and-availability)
  - [4. Hot Keys: Read and Write Paths](#4-hot-keys-read-and-write-paths)
  - [5. Cache Consistency and Coherence](#5-cache-consistency-and-coherence)
- [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
  - [Stage 1: 0–1K RPS (MVP)](#stage-1-01k-rps-mvp)
  - [Stage 2: 1K–10K RPS](#stage-2-1k10k-rps)
  - [Stage 3: 10K–100K RPS](#stage-3-10k100k-rps)
  - [Stage 4: 100K–1M RPS](#stage-4-100k1m-rps)
  - [Stage 5: 1M+ RPS (Hyperscale)](#stage-5-1m-rps-hyperscale)
- [Insider Tips and Tricks](#insider-tips-and-tricks)
- [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A distributed cache stores key-value pairs in memory across many machines, serving reads and writes in single-digit milliseconds. It is the classic performance layer that sits between application servers and the primary data store, reducing read pressure on slower durable systems while absorbing traffic spikes. The core tensions are keeping keys evenly spread across nodes as the cluster grows and shrinks, evicting data intelligently when memory is full, and surviving node failures without losing availability.

### Functional Requirements

**In scope:**
1. `SET(key, value)` — write a key-value pair into the cache
2. `GET(key)` — read the value for a key, returning a miss if absent or expired
3. `DELETE(key)` — remove a key explicitly
4. Configurable per-key TTL so entries expire automatically
5. Evict entries using an LRU policy when memory is full

**Out of scope (below the line):**
- Configurable cluster-wide cache size knobs
- Durability across process restarts (cache is ephemeral)
- Strong consistency guarantees
- Range queries, secondary indexes, or transactions

### Non-Functional Requirements

1. **Low latency** — p99 under 10 ms for GET and SET on the hot path
2. **High availability** — the cache must keep serving reads even during node failures; eventual consistency is acceptable
3. **Scalable** — target roughly 1 TB of data and 100K RPS, with headroom to grow an order of magnitude
4. **Even key distribution** — no single node holds a disproportionate share of keys or traffic
5. **Elastic** — adding or removing a node must move only a small fraction of keys, not reshuffle the whole dataset

---

## 🧒 Layman's Explanation

Think of a distributed cache as a **neighborhood network of pantries**. Instead of every house sprinting to the supermarket every time someone needs flour, a few neighbors keep popular items stocked at home. When you need flour, you check your own pantry first, then a neighbor's, and only if both are empty do you make the long trip to the store. That's exactly how a multi-tier cache works — fast, local, and shared.

Or picture a **library branch network**: rather than one giant central library, the city has many small branches, each holding the slice of the catalog its neighborhood actually reads. Your local branch is fast; rare books require an inter-branch loan. A distributed cache is the same — data lives close to who asks for it.

**Why distribute it?** Two reasons. First, the catalog doesn't fit on one machine — flour, sugar, eggs, and a thousand other ingredients can't all sit in one pantry. Second, redundancy: if a single pantry burns down, you don't want to lose every bag of flour in the neighborhood.

**Consistent hashing** is the rule that says "ingredient X always lives in pantry Y," so everyone knows exactly where to look. The clever part: when a new pantry opens, only a small slice of items moves — you don't reshuffle the whole neighborhood.

**Eviction** handles the awkward truth that pantries are finite. When yours fills up, the items you haven't touched in weeks get tossed first (LRU — least recently used).

**Replication** keeps important items in two pantries at once, so a closure doesn't strand you.

**Hot keys** are the chaos scenario: if everyone in the neighborhood wants flour at the same instant, the flour-pantry gets mobbed. The fix is to stock flour in several pantries, or for each house to keep a small jar on its own counter.

### When the analogy breaks down

Real Memcached and Redis clusters serve **millions of operations per second**, not a handful of weekly grocery runs. They face problems no neighborhood does: **cache stampedes** where thousands of clients miss the same key in the same millisecond, **TTL-based expiry running alongside LRU eviction** as two simultaneous reclamation policies, and **probabilistic early refresh** to dodge synchronized expiry spikes. The "neighborhood" in production is actually a **globally distributed Redis cluster spanning regions and continents**, with cross-region replication lag, edge CDN tiers in front of it, and CDC pipelines tailing database binlogs to invalidate stale entries — a level of coordination no real pantry network would ever attempt.

---

## Core Entities

A distributed cache has a small but carefully chosen set of entities. They exist to make partitioning, lookup, and replication cheap.

| Entity | Description | Why it matters |
|---|---|---|
| **Key** | Opaque string (or bytes) used for placement and lookup | Hashed to a ring position; must have a uniform distribution |
| **Value** | Arbitrary bytes, typically small (bytes to KBs) | Sizing drives memory budget and network egress |
| **Node** | A single cache server (process + memory) holding a shard of the keyspace | Unit of failure, scale, and placement |
| **Ring** | Abstract circular hash space (e.g., 0 to 2^32-1) that nodes and keys both map onto | Decouples the number of nodes from the hash function |
| **Virtual Node (vnode)** | Multiple hash positions per physical node (typically 100–500) | Smooths load imbalance and shrinks the blast radius of add/remove |
| **Coordinator / Client Library** | The component that owns the ring topology and routes requests | Where the partitioning decision is actually made |

The **Ring** is the central abstraction. Keys hash to ring positions and are owned by the first node encountered clockwise. Virtual nodes sprinkle each physical node across the ring so that adding or removing a node moves only `1/N` of keys, not all of them.

---

## API Design

The external API is intentionally narrow. Anything fancier belongs in the application, not the cache.

```
SET(key: string, value: bytes, ttl_seconds?: int) -> OK | ERROR
GET(key: string) -> { hit: bool, value?: bytes }
DELETE(key: string) -> OK | ERROR
```

Notes:
- `SET` is write-through to the owning node and its replicas. The response may return after the primary accepts the write (async replication) or after a quorum of replicas ack (stronger).
- `GET` resolves the owning node via the ring, then hits memory on that node. On a miss, the application is responsible for loading from the source of truth and calling `SET`.
- `DELETE` propagates to all replicas; stale reads during propagation are acceptable under eventual consistency.

Admin/ops APIs (`ADD_NODE`, `REMOVE_NODE`, `STATS`) exist but are out of the request path.

---

## High-Level Design

At 100K RPS and 1 TB of data, a single machine cannot hold everything in memory, so the cache must be sharded across a cluster. The flow:

1. **Client / Application Server** issues `GET` or `SET` to a client library that knows the ring.
2. **Client Library** hashes the key, walks the ring clockwise to find the owning virtual node, and sends the request directly to the corresponding **Cache Node**.
3. **Cache Node** handles the request in memory (hash table for lookup, doubly linked list for LRU ordering, min-heap or lazy scan for TTL expiry).
4. **Replicas** — each key lives on the primary plus `R-1` clockwise neighbors on the ring. Writes fan out to replicas asynchronously (or quorum-synchronously).
5. **Gossip / Membership Service** (or a configuration service like Zookeeper/etcd) keeps ring membership consistent so clients agree on who owns what.

```
   +----------+      +-----------------------+      +-----------+
   |  App     | ---> | Client Library        | ---> | Node A    |
   |          |      | (ring + vnodes)       |      | Node B    |
   +----------+      +-----------------------+      | Node C    |
                              |                     +-----------+
                              v
                    +---------------------+
                    | Membership service  |
                    | (gossip / etcd)     |
                    +---------------------+
```

Key design calls:
- **Smart client** vs dumb client with a proxy: smart client saves a hop but couples applications to the ring; a proxy (e.g., Twemproxy, mcrouter) centralizes topology at the cost of one extra network hop.
- **In-memory data structures**: hash map for O(1) lookup, doubly linked list for O(1) LRU recency updates, optional skip list / sorted set for sorted structures.
- **Thread model**: single-threaded event loop per node (Redis model) sidesteps locking entirely; per-core sharding scales vertically.

---

## Deep Dives

### 1. Consistent Hashing and the Ring

**Problem.** Plain modulo sharding (`hash(key) % N`) is catastrophic when `N` changes — nearly every key moves. At 1 TB that is hours of rewarming and a thundering herd on the origin.

**Idea.** Map both nodes and keys onto a large circular hash space. A key is owned by the nearest node clockwise. Adding a node `X` only steals the slice between `X` and its counterclockwise neighbor; removing a node hands its slice to the next clockwise neighbor. Only `1/N` of keys move, not all of them.

**Virtual nodes.** With only a handful of physical nodes, the ring is uneven — some nodes get huge arcs, some tiny. Solution: each physical node is represented by `V` hash positions. The textbook range of 100–500 is a starting point, but the right number depends on cluster size. With 3 physical nodes and only 3 vnodes each (9 total ring positions), hash collision clustering can still leave the ring badly unbalanced. With 100–300 vnodes per node, the distribution converges to near-uniform. A common production sweet spot for a cluster of ~10 nodes serving 100K RPS is 150 vnodes per node. The tradeoff: more vnodes means a larger routing table in the client library and more key migration work when a node joins or leaves. Profile the actual key distribution under your real access pattern — synthetic key sets often underestimate clustering.

**Implementation.** Each client stores a sorted array of `{ring_position, node_id}` tuples. A `GET` does a binary search (`O(log(N*V))`) for the first position ≥ `hash(key)`, wrapping around if needed. With 10 nodes and 150 vnodes each, the sorted array holds 1,500 entries — the binary search completes in ~11 comparisons.

**Rebalancing.** When a node joins, only keys in its new arc need to migrate. Background handoff streams these keys from the previous owner to the new node. During handoff, reads can be routed to either the previous owner or the new owner by marking the arc with a "join in progress" state. Both nodes serve reads for that arc until the handoff completes, preventing misses during the transition window. Once confirmed complete, the previous owner releases the arc.

### 2. Eviction Policies: LRU, LFU, TTL, FIFO

Memory is finite; something has to go. The policy choice matters because it shapes the hit rate under different workloads.

| Policy | Evicts | Best for | Data structure | Cost |
|---|---|---|---|---|
| **LRU** | Least recently used | Temporal locality (recent = relevant) | Hash map + doubly linked list | O(1) get/set |
| **LFU** | Least frequently used | Skewed popularity, long tail | Hash map + frequency buckets | O(1) with careful design (e.g., O(1) LFU paper) |
| **TTL** | Anything expired | Data with known freshness (sessions, tokens) | Expiry heap or lazy check on access | Lazy: O(1) amortized; active: O(log N) |
| **FIFO** | Oldest insertion | Simple, write-heavy workloads | Queue | O(1) |
| **Random** | Random entry | Memcached default; surprisingly good under uniform workloads | Array sampling | O(1) |

**LRU implementation** is the standard answer: an in-memory hash map points to nodes in a doubly linked list. On access, move the node to the head. On eviction, pop the tail. Both are O(1).

**Redis's approximate LRU.** Redis does not implement a true global LRU linked list — maintaining such a list would require a write on every GET, which is prohibitively expensive at scale. Instead, when eviction is needed, Redis samples a configurable number of keys (default: 5, tunable via `maxmemory-samples`) and evicts the least recently used among the sample. Increasing `maxmemory-samples` to 10 brings the approximation closer to true LRU at the cost of more CPU per eviction decision. This approximation is good enough for most workloads but means a key accessed 60 seconds ago might survive while one accessed 55 seconds ago gets evicted, depending purely on sampling luck.

**TTL handling** is orthogonal to eviction: lazy expiration checks TTL on access; active expiration samples a few keys per tick and evicts expired ones (Redis does both). A pure expiry heap is correct but costs O(log N) per insert and doesn't scale to many keys. Importantly, TTL expiry and LRU eviction are independent mechanisms — a key can be LRU-evicted before its TTL expires (memory pressure), or it can sit in memory past its TTL until it is lazily reclaimed on next access.

**Cache stampede prevention.** When a heavily read cache entry expires, all concurrent readers simultaneously miss and hammer the origin — the classic thundering herd. Request coalescing (single-flight) is the standard solution: one thread fetches from origin while the rest wait on its result. A lesser-known alternative is XFetch / probabilistic early expiration: as an entry approaches its TTL, a small random fraction of reads are artificially treated as misses and trigger a background refresh. The probability of an early refresh increases as the remaining TTL shrinks. This amortizes the refresh cost over time and avoids the synchronized expiry spike without requiring explicit lock coordination, making it especially useful in distributed environments where coordinating a single-flight lock across processes is complex.

**Scan resistance.** A single full-table scan can blow out pure LRU. Variants like LRU-K (track the K most recent accesses per key, evict the key with the oldest K-th access), 2Q (a probationary queue for new entries before they enter the main LRU), and ARC (adaptive replacement cache that balances recency and frequency dynamically) all provide better protection for workloads that mix sequential scans with a stable working set.

### 3. Replication and Availability

A single-copy cache loses data (and serves misses under load) the moment a node dies. Replication solves availability; it introduces consistency questions.

**Placement.** Each key lives on the primary plus the next `R-1` clockwise nodes on the ring (typically `R=2` or `R=3`). This is the same rule used by Dynamo/Cassandra.

**Write amplification.** Replication has a bandwidth cost that is easy to overlook when designing for read throughput. Every `SET` replicates to `R` nodes. At 100K SET/s with R=3 and an average value size of 1 KB, the cluster is doing 300K write operations per second and moving 300 MB/s of write traffic in aggregate. Many cache designs focus only on read throughput and are surprised when write-heavy workloads saturate the primary node's outbound NIC before its CPU. Benchmark both read and write paths. For write-intensive patterns (counters, session updates), prefer write coalescing — for example, accumulate increments client-side and flush with `INCRBY` — to reduce amplification at the cost of slightly stale intermediate values.

**Replication modes:**
- **Async (leader/follower).** Primary acks the write immediately; propagates to replicas in the background. Low latency, but replicas can lag. A crash after ack but before replication loses that write.
- **Sync quorum.** Write returns after `W` of `R` replicas ack; reads query `R` of `R` and pick the latest. With `W + R > N`, you get read-your-writes. Higher latency, stronger guarantees.
- **Chain replication.** Writes flow head-to-tail through an ordered chain; only the tail acks the client. Reads hit the tail exclusively. This provides strong consistency (reads always see the latest committed write) and simplifies failure handling, but tail latency is determined by the slowest node in the chain. A slow or flapping middle node stalls all writes behind it, making chain replication less suitable for latency-sensitive caches unless the chain is kept short (2–3 nodes).

**Failure detection.** Nodes gossip heartbeats; after `T` missed beats a node is marked down and its arc of the ring is reassigned to replicas until it returns or is replaced. Tuning `T` trades false positives (flapping) vs. detection latency.

**Anti-entropy.** Replicas that diverge during network partitions need reconciliation. Merkle trees provide an efficient mechanism: each node maintains a Merkle tree over its keyspace, and two nodes can identify divergent key ranges by comparing tree hashes top-down in O(log N) round trips rather than exchanging full key lists. Periodic full syncs (hash comparison + transfer) are a simpler fallback but incur proportionally higher cost as keyspace grows.

### 4. Hot Keys: Read and Write Paths

A small number of keys can receive a disproportionate share of traffic (the "Justin Bieber problem"). A single node saturates while others sit idle.

**Hot keys on reads:**
- **Replicate more.** Increase `R` just for hot keys, or replicate them to every node.
- **Client-local cache.** Application-side LRU caches the hottest items locally for hundreds of milliseconds. A small in-process L1 cache (~50–500 MB, 500ms–5s TTL) typically achieves 60–80% hit rate for temporal hot keys. The remaining misses go to the distributed L2 cluster, which might catch another 90%. Combined, origin load drops to roughly `(1 - 0.7) × (1 - 0.9) = 3%` of raw traffic. This multiplicative effect means L1 is disproportionately valuable for the hottest keys. The downside is per-process staleness windows; skip L1 for data where consistency matters (inventory counts, account balances).
- **Read-only fan-out.** Proxy layer fans reads across replicas round-robin.
- **Request coalescing.** Single-flight pattern: if 1,000 clients miss the same key simultaneously, only one loader actually hits the origin; the others wait on its result.

**Hot keys on writes:**
- **Sharding a hot key.** Split the value across `K` sub-keys (`user:123:counter:0..K`) and aggregate on read. Useful for counters, leaderboards.
- **Write coalescing / batching.** Merge writes in a small window before flushing (e.g., `INCRBY` merges 1,000 increments into one write operation, reducing both network round trips and replication fan-out by 3× at R=3).
- **Write-through to a dedicated hot-key shard** so the rest of the cluster is unaffected.

**Detection.** Track per-key QPS with a frequency sketch. Count-Min Sketch is the standard building block but over-counts due to hash collisions, which causes false positives in hot-key promotion. HeavyKeeper is a more accurate alternative for top-K detection: it uses a count-with-decay structure that naturally shrinks estimates for non-hot keys, achieving lower error rates than Count-Min at the same memory budget. Promote anything crossing a threshold to the hot-key handling path dynamically.

### 5. Cache Consistency and Coherence

The cache and the source of truth can drift. Which direction drift is allowed matters.

**Patterns:**
- **Cache-aside (lazy).** App reads cache, on miss loads from DB and sets cache. Simple, but stale entries linger until TTL. Two concurrent writers can race: Thread A reads from DB, Thread B writes a new value to DB and deletes the cache entry, then Thread A sets the old value back into cache — leaving a stale entry that survives until TTL despite an explicit invalidation. This race is subtle but real in high-concurrency environments.
- **Write-through.** App writes cache and DB atomically (cache in front, or write to cache which writes to DB). Strong consistency, slower writes.
- **Write-behind.** App writes cache only; cache asynchronously flushes to DB. Fast, but durability risk if cache dies before flush.
- **Read-through.** Cache handles misses itself by loading from DB. Centralizes logic but couples cache to DB schema.

**Invalidation.** "There are only two hard things in computer science: cache invalidation and naming things." Options:
- TTL — simple, always eventually correct, but bounded staleness.
- Explicit `DELETE` on write — correct if the app is disciplined, but still racy under cache-aside: even with a `DELETE` after every DB write, a concurrent reader that fetched the old value before the `DELETE` will re-populate the cache with stale data immediately after the `DELETE` completes.
- Change-data-capture (CDC) — tail the DB's binary replication log (e.g., MySQL binlog, Postgres logical replication), detect committed writes, and emit invalidation or update events to the cache. CDC invalidation is robust because it is derived from the durable commit record rather than application logic; it survives application bugs, direct DB writes, and multi-service ownership of the same table. The tradeoff is infrastructure complexity: you need a reliable CDC pipeline (Debezium, Maxwell, AWS DMS) and a way to map DB row changes to cache keys.

**Key naming as operational infrastructure.** In a shared cache cluster, every service should namespace its keys with a colon-separated prefix (e.g., `auth:session:{userId}`, `product:price:{productId}`). This enables `SCAN MATCH "auth:*" COUNT 100` for targeted debugging, pattern-based TTL enforcement, and safe keyspace event subscriptions. Without conventions, a memory dump is uninterpretable and selective invalidation becomes a grep exercise. Some teams maintain a key registry in their repo documenting TTL policy and owning service per prefix.

**Within the cache cluster**, eventual consistency between replicas is the norm. If stronger is needed, use quorum reads/writes or expose a versioning API (`CAS(key, expected_version, new_value)`) that rejects conflicting writes.

---

## Scaling Journey: 0 to Infinity

The cache's scaling story is driven by two axes: **memory footprint** (forcing sharding) and **request rate** (forcing replication, tiering, and geo-distribution). Each stage fixes the previous stage's dominant failure mode.

### Stage 1: 0–1K RPS (MVP)

**Goal.** Unblock development. Working cache with near-zero ops overhead.

**Architecture.** A single Redis or Memcached instance, a few GB of memory, one machine. Application uses cache-aside with a standard client library. TTL for invalidation. No replication, no sharding.

**What you skip.** Consistent hashing (only one node), replication (cache can be cold-started from the DB), monitoring beyond a basic dashboard, hot-key handling.

**Failure mode → next stage.** Single-node RAM hits its ceiling and/or the instance dies during a deploy, causing a thundering herd on the DB.

### Stage 2: 1K–10K RPS

**Goal.** Survive a node failure without taking down the origin; absorb a read-heavy workload.

**Architecture.** Primary Redis + one read replica behind a client-side failover. Reads can go to either replica (stale reads allowed); writes always go to the primary. Standard cache-aside pattern with per-key TTLs. Add basic observability: hit rate, eviction rate, memory pressure, p99 latency.

**What you skip.** Sharding (one machine still fits the working set), consistent hashing, multi-tier caching.

**Failure mode → next stage.** Working set outgrows one machine's RAM, evictions spike, hit rate collapses. A single primary also becomes a write bottleneck.

### Stage 3: 10K–100K RPS

**Goal.** Scale horizontally without massive data movement when adding capacity.

**Architecture.** Consistent-hash sharded cluster (Redis Cluster, or a fleet of Redis/Memcached nodes fronted by a smart client or a proxy like mcrouter/Twemproxy). Each physical node holds 100–500 virtual nodes to smooth distribution. Each shard has one or two replicas for HA. A membership service (gossip in Redis Cluster, or Zookeeper/etcd for proxies) keeps topology in sync. Introduce health checks, automatic failover, and background key migration for node add/remove.

**What you skip.** Client-local L1 caches, hot-key replication, cross-region replication.

**Failure mode → next stage.** A handful of keys account for a disproportionate share of traffic. One shard saturates its NIC or CPU while peers idle. Tail latency spikes on the hot shard.

### Stage 4: 100K–1M RPS

**Goal.** Flatten hot-key skew; shave another order of magnitude off origin load.

**Architecture.** Multi-tier caching. **L1** is a small in-process LRU in each application server (tens of MB, 100–500 ms TTL). **L2** is the distributed sharded cluster from Stage 3. Promote detected hot keys (via a Count-Min sketch of per-key QPS) to every node in the cluster, or to a dedicated hot-key replica set. Introduce request coalescing / single-flight at the L1 layer so that cache-miss storms collapse into a single origin call. Add CDC-based invalidation for keys where TTL-only staleness is unacceptable.

**What you skip.** Geo-replication, cross-region conflict resolution.

**Failure mode → next stage.** Traffic and data now span regions. Cross-region cache misses pay 100+ ms WAN round trips. A regional failure takes out an entire user population.

### Stage 5: 1M+ RPS (Hyperscale)

**Goal.** Serve reads at local-region latency globally while surviving a region failure.

**Architecture.** A cache cluster per region, each with its own consistent-hash ring and replicas. Writes follow the primary-region model (writes home to the record's home region; other regions invalidate on CDC) or an active-active model with conflict resolution (last-write-wins with vector clocks or CRDT-backed counters for hot aggregates). L1 client-local caches remain in every app tier. Hot keys are replicated to every region. A global control plane handles cluster membership, capacity planning, and region-aware routing. For the most extreme hot keys (e.g., a viral post), serve from an edge cache (CDN) with short TTLs plus proactive invalidation. Observability expands to per-region hit-rate and cross-region replication lag dashboards. Run continuous chaos tests (kill a replica, kill a shard, partition a region) to validate assumptions.

---

## Insider Tips and Tricks

### Redis Does Not Implement Exact LRU — It Uses Approximation

Redis's LRU eviction is not a true LRU. Instead of maintaining a global LRU linked list (which would require a write on every access), Redis samples a configurable number of keys (default: 5, tunable via `maxmemory-samples`) and evicts the least recently used among the sample. This approximation is good enough for most workloads but can be surprising: a key that was last accessed 60 seconds ago might survive eviction while a key accessed 55 seconds ago gets evicted, depending on which keys were sampled. If exact LRU semantics matter (e.g., for compliance or billing data), maintain your own LRU structure at the application layer or use a dedicated cache that tracks access order exactly.

### The Thundering Herd on Cache Expiry Is Solved by Probabilistic Early Expiration

When a heavily read cache entry expires, all concurrent readers simultaneously miss and hammer the origin — the classic thundering herd. The standard solution is request coalescing (single-flight), but there's an often-missed alternative: XFetch / probabilistic early expiration. As a cache entry approaches its TTL, a small random fraction of reads are artificially treated as misses and trigger a background refresh. The probability increases as the entry ages. This amortizes the refresh cost over time and prevents the synchronized expiry spike without requiring explicit lock coordination.

### Consistent Hashing with Too Few Virtual Nodes Creates Load Skew

The textbook says "use virtual nodes." The nuance is the count. With 3 physical nodes and only 3 vnodes each (9 total positions), the ring can still be badly unbalanced due to hash collision clustering. With 100–300 vnodes per node, the distribution converges to near-uniform. The tradeoff: more vnodes means larger routing tables in the client library and more work during rebalancing when a node joins. For a cluster of ~10 nodes serving 100K RPS, 150 vnodes per node is a common production sweet spot. Profile the actual key distribution under your access pattern; synthetic key sets often underestimate clustering.

### Key Naming Conventions Are Operational Infrastructure

In a shared Redis cluster, every service should namespace its keys with a colon-separated prefix (e.g., `auth:session:{userId}`, `product:price:{productId}`). This is not just aesthetics: it enables bulk operations like `SCAN MATCH "auth:*" COUNT 100` for debugging, pattern-based TTL enforcement, and safe key-space event subscriptions. Without conventions, a Redis memory dump becomes uninterpretable and selective cache invalidation becomes a grep exercise. Some teams go further and codify a key registry in their repo, with TTL policy and owning service documented per prefix.

### Cache Warming Prevents Post-Deploy Cold Starts

When you deploy a new cache node or restart after a maintenance window, the cache is empty. For the first few minutes, every request is a miss, flooding the downstream database. For latency-sensitive services, this brief cold-start can trigger alerts and user-visible degradation. The mitigation is proactive cache warming: before the new node goes live, a warming process reads popular keys from the origin (or from a sibling cache node) and populates the new node. For recommendation and ML feature caches, the warm-up script runs the previous hour's top-N lookup patterns. The window of degradation shrinks from minutes to seconds.

### Eviction and TTL Expiry Are Two Separate Code Paths

A common misconception: "TTL expiry evicts the key." In most cache implementations (Redis included), TTL expiry and LRU eviction are orthogonal mechanisms. A key can be expired-but-not-yet-deleted (lazy expiry: only removed when next accessed or when the active expiry sampler picks it up). Meanwhile, LRU eviction can delete a key that has NOT expired yet because the cache is under memory pressure. This means a `GET` that returns a miss could be: (a) never-set, (b) TTL-expired, or (c) LRU-evicted despite having time left on its TTL. If your application needs to distinguish these cases (e.g., for metrics), you need explicit tagging or a side channel, not just the GET response.

### Write Amplification Is Proportional to Your Replication Factor

Every `SET` to a key replicates to `R` nodes. At 100K SET/s with R=3, you're doing 300K write operations per second across the cluster. This matters for NIC saturation: if your average value is 1KB, that's 300MB/s of write traffic. Many cache designers focus only on read throughput and are surprised when write-heavy workloads saturate the primary node's outbound bandwidth before its CPU. Benchmark both paths. For write-intensive patterns (counters, session updates), consider write coalescing (batch increments, INCRBY instead of SET) to reduce amplification at the cost of slightly stale intermediate values.

### Multi-Tier Caching (L1 + L2) Changes Your Hit Rate Math Dramatically

An in-process L1 cache (a small LRU map in the application server, ~50–500MB, 500ms–5s TTL) typically achieves 60–80% hit rate for temporal hot keys. The remaining misses go to L2 (the distributed Redis cluster), which might catch another 90% of misses. Combined, origin load drops from 100% to roughly 100% × (1-0.7) × (1-0.9) = 3% of raw traffic. This multiplicative effect means L1 is disproportionately valuable for the hottest keys. The downside is staleness: L1 TTLs are short but still create per-process inconsistency windows. For data where consistency matters (inventory counts, account balances), skip L1 and read from L2 directly.

---

## Expected Depth by Level

| Level | Expectation |
|---|---|
| **Mid** | Knows cache-aside vs. write-through, LRU mechanics (hash map + DLL), and can draw a single-region Redis cluster with replicas. Can discuss TTL-based invalidation. May handwave sharding. |
| **Senior** | Can derive consistent hashing from first principles, explain why virtual nodes matter, reason about replication factor vs. quorum, and articulate hot-key trade-offs (replication, client-local caching, request coalescing). Knows when to pick LRU vs LFU vs TTL. Discusses failure detection and graceful degradation. |
| **Staff** | Designs multi-tier (L1 in-process + L2 distributed) and multi-region topologies; reasons precisely about consistency models (eventual, quorum, CAS, CRDTs); discusses CDC-based invalidation vs. TTL trade-offs; quantifies hit rate, memory budget, and NIC/CPU saturation per node; addresses operational concerns like rolling upgrades, key migration during scale-out, and chaos testing. Can name concrete systems (Dynamo, Cassandra, Redis Cluster, mcrouter, Twemproxy) and articulate why each made the choices it did. |
