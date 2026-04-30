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
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

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

## 🧒 Layman's Explanation

Imagine you have a friend who watches the grocery store flyer for you every single week. The moment your favorite cereal hits $2.99, they text you: "buy now!" You no longer have to manually walk past 50 different stores checking shelf prices. That friend, scaled up to the entire internet, is a **price tracking service**. CamelCamelCamel and Honey are the most famous examples — they watch product pages on Amazon (and other retailers) and tell you when something on your wishlist drops below the price you're willing to pay.

Another way to think about it: there are services like Yahoo Finance that show you the historical chart of a stock's price. A price tracker is the same idea, but for consumer goods. You can pull up a chart and see whether Amazon's "Big Sale!" banner is genuine or whether the listed price is actually higher than it was last month — a notorious trick retailers play. It's also a bit like a weather alert system, except the storm front you're watching is "Sony headphones dropped below $250."

Under the hood, several things have to work together:
- **Web scraping:** the service visits Amazon and Walmart product pages on a schedule and pulls the price out of the HTML. It has to look like a real browser and respect rate limits so the retailer doesn't slam the door shut.
- **Smart scheduling:** popular items get checked hourly; obscure items get checked once a day. Hot products earn more attention because that's where users are watching.
- **Storage:** millions of products multiplied by years of history is a tidal wave of data points, so the service uses a time-series database optimized for that shape.
- **Alerts:** when the price crosses your target, an email or push notification fires.
- **Anti-bot detection:** Amazon does not love being scraped. CAPTCHAs, rate limits, and IP rotation become a daily battle.
- **Browser extension:** install a plugin and the historical price chart appears inline on the product page itself, so you can decide right there whether to buy.

### When the analogy breaks down

A flyer-watching friend is purely passive — they read the prices, you decide. Real services like Honey do far more: they integrate directly with the checkout page to auto-apply coupon codes, recommend cashback offers, and even detect dynamic pricing where Amazon shows *you* a different price than it shows your neighbor. That kind of personalized-pricing detection requires comparing prices across many users in real time, which is a significantly harder problem than simply watching a single product page on a schedule.

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

Amazon aggressively rate-limits scrapers, so the scraper fleet is the most sensitive and operationally expensive component. Getting blocked is a business-ending failure; a thoughtful politeness architecture is non-negotiable.

- **URL frontier:** Redis sorted set keyed by `next_scrape_at`; workers atomically pop due jobs via `ZPOPMIN`, attempt the fetch, and reschedule based on observed update frequency. The sorted set doubles as a priority queue — a product with an active watcher gets a lower score (sooner next_scrape_at) than an unwatched one.
- **Per-domain token bucket:** even though we target one marketplace, we shard the rate-limit bucket by `(hostname, egress_ip)` to stay under polite limits. A central Redis token bucket per egress IP enforces a configurable ceiling (e.g., 2 req/sec/IP). Workers check-and-decrement atomically with a Lua script before dispatching.
- **Proxy pool with health tracking:** residential and data-center proxies are rotated per job. A central `Proxy Health` service marks an IP dirty when it receives a CAPTCHA, 429, or 403, and puts it in a cooldown queue for a configurable period (e.g., 2–6 hours). Workers request a healthy proxy from the pool and never hold a reference beyond a single request — dirty proxies cannot be reused accidentally.
- **Distributed politeness management:** a single scraper process enforcing rate limits is a single point of failure. At scale, each worker pod checks out a token from a shared Redis token bucket before firing a request. This distributes politeness enforcement across the fleet while keeping a global rate limit enforced correctly — no thundering herds when the scheduler releases a batch of due jobs simultaneously.
- **Header and fingerprint rotation:** besides IP rotation, production scrapers vary `User-Agent`, `Accept-Language`, `Accept-Encoding`, and HTTP/2 ALPN settings across a curated profile library that mirrors real browser distributions. A static User-Agent string is detected and blocked within hours.
- **Headless browser only when needed:** 90% of product pages can be parsed from static HTML; pages that require JS (dynamic variant prices, lazy-loaded offers) are sent to a smaller Playwright farm. The headless farm is expensive — route to it only after a static parse fails to find a price.
- **CAPTCHA handling:** when a CAPTCHA is encountered, the request is queued for one of two paths: (a) route to a headless browser that can solve JS-based challenges like reCAPTCHA v3; (b) forward to a third-party CAPTCHA-solving service for image-based ones. Both paths add latency (seconds to minutes), so a CAPTCHA hit on a product marks it for delayed retry rather than blocking the worker.
- **Parse robustness and versioning:** DOM selectors change without warning. Parsers are versioned, each sample carries a `parser_version` field, and a canary job continuously scrapes a golden set of 1,000 products and alerts on-call when parse success rate drops below a threshold. Multiple parser versions can be in production simultaneously during a rollout.
- **robots.txt and ToS compliance:** we cache `robots.txt` per domain (TTL: 1 hour) and hard-block any disallowed paths. The scraper attaches a descriptive `User-Agent` with a contact email, both as courtesy and as legal cover.

