# Design Facebook News Feed

> **Pattern**: Fan-out / Feed Aggregation
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/fb-news-feed)

---

## Table of Contents

- [Understanding the Problem](#understanding-the-problem)
  - [Functional Requirements](#functional-requirements)
  - [Non-Functional Requirements](#non-functional-requirements)
- [Core Entities](#core-entities)
- [API Design](#api-design)
- [High-Level Design](#high-level-design)
- [Deep Dives](#deep-dives)
  - [1. Heavy Follower Lists (Fan-out on Read)](#1-heavy-follower-lists-fan-out-on-read)
  - [2. Celebrity / High-Follower Accounts (Fan-out on Write)](#2-celebrity--high-follower-accounts-fan-out-on-write)
  - [3. Viral Post Reads (Hot Partitions)](#3-viral-post-reads-hot-partitions)
- [Scaling Journey: 0 → ∞](#scaling-journey-0--)
  - [Stage 1: 0 – 100 Users (MVP)](#stage-1-0--100-users-mvp)
  - [Stage 2: 100 – 1,000 Users (Early Growth)](#stage-2-100--1000-users-early-growth)
  - [Stage 3: 1K – 100K Users (Product-Market Fit)](#stage-3-1k--100k-users-product-market-fit)
  - [Stage 4: 100K – 10M Users (Scale-Out)](#stage-4-100k--10m-users-scale-out)
  - [Stage 5: 10M – 2B+ Users (Hyperscale)](#stage-5-10m--2b-users-hyperscale)
- [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

Facebook News Feed delivers a personalized, reverse-chronological stream of posts from the accounts a user follows. The challenge is doing this for ~2B users with sub-second latency, despite massively uneven follower counts (from 0 to hundreds of millions).

### Functional Requirements

**In scope:**
1. Users can create posts
2. Users can follow/friend other users
3. Users can view a feed of posts from accounts they follow, in reverse chronological order
4. Feed supports pagination

**Out of scope:** likes, comments, privacy controls, ranking/recommendation.

### Non-Functional Requirements

1. **High availability** over strong consistency — up to 1 minute of staleness is acceptable
2. **Low latency**: < 500ms for both post creation and feed retrieval
3. **Scale**: 2B users, no cap on follow relationships
4. **Read-heavy** workload (feed views >> posts created)

---

## Core Entities

| Entity | Description |
|---|---|
| **User** | An individual participant in the system |
| **Follow** | Uni-directional edge from `userFollowing` → `userFollowed` |
| **Post** | Content authored by a user, visible to their followers |

---

## API Design

```
POST /posts
  body: { content }
  → { postId }

PUT /users/{id}/follow          # idempotent
  → 200 OK

GET /feed?pageSize={n}&cursor={timestamp?}
  → { posts: [...], nextCursor }
```

Cursor-based pagination uses the oldest post's creation timestamp so feeds remain stable as new posts arrive at the top.

---

## High-Level Design

**Post creation path:**
- Client → Load Balancer → stateless Post Service → DynamoDB (`posts` table)

**Follow graph:**
- `Follows` table with primary key `(userFollowing, userFollowed)`
- GSI on `(userFollowed, userFollowing)` for reverse lookups (who follows me?)

**Naive feed read:**
1. Look up everyone the user follows
2. Fetch recent posts from each
3. Merge, sort by timestamp, paginate

This works at small scale but explodes when a user follows thousands of accounts — that's where the deep dives come in.

---

## Deep Dives

### 1. Heavy Follower Lists (Fan-out on Read)

**Problem:** A user who follows 5,000 accounts triggers 5,000 sub-queries per feed load.

**Solution — Precomputed Feeds (Fan-out on Write):**
- Maintain a `UserFeed` table keyed by `userId`, storing ~200 most-recent post references
- On post creation, async workers push the post into each follower's feed
- Storage: ~200 posts × ~100 bytes × 2B users ≈ 4TB total (very manageable)
- Reads become a single key lookup

### 2. Celebrity / High-Follower Accounts (Fan-out on Write)

**Problem:** When a user with 100M followers posts, precomputation would require 100M writes.

**Solutions:**
- **Async queueing**: SQS + worker fleet absorbs bursts; eventual consistency within the stated 1-min staleness budget
- **Hybrid model**: Skip precomputation for mega-accounts. Instead, on feed read, merge the user's own precomputed feed with a small live query against the mega-accounts they follow. Trades a tiny read-time cost for massive write savings.

### 3. Viral Post Reads (Hot Partitions)

**Problem:** A single viral post creates a hot key — one DB partition gets hammered.

**Solutions:**
- **Distributed cache (Redis)** in front of the DB with LRU eviction
- **Replicated (not sharded) cache**: multiple cache replicas behind a load balancer so the viral key's traffic is spread across nodes rather than concentrated on one shard

---

## Scaling Journey: 0 → ∞

How architecture evolves as the user base grows. Each stage adds complexity *only when the previous stage breaks* — premature scaling is the #1 failure mode for early products.

### Stage 1: 0 – 100 Users (MVP)

**Goal:** Ship fast, validate the product.

**Architecture:**
- Single monolithic app server (e.g., Node/Django/Rails on one EC2 instance or Fly/Render/Railway)
- One Postgres instance with tables: `users`, `follows`, `posts`
- Feed query is a simple SQL join:
  ```sql
  SELECT * FROM posts
  WHERE author_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)
  ORDER BY created_at DESC LIMIT 20;
  ```
- Static assets via CDN (CloudFront / Cloudflare)

**What you skip:** caching, queues, replication, precomputation. SQL can comfortably handle this.

**Failure mode that pushes you to Stage 2:** DB CPU starts spiking on feed reads as follow graph densifies.

---

### Stage 2: 100 – 1,000 Users (Early Growth)

**Goal:** Handle 10x traffic without downtime.

**Changes:**
- **Add an index** on `posts(author_id, created_at DESC)` — turns the feed query from a scan into a seek
- **Read replica** for Postgres: route feed reads to the replica, keep writes on primary
- **Cache hot data**: Redis for session tokens and user profile lookups (not feeds yet)
- **Managed load balancer** (ALB/NLB) in front of 2 app server instances for redundancy
- **Structured logging + metrics** (Datadog/Grafana) — you can't scale what you can't measure

**What you skip:** precomputed feeds, message queues, sharding. Still too early.

**Failure mode that pushes you to Stage 3:** feed query p99 creeps past 500ms as follow counts grow.

---

### Stage 3: 1K – 100K Users (Product-Market Fit)

**Goal:** Consistent sub-500ms feeds under real load.

**Changes:**
- **Introduce precomputed feeds** for active users: a `user_feed` Redis sorted set per user (score = timestamp), capped at ~200 entries
- **Async fan-out on post create**: enqueue a job (SQS/Celery/BullMQ) → worker writes the post ref into each follower's sorted set
- **Move posts to a dedicated service** (first step toward microservices) — Post Service, Follow Service, Feed Service, all still sharing infra
- **CDN for user-uploaded media**, signed URLs to origin S3
- **Postgres** still primary store of truth; Redis is the read layer

**Why now:** The fan-out-on-write cost is small (avg follower count is still modest), and it lets feed reads become O(1) cache lookups.

**Failure mode that pushes you to Stage 4:** some users now have 10K+ followers and posting becomes slow; Redis memory footprint grows.

---

### Stage 4: 100K – 10M Users (Scale-Out)

**Goal:** Horizontal scalability on every tier.

**Changes:**
- **Shard the primary datastore**: move from Postgres to a partitioned store (DynamoDB, Cassandra, or sharded Postgres via Citus). Partition key = `userId` for posts and follows.
- **Shard Redis** by `userId` (Redis Cluster) so feed storage scales linearly
- **Dedicated feed-fanout worker fleet** — autoscales on queue depth
- **Hybrid fan-out starts here**: identify top-N users by follower count (>100K) and exclude them from precomputation. Their posts are pulled live at read time and merged.
- **Multi-AZ deployments** for all stateful tiers; async cross-region replication for DR
- **Schema/API versioning** becomes non-negotiable — you can't coordinate deploys across this many services otherwise

**Failure mode that pushes you to Stage 5:** a viral post generates 1M reads/sec against a single partition; write amplification on fan-out saturates workers.

---

### Stage 5: 10M – 2B+ Users (Hyperscale)

**Goal:** Operate at Facebook scale.

**Changes:**
- **Replicated cache for viral content**: multiple Redis replicas behind an LB for the hottest keys — spreads load across nodes, not just partitions
- **Edge-side caching** of public post metadata via CDN with short TTLs
- **Multi-region active-active**: users read/write to the nearest region; cross-region replication for the social graph with conflict resolution (last-writer-wins or CRDTs for counters)
- **Tiered storage**: hot posts in memory/SSD, warm in standard storage, cold (>N days old) in cheaper archival tiers
- **ML-driven feed ranking layer** replaces pure reverse-chron (out of scope here but shows up at this scale)
- **Capacity planning as a discipline**: dedicated SRE org, load-shedding and graceful degradation (e.g., serve stale feed if the fanout worker fleet is backed up)
- **Batched writes** for fan-out: a celebrity post becomes a tree of batched worker jobs rather than per-follower writes

**Key insight at this stage:** every architectural decision is a trade-off between *availability*, *staleness tolerance*, and *cost*. The 1-minute staleness budget in the NFRs is what makes most of this tractable — strong consistency here would be prohibitively expensive.

---

## Expected Depth by Level

| Level | Breadth / Depth | Focus |
|---|---|---|
| **Mid** | Breadth-first | Complete API + data model + working high-level design; surface familiarity with components |
| **Senior** | ~60/40 | Proactively surface the fan-out problem; discuss trade-offs (read vs. write fan-out, hybrid) |
| **Staff+** | ~40/60 | Cover all three deep dives with real-world tuning (cache replication strategy, worker backpressure, regional topology); minimal interviewer steering |
