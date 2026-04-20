# Design Price Tracking Service (CamelCamelCamel)

> **Pattern**: Scraping / Time-series / Alerting
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/camelcamelcamel)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   - [1. Scraping Strategy and Politeness](#1-scraping-strategy-and-politeness)
   - [2. Price Sample Deduplication](#2-price-sample-deduplication)
   - [3. Scraper Scheduling and Prioritization](#3-scraper-scheduling-and-prioritization)
   - [4. Alert Matching and Fan-out](#4-alert-matching-and-fan-out)
   - [5. Price History Storage](#5-price-history-storage)
   - [6. Chrome Extension Ingest and Trust](#6-chrome-extension-ingest-and-trust)
6. [Scaling Journey: 0 to infinity](#scaling-journey-0--)
7. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A price tracking service (in the spirit of CamelCamelCamel) lets users look up the historical price of a product on a marketplace like Amazon, and subscribe to notifications when the price drops below a chosen threshold. The hard parts are not the UI or the alert logic but the data pipeline behind them: discovering and re-scraping hundreds of millions of products politely, deduplicating noisy price samples, and fanning alerts out quickly when a price finally moves.

### Functional Requirements

**In scope:**
1. A user can search for a product and view its full price history as a chart.
2. A user can "watch" a product, optionally setting a target price; the service notifies them (email, push, extension badge) when the price drops to or below that target.
3. The service continuously collects fresh price samples for tracked products.
4. A Chrome extension shows price history inline on the marketplace product page.

**Out of scope:**
1. Buying / affiliate checkout flows.
2. Cross-marketplace comparison (we focus on one marketplace, e.g. Amazon).
3. Review or rating aggregation.
4. Inventory or seller tracking beyond the headline price.

### Non-Functional Requirements

1. **Catalog scale:** roughly 500M products in the marketplace; at steady state we track the subset that at least one user cares about plus a "popular" long tail we pre-warm.
2. **User scale:** ~1M active Chrome extension users; 10s of millions of cumulative watchers.
3. **Freshness:** a price change should result in a user notification within ~1 hour.
4. **Read latency:** price-history chart for a product returns in <500ms p99.
5. **Availability over consistency:** eventually consistent samples are fine; the chart can lag by minutes.
6. **Politeness:** scrapers must respect `robots.txt`, per-domain rate limits, and avoid getting the IP pool banned.
7. **Storage footprint:** price samples are time-series data; we optimize for write throughput and compressed retention rather than per-row mutability.

---

## Core Entities

| Entity | Fields | Notes |
|---|---|---|
| **Product** | `product_id` (PK, canonical marketplace ID like ASIN), `title`, `category`, `image_url`, `last_seen_at`, `tracked_rank` | Slow-changing metadata; scraped from product page. |
| **PriceSample** | `product_id`, `observed_at` (timestamp), `price_cents`, `currency`, `availability`, `source` (scraper / extension), `variant_id` | Immutable time-series row. Compound key on (`product_id`, `observed_at`). |
| **Watcher** | `watcher_id` (PK), `user_id`, `product_id`, `target_price_cents` (nullable), `created_at`, `active` | One per (user, product, variant) subscription. |
| **Alert** | `alert_id` (PK), `watcher_id`, `triggered_at`, `price_cents`, `delivery_channel`, `delivery_status` | Write-once log of what was sent, for idempotency and history. |
| **User** | `user_id`, `email`, `push_token`, `timezone`, `quiet_hours` | Standard account entity; minimal here. |

---

## API Design

```http
# Search for a product by free text or marketplace URL
GET /products/search?q=sony+wh-1000xm5
-> 200 { "results": [{ "product_id": "B09XSC5X4K", "title": "...", "current_price_cents": 29900 }, ...] }

# Full price history for a product (optional time range, optional granularity)
GET /products/{product_id}/history?from=2025-01-01&to=2026-04-20&granularity=day
-> 200 { "product_id": "...", "samples": [{ "t": "2025-01-01", "p": 34900 }, ...], "min": 24900, "max": 39900 }

# Create a watcher (optionally with a target price)
POST /watchers
Body: { "product_id": "B09XSC5X4K", "target_price_cents": 25000 }
-> 201 { "watcher_id": "w_123" }

# List / delete watchers
GET    /watchers
DELETE /watchers/{watcher_id}

# Chrome-extension ingest: opportunistic price sample observed by the user's browser
POST /ingest/extension
Body: { "product_id": "B09XSC5X4K", "price_cents": 26499, "currency": "USD", "observed_at": "..." }
-> 202 Accepted
```

All write endpoints require an auth token; the extension ingest is authed but rate-limited per user to discourage spoofing (see Deep Dive 6).

---

## High-Level Design

```
                    +--------------------+
  Web / Extension   |   API Gateway      |-----> Auth / rate limit
  ---------------> |   (read + write)    |
                    +----------+---------+
                               |
           +-------------------+-------------------+-----------------+
           v                   v                   v                 v
   Product Service     Watcher Service     History Service    Ingest API
   (catalog / search)  (CRUD watchers)     (chart queries)    (extension samples)
           |                   |                   |                 |
           v                   v                   v                 v
       Postgres            Postgres        Time-series DB         Kafka
       (products,          (watchers,      (price_samples)   ("raw_samples" topic)
        metadata)           alerts)
                                                                      |
                                                                      v
                                                            +-----------------+
                                                            | Sample Processor|
                                                            | - dedup         |
                                                            | - validate      |
                                                            | - write TSDB    |
                                                            | - publish "price_change"
                                                            +--------+--------+
                                                                     |
                                                                     v
                                                            +-----------------+
                                                            | Alert Matcher   |
                                                            | (watcher index  |
                                                            |  in Redis)      |
                                                            +--------+--------+
                                                                     |
                                                                     v
                                                            Notification workers
                                                            (email / push / SMS)

  +--------------------------+
  | Scraper Control Plane    |
  |  - URL frontier          |  produces scrape jobs keyed by priority
  |  - per-domain politeness |
  |  - job scheduler         |
  +-----------+--------------+
              |
              v
  +--------------------------+        +--------------------------+
  | Scraper Workers          | ---->  | Proxy pool / headless    |
  | (fetch + parse)          |        | browser farm             |
  +-----------+--------------+        +--------------------------+
              |
              v
        Kafka "raw_samples"   (same topic as extension ingest)
```

Key flows:
- **Read path:** a chart request hits `History Service`, which queries the time-series DB, cached at Redis for hot products, returning downsampled buckets.
- **Scrape path:** `Scraper Control Plane` emits jobs; workers fetch, parse, and push samples to Kafka.
- **Alert path:** `Sample Processor` writes accepted samples to TSDB and emits a `price_change` event only when the new price differs from the last known price; `Alert Matcher` looks up watchers for that product and enqueues notifications.

---

## Deep Dives

### 1. Scraping Strategy and Politeness

Amazon aggressively rate-limits scrapers, so the scraper fleet is the most sensitive component.

- **URL frontier:** Redis sorted set keyed by `next_scrape_at`; workers pop due jobs, attempt the fetch, and reschedule based on observed update frequency.
- **Per-domain token bucket:** even though we target one marketplace, we shard the bucket by hostname + region to stay under polite limits (e.g. N requests / second / egress-IP).
- **Proxy pool:** residential and data-center proxies rotated per job; a central "health" service marks an IP dirty on a CAPTCHA/403 and cools it off for hours.
- **Headless browser only when needed:** 90% of product pages can be parsed from the static HTML; pages that require JS (dynamic variant price) are sent to a smaller Playwright farm.
- **Parse robustness:** DOM selectors change; parsers are versioned and each sample carries `parser_version`. A canary job runs a golden set of 1000 products and alerts when parse success rate drops.
- **robots.txt and ToS:** we respect `robots.txt`, attach a contact `User-Agent`, and avoid authenticated or geo-restricted pages.

### 2. Price Sample Deduplication

Raw samples come from three sources: scrapers (possibly retried), the extension (many users may report the same price seconds apart), and an affiliate API (if we have one). Without dedup the TSDB would balloon and alerts would flap.

- **Exact dedup:** inside the `Sample Processor`, a short-lived Redis set keyed `dedup:{product_id}:{price}:{minute_bucket}` drops duplicates from the last ~15 minutes.
- **No-op dedup:** if `new_price == last_stored_price` and both `availability` flags match, we update `last_seen_at` on the most recent row and skip inserting a new sample. This keeps the series sparse: only actual changes generate rows.
- **Quorum on untrusted sources:** an extension-reported price is only treated as ground truth if (a) two independent users report the same value within 10 minutes, or (b) the next scheduled scrape confirms it. Until then we store it as `source=extension, confidence=tentative`.
- **Variant collapsing:** a product has multiple variants (color, size); we dedup per `(product_id, variant_id)` because their prices move independently.

### 3. Scraper Scheduling and Prioritization

We cannot scrape 500M products uniformly; budget forces prioritization.

- **Tier by demand:** tier A = any product with at least one active watcher (re-scrape every ~15 minutes). Tier B = popular products without watchers, kept warm for chart freshness (~6 hours). Tier C = long-tail tracked-once products (~daily).
- **Adaptive backoff:** if a product's price hasn't changed in 30 days we exponentially stretch its interval up to a cap; a detected change snaps it back to tier A's cadence.
- **Change hinting:** extension samples feed a "probably changed" signal that promotes a product to immediate rescrape, even if its scheduled slot is far away.
- **Sharded frontier:** the scheduler partitions products by hash into N scheduler shards, each a Redis sorted set. Workers pull from a specific shard to bound memory and isolate failure.
- **Backpressure:** if the scraper pool is saturated (queue lag > threshold), tier C jobs are dropped this cycle before any tier A job slips.

### 4. Alert Matching and Fan-out

When a `price_change` event lands, we must find everyone watching that product and notify them quickly without melting the notification service.

- **Watcher index in Redis:** `watchers:{product_id}` -> sorted set of `{watcher_id: target_price_cents}`. On price change we `ZRANGEBYSCORE` to pull watchers whose `target >= new_price` in O(log N + K).
- **Per-user coalescing:** a burst of price changes (e.g. variant swaps causing multiple events within minutes) is coalesced per user in a 5-minute window to avoid notification spam. Coalesce key is `user_id:product_id`.
- **Idempotency:** each potential alert has a key `alert:{watcher_id}:{day}:{price_bucket}`. The notification worker uses `SETNX` before sending so a retry can never double-send.
- **Delivery tiers:** push and in-extension badge are near real-time; email is batched every 5 minutes. SMS is behind stricter quotas.
- **Cooldown:** once an alert fires for a watcher, the watcher is muted for 24 hours or until the price rises and re-drops, so the user isn't pinged every 15 minutes while the price hovers at the target.

### 5. Price History Storage

Price samples are the biggest data set in the system, and read patterns are skewed (chart queries are time-range scans for one product).

- **Not a vanilla RDBMS at scale:** 500M products x N samples/year would crush Postgres indexes. We use a time-series engine; TimescaleDB (Postgres extension) is a good default because it keeps SQL ergonomics. ClickHouse is an alternative for heavier analytical queries.
- **Schema:** hypertable `price_samples (product_id, observed_at, price_cents, currency, availability, source)` partitioned by `observed_at` (weekly chunks) and space-partitioned by hash(`product_id`).
- **Compression:** closed chunks (older than 7 days) are compressed with columnar encoding; typical 10-20x reduction on price columns.
- **Downsampling for charts:** continuous aggregates precompute daily min/max/avg per product. Chart requests for ranges > 90 days read the aggregate table; short ranges read raw.
- **Retention tiers:** raw samples for 90 days; daily aggregates forever; monthly aggregates mirrored to cheap object storage (Parquet on S3) for deep history.
- **Hot path cache:** the current price and the last 7 days of samples for popular products live in Redis, keyed by `product_id`, with TTL refreshed on every write.

### 6. Chrome Extension Ingest and Trust

The extension is a force multiplier for freshness: real users naturally visit product pages, so we can piggyback a real-time price signal at no scraping cost.

- **Client-side signing:** the extension sends a short-lived JWT tied to the user, with rate limits (e.g., 60 samples / user / hour).
- **Server-side validation:** the ingest API checks that `price_cents` is within a sanity range of the last known price (e.g., within +/- 80%); wild outliers are dropped or quarantined for review.
- **Quorum promotion:** as in Deep Dive 2, a `tentative` extension sample is promoted only with corroboration. Bad actors trying to spoof a price crash cannot move the chart alone.
- **Feedback loop:** if the extension sample disagrees with the most recent scrape, the product is promoted to an immediate rescrape to resolve the discrepancy.

---

## Scaling Journey: 0 to infinity

The story begins with a weekend project and ends with a hyperscale ingest platform. Each stage solves the failure mode that breaks the previous one.

### Stage 1: 0 - 100 Products Tracked

**Goal:** prove the loop works. A single developer can see a price chart.

**Architecture:**
- One Python process running a `cron` job every 30 minutes that fetches product URLs from a list and parses the price with BeautifulSoup.
- SQLite file stores `products`, `price_samples`, and `watchers` tables.
- Flask app serves the chart; renders with a templated line graph.
- Email alerts via SMTP directly in the cron script: after scraping, any watcher whose target is met triggers a `sendmail` call.

**What you skip:** proxies, queues, caches, TSDB, auth beyond a password, horizontal scaling, alert coalescing.

**Failure mode -> next stage:** at ~10k products the single cron process can't finish a full cycle within 30 minutes, and SQLite write contention blocks chart reads. We need concurrent scrapers and a real database.

### Stage 2: 100 - 10K Products

**Goal:** handle thousands of products with minutes-fresh prices and multi-user alerts.

**Architecture:**
- Replace the cron script with a worker pool (Celery or RQ) backed by Redis. A scheduler puts scrape jobs on the queue keyed by `product_id`; N worker processes consume.
- Move storage to managed Postgres. Separate tables for `products`, `price_samples` (indexed on `product_id, observed_at`), `watchers`, `alerts`.
- Add a `RobotsTxt` cache and a per-domain token bucket in Redis to avoid getting banned.
- Move alerting out of the scraper path: after insert, a Postgres trigger or an application-level check enqueues an `alert` job processed by a separate worker, so a slow mailer can't block scraping.
- API is now a small Flask/FastAPI service behind Nginx with Redis caching the "latest price" per product.

**What you skip:** distributed proxy pool, time-series DB, Kafka, alert coalescing beyond per-hour mute, multi-region.

**Failure mode -> next stage:** Amazon begins CAPTCHA-ing our egress IP; worker throughput plateaus. Postgres's `price_samples` table passes 100M rows and chart queries go from 50ms to 5s even with indexes. Scrape cycle slips past SLA.

### Stage 3: 10K - 1M Products

**Goal:** survive anti-bot defenses, keep chart queries fast, decouple ingest from alerting.

**Architecture:**
- Scraper fleet becomes a proper system: a `Scraper Control Plane` maintains the URL frontier in Redis sorted sets (sharded), enforces per-domain politeness, and dispatches to stateless worker pods.
- A rotating proxy pool (residential + data-center) with health tracking; bad IPs are cooled off automatically. A small headless-browser farm (Playwright) handles JS-heavy pages.
- Introduce Kafka as the ingest backbone. Both scrapers and the Chrome extension publish to a `raw_samples` topic. A `Sample Processor` consumer does dedup, validation, and writes to a time-series DB (TimescaleDB) with weekly chunks and compression on older data.
- The processor emits `price_change` events to a second Kafka topic; an `Alert Matcher` service consumes those, looks up watchers in a Redis index `watchers:{product_id}`, and enqueues notification jobs with idempotency keys.
- Price-history API reads TimescaleDB continuous aggregates for long ranges and raw samples for short ranges, with Redis caching the "latest price" and the last 7 days for hot products.

**What you skip:** multi-region active-active, custom time-series storage, ML-based change detection, aggressive price normalization across variants.

**Failure mode -> next stage:** TimescaleDB hits its single-node write ceiling; alert latency spikes during a big sale event because a single product can have millions of watchers.

### Stage 4: 1M - 100M Products

**Goal:** planet-scale ingest, bounded alert fan-out even on Black Friday.

**Architecture:**
- Shard the time-series storage by `hash(product_id)` across a cluster (Timescale multi-node or a move to ClickHouse). Writes fan out to the right shard; reads are routed by the History Service.
- Tiered retention: raw samples for 90 days in the hot TSDB cluster, daily aggregates retained forever, monthly aggregates exported to Parquet on S3 for cheap long tail, queryable via a lake engine (Trino/Athena) when needed.
- Alert fan-out becomes a two-stage pipeline. Stage one: `Alert Matcher` produces `(watcher_id, price)` tuples to a `matched_alerts` topic partitioned by `user_id`. Stage two: per-user coalescer (5-minute window) emits a single notification per user, batched across products. This collapses the 10M-watcher spike for a flash sale into an ordered, rate-limited stream.
- Scraper frontier is partitioned by region; regional worker pools reduce cross-region egress latency and improve proxy success rates.
- Chrome-extension ingest becomes a first-class signal with a trust score per user; high-trust users effectively crowdsource tier-A freshness for free.

**What you skip:** ML-based anomaly detection, pricing trends as a product, cross-marketplace.

**Failure mode -> next stage:** metadata catalog (`products` in Postgres) is groaning at 100M+ rows; Redis watcher index gets too big for a single cluster; we see enough data to want smarter change detection than "price != last price."

### Stage 5: 100M+ Products (Hyperscale)

**Goal:** tracker-as-a-platform, globally distributed, with intelligent change detection and tiered SLAs.

**Architecture:**
- Catalog moves to a sharded store (Vitess over MySQL, or CockroachDB) with search served by a dedicated Elasticsearch/OpenSearch cluster that indexes `title`, `brand`, `category`, plus a popularity signal.
- Watcher index is sharded Redis Cluster by `product_id`, with a secondary per-user index for "my watchers" reads. Cold watchers (not triggered for > 90 days) spill to Postgres to keep hot RAM small.
- Time-series layer splits into hot (ClickHouse / Timescale multi-node, last 90 days) and cold (Parquet on object storage, queried by Trino), fronted by a query router that picks the right tier per request and stitches results.
- Scraper control plane becomes a multi-region scheduler; each region owns a shard of product IDs and runs its own politeness budget. A global coordinator rebalances shards as traffic shifts.
- Change detection upgrades from "price != last price" to a lightweight statistical model per product that flags a change as significant given its volatility, seasonality, and variant structure. This suppresses noise from tiny rounding fluctuations and, conversely, catches hidden drops when a coupon changes the effective price.
- Alert delivery is fully coalesced: each user has a single "alert feed" stream (per channel), and the fan-out service blends price-drop alerts with other product events (back-in-stock, new-low) into a deduplicated digest respecting quiet hours and timezone.
- Cross-marketplace becomes viable: each marketplace is a pluggable scraper module feeding the same Kafka topic with a `marketplace` tag.

**What you skip:** nothing architectural; remaining work is operational (cost optimization, deeper ML, fraud on extension ingest, regulatory/ToS compliance per country).

---

## Expected Depth by Level

| Area | Mid-level | Senior | Staff |
|---|---|---|---|
| **Functional framing** | Lists the three obvious features (chart, watcher, alert). | Separates scraping and ingest as first-class requirements; scopes variants. | Frames as a time-series + alerting platform; asks about ToS, cost, and second-order products (trend data). |
| **Capacity math** | Back-of-envelope row count and QPS. | Works out samples/day, storage growth with dedup, peak alert fan-out per popular product. | Derives per-stage budgets (scraper RPS per proxy, TSDB write throughput, notifications/sec) and identifies the binding constraint. |
| **Scraping** | Mentions proxies and `robots.txt`. | Designs a URL frontier with per-domain token buckets and retry/backoff, and a parser versioning story. | Treats the scraper as a control plane: adaptive scheduling, tiered priorities, extension signals as crowd-sourced freshness, cost-aware proxy allocation. |
| **Deduplication** | Filters duplicate rows by key. | Handles extension vs scraper sources, quorum, no-op dedup to keep the series sparse. | Models trust per source, quarantines suspicious samples, cross-validates via rescrape, and prevents alert flapping. |
| **Storage** | Picks Postgres with an index on `(product_id, observed_at)`. | Chooses a time-series DB with continuous aggregates and retention tiers. | Designs hot/cold split with object-storage cold tier, sharding scheme, and query router that stitches across tiers. |
| **Alerting** | In-line alert check after each sample. | Separate alert matcher using a Redis watcher index, idempotency keys, cooldowns. | Two-stage coalesced pipeline, per-user windowing, delivery-tier SLAs, ML-based significance filter. |
| **Scaling** | Adds a cache and more workers. | Moves to Kafka + stateless services, shards the scraper frontier. | Multi-region active-active, tiered watcher index, change-detection model, and a path to cross-marketplace. |
| **Failure modes** | Notes retries. | Reasons about scraper bans, TSDB write pressure, and alert storms. | Discusses how each stage's bottleneck forces the next stage's architecture, and what telemetry (parse success, cycle completion, alert latency) drives the transitions. |