### 2. Price Sample Deduplication

Raw samples arrive from three independent sources — scrapers (retried on failure), the Chrome extension (many users may report the same product seconds apart), and an optional affiliate API. Without dedup, the TSDB balloons, historical charts show false volatility, and alerts flap on noise.

- **Idempotency key on ingest:** before writing to Kafka, the Ingest API stamps each sample with a content hash `sha256(product_id + variant_id + price_cents + minute_bucket)`. Downstream, the Sample Processor uses this hash as a Kafka message key, which guarantees same-keyed messages land on the same partition and can be deduplicated by a compacted topic or in-memory state.
- **Short-window exact dedup in Sample Processor:** a Redis set `dedup:{product_id}:{price_cents}:{minute_bucket}` with a 15-minute TTL drops in-flight duplicates. The set uses `SETNX` — if the key already exists, the sample is discarded without writing to TSDB.
- **No-op dedup (change-data-only storage):** if `new_price == last_stored_price` and `availability` matches, we update `last_seen_at` on the most recent row in-place and skip inserting a new row. This keeps the time series sparse — only genuine price changes generate new rows. For a stable commodity checked hourly, this can reduce row volume by 95%+.
- **Quorum on untrusted sources:** an extension-reported price is marked `confidence=tentative` until corroborated. Corroboration happens when (a) two independent users report the same value within 10 minutes, or (b) the next scheduled scrape confirms it. A tentative sample does not trigger alert evaluation — it only promotes to `confirmed` when corroboration arrives or the scheduled scrape agrees.
- **Variant collapsing:** a product can have dozens of variants (color, size, storage tier) with independent price histories. We dedup and store per `(product_id, variant_id)`, never collapsing a variant's price into its parent product row.
- **Price error quarantine:** a sample more than 80% below the product's 30-day minimum is flagged as a potential data error and written to a `quarantine` partition of the Kafka topic. A separate reviewer job re-examines quarantined samples after 30 minutes — if the next scheduled scrape confirms the low price, it is promoted to confirmed; otherwise it is discarded. This prevents a $1 mis-listed price from triggering millions of alerts.

### 3. Scraper Scheduling and Prioritization

We cannot scrape 500M products uniformly — budget, proxy health, and the marketplace's anti-bot tolerance all impose hard ceilings. Smart scheduling multiplies effective freshness per dollar.

