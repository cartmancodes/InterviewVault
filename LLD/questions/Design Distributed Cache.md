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

**Virtual nodes.** With only a handful of physical nodes, the ring is uneven — some nodes get huge arcs, some tiny. Solution: each physical node is represented by `V` hash positions (typically 100–500). This both smooths load and shrinks the arcs affected during membership changes.

**Implementation.** Each client stores a sorted array of `{ring_position, node_id}` tuples. A `GET` does a binary search (`O(log (N*V))`) for the first position ≥ `hash(key)`, wrapping around if needed.

**Rebalancing.** When a node joins, only keys in its new arc need to migrate. Background handoff streams these keys from the previous owner; reads during handoff can be routed to either owner (with a "join in progress" marker) to avoid misses.

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

**TTL handling** is orthogonal: lazy expiration checks TTL on access; active expiration samples a few keys per tick and evicts expired ones (Redis does both). A pure expiry heap is correct but costs O(log N) per insert and doesn't scale to many keys.

**Scan resistance.** A single full-table scan can blow out pure LRU. Variants like LRU-K (track K most recent accesses), 2Q (queue of "probationary" entries), and ARC (adaptive replacement) exist for workloads mixing scans with working sets.

### 3. Replication and Availability

A single-copy cache loses data (and serves misses under load) the moment a node dies. Replication solves availability; it introduces consistency questions.

**Placement.** Each key lives on the primary plus the next `R-1` clockwise nodes on the ring (typically `R=2` or `R=3`). This is the same rule used by Dynamo/Cassandra.

**Replication modes:**
- **Async (leader/follower).** Primary acks the write immediately; propagates to replicas in the background. Low latency, but replicas can lag. A crash after ack but before replication loses that write.
- **Sync quorum.** Write returns after `W` of `R` replicas ack; reads query `R` of `R` and pick the latest. With `W + R > N`, you get read-your-writes. Higher latency, stronger guarantees.
- **Chain replication.** Writes flow through an ordered chain; reads hit the tail. Strong consistency but tail latency suffers.

**Failure detection.** Nodes gossip heartbeats; after `T` missed beats a node is marked down and its arc of the ring is reassigned to replicas until it returns or is replaced. Tuning `T` trades false positives (flapping) vs. detection latency.

**Anti-entropy.** Merkle trees or periodic full syncs reconcile replicas that drift during partitions.

### 4. Hot Keys: Read and Write Paths

A small number of keys can receive a disproportionate share of traffic (the "Justin Bieber problem"). A single node saturates while others sit idle.

**Hot keys on reads:**
- **Replicate more.** Increase `R` just for hot keys, or replicate them to every node.
- **Client-local cache.** Application-side LRU caches the hottest items locally for hundreds of milliseconds. Orders-of-magnitude QPS reduction.
- **Read-only fan-out.** Proxy layer fans reads across replicas round-robin.
- **Request coalescing.** Single-flight pattern: if 1,000 clients miss the same key simultaneously, only one loader actually hits the origin; the others wait on its result.

**Hot keys on writes:**
- **Sharding a hot key.** Split the value across `K` sub-keys (`user:123:counter:0..K`) and aggregate on read. Useful for counters, leaderboards.
- **Write coalescing / batching.** Merge writes in a small window before flushing (e.g., `INCRBY` merges 1,000 increments into one).
- **Write-through to a dedicated hot-key shard** so the rest of the cluster is unaffected.

**Detection.** Track per-key QPS in a sketch (Count-Min, HeavyKeeper). Promote anything crossing a threshold to the hot-key handling path dynamically.

### 5. Cache Consistency and Coherence

The cache and the source of truth can drift. Which direction drift is allowed matters.

**Patterns:**
- **Cache-aside (lazy).** App reads cache, on miss loads from DB and sets cache. Simple, but stale entries linger until TTL. Two concurrent writers can race and leave the cache inconsistent with the DB.
- **Write-through.** App writes cache and DB atomically (cache in front, or write to cache which writes to DB). Strong consistency, slower writes.
- **Write-behind.** App writes cache only; cache asynchronously flushes to DB. Fast, but durability risk if cache dies before flush.
- **Read-through.** Cache handles misses itself by loading from DB. Centralizes logic but couples cache to DB schema.

**Invalidation.** "There are only two hard things in computer science: cache invalidation and naming things." Options:
- TTL — simple, always eventually correct, but bounded staleness.
- Explicit `DELETE` on write — correct if the app is disciplined, racy otherwise (update DB, delete cache, concurrent reader refills stale value between the two).
- Change-data-capture (CDC) — tail the DB's replication log, invalidate cache in response. Robust, but adds infrastructure.

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

## Expected Depth by Level

| Level | Expectation |
|---|---|
| **Mid** | Knows cache-aside vs. write-through, LRU mechanics (hash map + DLL), and can draw a single-region Redis cluster with replicas. Can discuss TTL-based invalidation. May handwave sharding. |
| **Senior** | Can derive consistent hashing from first principles, explain why virtual nodes matter, reason about replication factor vs. quorum, and articulate hot-key trade-offs (replication, client-local caching, request coalescing). Knows when to pick LRU vs LFU vs TTL. Discusses failure detection and graceful degradation. |
| **Staff** | Designs multi-tier (L1 in-process + L2 distributed) and multi-region topologies; reasons precisely about consistency models (eventual, quorum, CAS, CRDTs); discusses CDC-based invalidation vs. TTL trade-offs; quantifies hit rate, memory budget, and NIC/CPU saturation per node; addresses operational concerns like rolling upgrades, key migration during scale-out, and chaos testing. Can name concrete systems (Dynamo, Cassandra, Redis Cluster, mcrouter, Twemproxy) and articulate why each made the choices it did. |