- **Tier by demand:** tier A = any product with at least one active watcher (target re-scrape interval: ~15 minutes). Tier B = popular products in the top-N by page views, without active watchers, kept warm for chart freshness (~6 hours). Tier C = long-tail products tracked once or rarely seen (~24 hours). Tier assignment is re-evaluated hourly as watcher counts change.
- **Adaptive frequency based on volatility:** products whose price has not changed in 30 days have their interval exponentially stretched — up to a per-tier cap (e.g., 4× the base interval). A detected change resets the interval to the tier floor immediately. This alone can reduce scraper load by 10–100× for stable catalog items while preserving freshness where it matters.
- **Change hinting from extension signals:** when a Chrome extension user visits a product page and the reported price differs from the last stored price, the Sample Processor emits a `change_hint` event. The scheduler immediately promotes that product to an urgent re-scrape slot, ahead of its scheduled time, to either confirm or refute the change with an authoritative scraper sample.
- **Sharded frontier with backpressure:** the URL frontier is partitioned by `hash(product_id) % N` into N Redis sorted sets. Each shard is consumed by a dedicated worker group, bounding per-shard memory and isolating failure (a poisoned shard doesn't affect others). When per-shard queue lag exceeds a threshold (scrapers can't keep up), tier C jobs for that shard are skipped for the current cycle before any tier A job slips.
- **Cycle completion telemetry:** the scheduler tracks "cycle time" — how long it takes to visit every active tier-A product once. This is a key SLO metric. If cycle time drifts above 30 minutes, the on-call alert fires and the operator either adds proxy capacity or temporarily degrades tier B.
- **Immediate re-scrape on watcher creation:** when a user creates a watcher for a product not currently in tier A, the scheduler promotes it immediately rather than waiting for the next scheduled slot. Users expect to see a fresh price when they first add a watch.

### 4. Alert Matching and Fan-out

When a `price_change` event lands, we must find every user watching that product, evaluate their individual target prices, and deliver notifications — correctly, exactly once, and without melting the notification service during a flash sale that moves a popular product.

- **Watcher index in Redis:** `watchers:{product_id}` is a sorted set where the score is `target_price_cents` and the member is `watcher_id`. On a `price_change` event, `ZRANGEBYSCORE watchers:{product_id} 0 {new_price}` returns every watcher whose target is at or above the new price — in O(log N + K) time. This is an inverted index lookup, not a full table scan. Updating the index on watcher creation/deletion is O(log N).
- **Alert evaluation is a hot path — keep it O(1) per sample:** at millions of products with daily price movements, the alert matcher must process events without per-event database queries. The Redis sorted-set index is the key — it eliminates the DB round-trip for the common case. Only after identifying triggered watchers does the service touch Postgres (to load delivery preferences).
- **Distinguishing price drops from price errors:** a product that drops 90% in 5 minutes and recovers is almost certainly a mis-listing. Before triggering alert delivery, require: (a) the price has been below the target continuously for at least 30 minutes; (b) the price is within a plausible range of the product's historical minimum (e.g., not below 20% of the 90-day min). If either check fails, the alert is deferred — checked again on the next sample. This prevents trust-destroying false positives from transient retailer errors.
- **Per-user coalescing:** a flash sale might generate 10 price-change events for the same product within a 5-minute window as variants update. A user who watches three variants would receive 30 notification attempts without coalescing. A 5-minute coalesce window per `(user_id, product_id)` collapses all events into one notification carrying the lowest observed price in the window.
- **Idempotent delivery via outbox pattern:** the alert record and the outbox delivery record are written to Postgres atomically in the same transaction. A separate delivery worker reads the outbox, sends the notification, and marks it delivered. If the worker crashes after sending but before marking, it retries — the notification service deduplicates by `(alert_id, delivery_channel)` at the receiver. Without this, a service restart during a big sale can send thousands of duplicate emails.
- **Delivery tiers by channel:** push and in-extension badge are dispatched immediately via a real-time worker pool. Email is batched into 5-minute digest windows. SMS is behind stricter per-user quotas and sent only if the user has explicitly opted into SMS. Slow channels (email, SMS) do not block fast channels (push).
- **Cooldown after trigger:** once an alert fires for a watcher, the watcher enters a 24-hour cooldown or until the price rises and re-drops (i.e., the price must exceed the target before it can trigger again). Without cooldown, a price hovering at exactly the target triggers a new alert on every scrape cycle.

### 5. Price History Storage

Price samples are the largest dataset in the system and the one with the most unforgiving read pattern: time-range scans keyed by a single product, across millions of products, with retention requirements of years.

- **Append-only schema — never update, only insert:** price samples must be treated as immutable facts: `(product_id, observed_at, price_cents, currency, availability, source)`. There is no such thing as "correcting" a historical price — if a sample was erroneous, it is marked with a `flagged` boolean and excluded from chart queries, but the row remains. This makes the table insert-only, which is ideal for time-series engines.
- **Not a vanilla RDBMS at scale:** 500M products × daily samples = billions of rows per year. Postgres with a B-tree index on `(product_id, observed_at)` degrades badly past a few hundred million rows. TimescaleDB (a Postgres extension) is the default choice: it keeps SQL ergonomics, supports continuous aggregates, and handles weekly hypertable chunks with transparent chunk pruning on range queries. ClickHouse is the alternative for heavier analytical workloads (e.g., "find all products that hit a new 90-day low today").
- **Hypertable schema:** `price_samples` is a hypertable partitioned by `observed_at` (weekly time chunks) and space-partitioned by `hash(product_id)` across N shards. Time-range queries for a single product access only the relevant chunks; old chunks are pruned without touching active data.
- **Change-data-only storage to reduce volume:** only write a new row when the price or availability actually changes. For a product whose price is stable for 30 days and scraped hourly, this suppresses ~720 redundant rows and stores 1. Combined with the no-op dedup in the Sample Processor, this can reduce TSDB write volume by 10–50× depending on catalog volatility.
- **Compression on closed chunks:** chunks older than 7 days are compressed with columnar encoding (TimescaleDB native or ClickHouse's LZ4/ZSTD). Price columns (integers, high repetition) compress 10–20×. Storage cost for a billion rows drops from ~100 GB to ~5–10 GB.
- **Continuous aggregates for chart performance:** precomputed daily `min/max/avg` per product are maintained as materialized views (TimescaleDB continuous aggregates). Chart requests for ranges > 90 days read the daily aggregate table; short-range requests (last 7 days) read raw samples. The query router in the History Service selects the right table automatically based on the requested range and granularity.
- **Retention tiers:** raw samples for 90 days in the hot TSDB cluster. Daily aggregates retained indefinitely in the same cluster. Monthly aggregates exported to Parquet on S3 for deep history, queryable via Trino or Athena when needed. The tiering policy is enforced by a nightly job that exports and drops old raw chunks.
- **Hot path cache:** the current price plus the last 7 days of raw samples for the top-N popular products live in Redis (sorted set keyed by `observed_at`), with TTL refreshed on every write. The History Service checks Redis before touching TSDB for any product in the hot set.
- **Currency storage discipline:** prices are always stored in the retailer's native currency. Never convert on write. The History Service converts for display at query time using a daily exchange rate table. Historical charts always show the native currency with a label — retrospective conversion distorts the chart as exchange rates shift.

### 6. Chrome Extension Ingest and Trust

The extension is a force multiplier for freshness: real users naturally visit product pages, so we can piggyback a crowd-sourced real-time price signal at zero scraping cost. The challenge is that extension-reported prices are untrusted — a malicious or buggy client can submit arbitrary values.

- **Client-side signing with short-lived JWTs:** the extension authenticates with the API using a JWT tied to the user's account, rotated every hour. The ingest endpoint enforces per-user rate limits (e.g., 60 samples/user/hour) and per-product rate limits (e.g., 5 samples/product/user/hour). Rate-limited submissions are silently dropped with a 202 — the client does not need to know it was throttled.
- **Server-side sanity validation:** the ingest API checks that the submitted `price_cents` is within ±80% of the last known price for that product. Outliers — which could be spoofing attempts, parser bugs in the extension, or currency mismatches — are written to a quarantine topic rather than the main `raw_samples` topic. Quarantined samples are reviewed asynchronously and do not influence charts or alerts.
- **Quorum before promotion:** a single extension submission, even from a trusted user, is marked `confidence=tentative`. It becomes `confirmed` only when (a) two independent users report the same price within 10 minutes, or (b) the next scheduled scraper run agrees. Alert evaluation always requires a `confirmed` sample — tentative samples are visible in the chart for transparency but cannot trigger notifications.
- **Feedback loop to the scraper scheduler:** when an extension sample disagrees with the last stored scraper price by more than 5%, the Sample Processor emits a `change_hint` event. The Scraper Control Plane promotes the product to an immediate re-scrape. This turns the extension into a real-time "something changed" signal that keeps the scraper focused on live price movements without expanding the scraper budget.
- **Trust score per user:** over time, each user accumulates a trust score based on the historical accuracy of their submissions (fraction confirmed by scraper). High-trust users require only one submission for promotion; low-trust users require a higher quorum threshold. Users who repeatedly submit implausible values have their extension ingest silently disabled without account action.

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

## Insider Tips and Tricks

### Scraping at Scale Requires Distributed Politeness Management

A single scraper hitting Amazon's product pages every minute will be rate-limited or blocked within hours. Production scrapers: (1) distribute requests across a rotating pool of residential proxies; (2) respect per-domain rate limits (configurable requests/second per domain); (3) vary User-Agent and request headers to mimic real browser behavior; (4) handle CAPTCHAs via headless browser rendering or third-party CAPTCHA-solving services. The scraper fleet is a first-class infrastructure concern, not an afterthought.

### Product Identity Across Retailers Is an Unsolved Problem

Tracking "iPhone 15 Pro 256GB Natural Titanium" across Amazon, Best Buy, and Walmart requires knowing these are the same product. There's no universal product ID. Approaches: (1) UPC/EAN barcode (works if all retailers expose it — most don't); (2) GTIN from structured data (increasingly available); (3) ML-based title similarity matching (brittle for accessories). Most price trackers only compare a product to itself (same URL) or manually curated equivalents, not automatic cross-retailer matching.

### Price History Is Append-Only Time-Series Data

Price samples should never be updated — only appended. `(productId, scrapedAt, price, availability, currency)` is the schema. Querying price history ("show me the last 90 days") on a relational DB with millions of products × daily samples = hundreds of millions of rows. Use TimescaleDB (Postgres extension) or ClickHouse for columnar time-series storage. For long-tail products with infrequent price changes, only write a new row when the price changes (change-data-only storage) to reduce volume.

### Alert Evaluation Is a Hot Path — Must Be O(1) per Price Sample

When a new price sample arrives, you must find all users who have alerts on this product with a target price above the current price. A naive `SELECT * FROM alerts WHERE product_id = ? AND target_price >= ?` is fine for small scale. At millions of products × millions of users, use a precomputed inverted index: `productId → sorted list of (target_price, userId)` stored in Redis. A binary search on this sorted list finds all triggered alerts in O(log N). Update the index when alerts are created/deleted.

### Distinguish Price Drops from Price Errors

Retailers sometimes enter incorrect prices (e.g., $1 for a $1000 product) and correct them within hours. Alerting users to a price error that gets reversed in 2 hours destroys trust. Strategies: (1) require the price to be below threshold for a minimum duration (e.g., 30 minutes) before triggering alerts; (2) sanity-check against the product's historical price range (alert only if price is within X% of the historical minimum, not an implausible outlier); (3) use the product's price-to-historical-minimum ratio as a confidence score.

### Scheduled Scraping Frequency Must Adapt to Price Volatility

A product whose price never changes (stable commodity) wastes scraper capacity if checked every 15 minutes. A product whose price changes 5 times a day should be checked more frequently. Adaptive scheduling: maintain a "price volatility score" per product (standard deviation of recent price samples). High-volatility products scrape every 15 minutes; stable products scrape every 24 hours. This reduces scraper load by 10-100× while preserving freshness for relevant products.

### Alert Delivery Must Be Idempotent

If a price alert fires and the alert delivery service crashes before marking the alert as sent, it will re-fire on restart — the user gets duplicate emails. Use an outbox pattern: write the alert delivery record to the DB atomically with the "alert_triggered" event. A separate consumer processes deliveries idempotently (check if already sent by alert_id + trigger_time before sending). Without idempotency, users leave your service when they receive 50 duplicate emails at 3am.

### Price Display Must Handle Currency Correctly

A tracked product's price in USD should not be displayed as-is to a user in Europe whose baseline comparison is in EUR. Store prices in the currency returned by the retailer (always) and convert for display (never for storage). Maintain a daily exchange rate table. Historical price charts should show prices in a consistent currency (the retailer's native currency) with a note, not retrospectively converted — exchange rate changes would distort the chart.

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
