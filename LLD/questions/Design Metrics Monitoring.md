# Design Metrics Monitoring System

> **Pattern**: Time-series / Telemetry
> **Difficulty**: Medium
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/metrics-monitoring)

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

A metrics monitoring platform collects numeric telemetry (CPU, memory, request latency, error rates, custom business counters) from a fleet of services, stores it as time-series, exposes it through interactive dashboards, and evaluates alert rules so on-call engineers are paged when something breaks. Think Datadog, Prometheus + Grafana, or CloudWatch. The distinguishing property is that the workload is append-heavy, timestamp-ordered, and dominated by aggregation queries over ranges, which is very different from a typical OLTP service.

### Functional Requirements

**Must have:**
1. **Ingest metrics** from thousands to millions of hosts. Each data point has a metric name, a timestamp, a numeric value, and a set of labels (service, instance, region, endpoint, status_code, etc.).
2. **Query and visualize** metrics on dashboards with filtering by label, aggregation (sum, avg, p95, p99, rate), and arbitrary time ranges from last minute to last month.
3. **Define alert rules** with thresholds over time windows, e.g., "page on-call if p99 latency for service=checkout exceeds 500ms for 5 consecutive minutes."
4. **Deliver notifications** to Slack, email, and PagerDuty when an alert fires, with deduplication and silence support.

**Out of scope:**
- Log aggregation and full-text search (that is a logs product).
- Distributed tracing, spans, and flame graphs.
- Anomaly detection via machine learning.
- Synthetic monitoring (probing endpoints from external regions).

### Non-Functional Requirements

**Must have:**
1. **Ingest scale** - 5M data points per second, roughly 500K hosts each emitting 100 metrics every 10 seconds. At ~100 bytes per point that is ~500 MB/s raw, and with labels/overhead closer to 1 GB/s wire traffic.
2. **Query latency** - dashboards loading day-long and week-long ranges must return within a few seconds (p95 < 3s for common panels).
3. **Alert latency** - end-to-end time from metric emission to alert firing must be under 1 minute. Alerts usually evaluate over a sliding window, so some delay is inherent.
4. **High availability** - ingestion must not drop points during node failures or spikes; dashboards can tolerate eventual consistency, but alerting must be reliable.
5. **Retention** - raw points kept for ~15 days, downsampled rollups kept for 1-2 years. Storage for raw alone at 1 GB/s is ~1.3 PB over 15 days, so retention policy and compression matter a lot.
6. **Multi-tenancy and isolation** - a noisy tenant emitting millions of unique label combinations should not degrade others (the cardinality problem).

**Assumptions:**
- Write:read ratio is roughly 100:1 by volume - most points are never queried.
- Out-of-order and late-arriving points are possible (network glitches, agent restarts) and must not crash the pipeline.

---

## Core Entities

| Entity | Purpose | Typical Store |
|---|---|---|
| **Metric** | A single data point: `(name, labels, timestamp, value)`. Example: `http_request_duration_ms{service="api", endpoint="/login", region="us-east"} 123 @ 2026-04-20T10:00:00Z`. | TSDB (hot, in-memory head) |
| **Time-Series** | The full ordered sequence of points that share a single unique `(name + label set)` combination. Identified by a series ID derived by hashing the label set. All storage and query optimization is built around this primitive. | TSDB on-disk blocks |
| **Alert Rule** | A declarative condition: a query expression, a comparison threshold, a window, and a `for` duration before firing. Owned by a team, routed to a notification channel. | Relational DB (Postgres) |
| **Alert Instance** | A concrete firing of a rule, tied to a specific label set (e.g., the alert fired for `service=checkout`, not for `service=search`). Has state `pending -> firing -> resolved`. | Alert manager state store |
| **Dashboard** | A JSON spec of panels, each containing a query expression, a visualization type, and refresh config. | Metadata DB / object store |
| **Rollup / Aggregate** | Pre-computed lower-resolution series (e.g., 1-minute and 1-hour points) used for long-range queries. | TSDB with separate retention policy |

The `(metric_name + label_set)` uniqueness is load-bearing. The count of distinct such combinations is the **cardinality** of the system, and almost every scaling problem downstream reduces to controlling it.

---

## API Design

The system has three surfaces: ingestion, query, and configuration.

**Ingestion (from agents on hosts):**
- `POST /v1/metrics` with a batch of points. Prometheus exposition format or Protobuf over HTTP/gRPC. Batches are the norm - a single agent sends hundreds of points per request to amortize overhead.
- Pull model alternative: the platform scrapes `GET /metrics` from each host at a fixed interval. Prometheus defaults to pull; Datadog/CloudWatch use push. Push scales better for serverless and ephemeral workloads; pull is easier to debug and self-healing on agent failure.

**Query (from dashboards and alert evaluators):**
- `GET /v1/query?expr=<promql>&time=<ts>` for instant queries.
- `GET /v1/query_range?expr=<promql>&start=<ts>&end=<ts>&step=<duration>` for time-series panels.
- The query expression is a PromQL-like language supporting selectors, aggregations, rate functions, and joins.

**Configuration (from the UI and Terraform):**
- `POST /v1/alert-rules` with `{ name, expr, for, threshold, severity, receivers }`.
- `GET /v1/alert-rules/{id}` and `PATCH` / `DELETE` for lifecycle.
- `POST /v1/dashboards`, `PUT /v1/dashboards/{id}`.
- `POST /v1/silences` to suppress alerts during known maintenance windows.

Ingestion endpoints are authenticated by per-tenant API keys; query and config endpoints by user sessions with RBAC on tenant and team scopes.

---

## High-Level Design

The system splits cleanly into four pipelines, each independently scalable:

**1. Ingestion path.** Host agents (Prometheus node_exporter, Datadog agent, or a custom sidecar) batch points and push to a load-balanced ingestion tier. The ingestion service validates, stamps a tenant ID, and writes to a durable buffer. The buffer exists for two reasons: it decouples write spikes from the TSDB, and it lets multiple downstream consumers (TSDB writer, stream aggregator, alert evaluator) read the same stream.

**2. Storage path.** A TSDB writer consumes from the buffer, builds in-memory chunks per series (typically 2-hour windows), compresses them, and flushes to disk. The write-heavy nature of the workload and the tight `(series_id + timestamp)` locality is why TSDBs use specialized on-disk formats with delta-of-delta timestamp encoding and Gorilla-style XOR value compression (10-20x better than general-purpose compression for typical metrics).

**3. Query path.** A query service parses the expression, resolves matching series via an inverted index on labels, fetches the relevant chunks, applies the aggregation, and returns the result. For long ranges it transparently routes to pre-aggregated rollups instead of raw data.

**4. Alerting path.** An alert evaluator periodically (every 10-30s) runs each rule as a query, tracks `pending` vs `firing` state per label set, applies the `for` duration, and hands firing alerts to an alert manager that handles grouping, deduplication, inhibition, silences, and delivery to Slack/PagerDuty/email.

```
         host agents (push or pull)
                  |
                  v
        +---------------------+
        |  Ingestion Service  |   validate, tag tenant, batch
        +---------------------+
                  |
                  v
              Kafka buffer  ---------> Stream aggregator (rollups)
                  |                           |
                  v                           v
        +---------------------+        +--------------+
        |   TSDB Writer       |        | Alert Eval   |
        +---------------------+        +--------------+
                  |                           |
                  v                           v
          TSDB shards (hot)            Alert Manager
                  |                           |
                  v                           v
          Object store (cold)          Slack/PagerDuty
                  ^
                  |
        +---------------------+
        |   Query Service     | <--- Dashboards (Grafana)
        +---------------------+
```

---

## Deep Dives

### 1. Ingest pipeline at 5M points/sec

Naively pointing 500K agents at a single service blows up fast. Three mechanisms make this tractable:

**Batching at the agent.** An agent that emits 100 points every 10 seconds should send one request every 10 seconds, not 100 requests. Batching collapses network overhead by ~100x and is the cheapest optimization available.

**Sharding by series, not by request.** The ingestion tier is stateless and load-balanced, but the TSDB writers behind it are stateful - each writer owns a subset of series. We hash `series_id = hash(metric_name + sorted_labels)` to a shard. This preserves locality: all points for the same series go to the same writer, which keeps chunk building efficient and avoids distributed writes per point.

**Durable buffering with Kafka.** Between ingestion and the TSDB writer we put a Kafka topic partitioned by series_id. This serves three roles: (a) absorbs write spikes when a deploy causes a thundering herd of new pods emitting metrics; (b) lets us restart or re-shard the TSDB without losing data, because Kafka retains 24+ hours of history; (c) enables multiple consumers - the stream aggregator and alert evaluator read the same topic without going through the TSDB.

The trade-off is latency: Kafka adds a few hundred milliseconds. For alerts with a 1-minute SLO that is fine.

### 2. Time-series database internals

A TSDB is not a generic database, and understanding why matters for the interview.

**Write path.** Incoming points are appended to an in-memory "head block" organized as `series_id -> list of (timestamp, value)`. Timestamps are stored as delta-of-delta (the difference between consecutive deltas, usually 0 when the scrape interval is regular, compressing to a few bits each). Values use Gorilla XOR encoding, which exploits the fact that consecutive floats often differ only in the low bits. Together these give ~1.3 bytes per point in practice versus ~16 bytes raw.

Every 2 hours the head block is sealed, compressed, and flushed to disk as an immutable chunk file. A write-ahead log persists points between flushes so nothing is lost on crash.

**Read path.** Queries typically filter by label selector first: `http_requests{service="api", status="500"}`. An inverted index maps each label-value pair to a posting list of series IDs. The query engine intersects posting lists (set intersection over sorted series ID lists) to get matching series, then fetches their chunks for the requested time range.

**Why not use Postgres or Cassandra?** Postgres row overhead (20+ bytes per row) dominates a 1-byte value. Cassandra works but its LSM model is optimized for arbitrary keys, not append-only time-ordered data, and it lacks the domain-specific compression. Choices in practice: Prometheus (single-node), Thanos or Cortex or Mimir (horizontal Prometheus), InfluxDB, VictoriaMetrics, TimescaleDB (Postgres extension), or ClickHouse (increasingly common for logs+metrics at extreme scale).

### 3. Downsampling, rollups, and retention

A dashboard showing "last 30 days of p99 latency" cannot read 30 days of 10-second-resolution raw points - that is 259K points per series, times thousands of series on a panel. The query would take minutes.

**Rollup tiers.** We pre-compute lower-resolution aggregates:
- Raw: 10s resolution, 15-day retention.
- 1-minute rollups: avg, min, max, count, p50, p95, p99. 90-day retention.
- 1-hour rollups: same functions. 2-year retention.

Rollups are built by a stream aggregator (Flink, Spark Streaming, or a custom consumer) reading the Kafka topic and writing back to dedicated TSDB tenants with longer retention. At query time, the query engine picks the coarsest tier that still satisfies the step size.

**The percentile trap.** You cannot average percentiles. If you want a p99 over a 1-hour window from 1-minute rollups, you cannot just take the average of 60 p99 values - it is mathematically wrong. The fix is to store **histograms** (t-digest or HDR) per window, not scalar percentiles, and merge histograms at query time. This is why Prometheus exposes `histogram_quantile()` over bucket counts rather than pre-aggregated percentiles.

**Retention as tiered storage.** Raw data lives on local SSD on TSDB nodes. Older chunks are uploaded to S3 as compressed blocks and deleted from local disk. Query service transparently reads from S3 for cold ranges, caching recent reads. Thanos and Cortex are built around exactly this pattern.

### 4. Alerting pipeline

Alerting has harder reliability requirements than dashboards because a missed page means an outage goes undetected.

**Evaluation.** A scheduler iterates over all alert rules every 10-30 seconds, executes each as a range query against the TSDB (or a dedicated recent-data cache), and compares the result to the threshold. The `for` duration means a rule transitions to `pending` on first breach and only fires after the condition holds for the full duration - this prevents flapping.

**State per label set.** A single rule like `cpu > 80%` can fire independently for each host. The evaluator tracks `(rule_id, label_set) -> state` and emits one alert instance per firing label set.

**Alert manager responsibilities.**
- **Grouping**: if 500 hosts fire at once, send one notification listing all of them, not 500 pages.
- **Deduplication**: if two evaluators fire the same alert (for HA), only page once.
- **Inhibition**: if "region down" is firing, suppress "host unreachable" alerts for that region.
- **Silences**: operators can mute alerts during planned maintenance.
- **Routing**: match labels to receivers (`team=payments -> #payments-oncall`).

**HA.** Run two independent evaluators on two independent TSDB replicas. They both evaluate and both send to the alert manager, which dedups. This tolerates loss of either side without missing pages.

**Why evaluation must not use stale data.** If alert evaluation reads from S3-tiered cold storage or hits a lagging replica, alerts fire late. Dedicated hot-path storage (the in-memory head block of the TSDB replica closest to the writer) is essential.

### 5. High cardinality

Cardinality is the number of distinct `(metric_name + label_set)` combinations. It governs memory (inverted index + head block series map), query cost (posting list intersection size), and disk layout (one chunk file per series per flush).

**How cardinality explodes.** A well-intentioned developer adds `user_id` as a label. Now a metric that was 10K series becomes 10M. Or `request_id`, which makes every request a new series, blowing up to billions. Once cardinality exceeds tens of millions per tenant, the index no longer fits in memory and queries time out.

**Mitigations:**
- **Label allowlists and validation.** Reject at ingestion any label whose value space is unbounded (IDs, emails, URLs with query strings). Emit a dedicated metric tracking rejected labels so owners can see it.
- **Cardinality quotas per tenant.** Track live series count, refuse new series past a limit, and surface the offending metrics in a UI.
- **Histogram buckets instead of per-value series.** If someone wants "latency by user," they probably want a distribution, not a series per user. Push them toward histograms.
- **Sharding by tenant first, then by series.** A runaway tenant degrades only its own shard.
- **Aggregation at the agent.** For extremely high-cardinality counters, agents can pre-aggregate locally (e.g., count requests per endpoint, not per request) before emitting.

**The IDs-as-labels rule of thumb.** Anything that can take more than a few thousand distinct values should not be a label. It should be a log field (searchable) or a trace attribute (indexed differently), not a metric dimension.

---

## Scaling Journey: 0 to Infinity

This section is my own view of how a metrics platform evolves under load. The numbers are rough rules of thumb, not hard limits, but they capture the architectural transitions you should be able to narrate in an interview.

### Stage 1: 0-10K Data Points/sec (MVP)

**Goal.** A single engineering team needs to see CPU, memory, and request rate on a handful of services and get paged when things break. Total scope: tens of services, a few hundred hosts.

**Architecture.** A single-node Prometheus server scraping targets every 15 seconds, Grafana pointed at it for dashboards, Alertmanager running alongside for notifications. All three on one VM with local SSD. Retention set to 15 days on 500 GB of disk. Nothing is replicated.

**What you skip.** No long-term storage, no remote write, no multi-tenancy, no HA. If the VM dies, you lose up to 15 days of metrics - acceptable for an early-stage product, and the metrics are for debugging live systems anyway.

**Failure mode.** The single Prometheus instance runs out of memory as the target count grows (Prometheus holds the index and head block in RAM, typically a few GB for 1M active series). When a deploy doubles the service count, Prometheus OOMs during the 2-hour head block flush, losing a window of data. Also, when you hit ~10K points/sec and need 30-day retention, local disk fills up.

### Stage 2: 10K-100K DP/sec

**Goal.** The company has grown to a few hundred engineers across a dozen services, wants dashboards for the last 3 months, and cannot tolerate losing Prometheus without losing visibility.

**Architecture.** Run two Prometheus instances scraping the same targets (HA pair) and configure **remote write** to push blocks to **Thanos** or **Cortex** backed by S3 for long-term storage. Grafana queries a Thanos Querier that fans out to both Prometheuses and to S3-backed historical data. Alertmanager runs as a clustered pair for HA notifications.

**What you skip.** No multi-tenancy yet - all teams share one Prometheus instance. No Kafka buffer - remote write is direct. No stream processing, no custom rollups beyond what Thanos compactor produces. Alert evaluation still runs inside Prometheus, not a separate service.

**Failure mode.** Remote write backpressure: when S3 or the Thanos receiver slows down, Prometheus' write-ahead log fills up and it eventually drops points. High-cardinality metrics from one team (someone added `user_id` as a label) cause the shared Prometheus to OOM, taking down monitoring for everyone. The single ingestion path becomes a coupling point.

### Stage 3: 100K-1M DP/sec

**Goal.** Hundreds of services, tens of thousands of hosts, multiple business units. Each team wants its own dashboards and alert rules with isolation. Ingestion spikes during deploys cannot drop data.

**Architecture.** Introduce a **Kafka buffer** between ingestion and storage. Host agents push to a load-balanced ingestion service which writes to Kafka, partitioned by `series_id`. A pool of TSDB writers (Cortex ingesters, or VictoriaMetrics vminsert, or custom consumers) shard by series and build chunks. A **stream aggregator** (Flink) consumes the same Kafka topic to produce 1-minute and 1-hour rollups, written to dedicated long-retention tenants. Query service reads from the TSDB and transparently routes long-range queries to rollups. Alert evaluation moves to a dedicated **rule evaluator** service that reads a hot-path cache of the last 15 minutes of metrics, not the full TSDB.

Multi-tenancy: every metric is tagged with `tenant_id` at ingestion, and all storage is partitioned so a noisy tenant cannot starve others. Per-tenant cardinality quotas are enforced at the ingestion service - reject new series once a tenant exceeds its limit, emit a visible "rejected_series" metric.

**What you skip.** Still single-region. Still a single global view - no federation. No tiered storage optimization yet, just raw + two rollup tiers.

**Failure mode.** Single-region failure takes down all monitoring including the ability to see that it is down. A rare but critical failure. Query latency for cross-tenant "overview" dashboards (show all services) gets painful as series counts cross 100M.

### Stage 4: 1M-10M DP/sec

**Goal.** The scale the problem statement specifies: 500K hosts, 5M points/sec, sub-second dashboard queries over weeks, sub-minute alert latency, PB-scale storage. Think late-stage Datadog or a large internal platform at AWS/Google/Meta.

**Architecture.** Tiered storage becomes explicit: recent data (last 24h) in memory on ingester nodes, last 15 days on local SSD in TSDB nodes, older data in S3/GCS with parquet-like column layout read by the query service on demand, with an aggressive chunk cache in front. Rollups are pre-computed eagerly and queries dispatched to the correct tier by a planner that inspects the step size and range.

Cardinality engineering is the dominant concern: **label value hashing**, **per-tenant series limits with enforcement at ingestion**, **metadata indexing in FoundationDB or a dedicated service** to keep the inverted index out of the hot ingester path. High-cardinality metrics are diverted to a separate "exemplars" path that samples rather than keeping every series.

Alert evaluation runs as its own horizontally-scaled service, sharded by rule groups, with two replicas evaluating independently and Alertmanager deduplicating. The rule evaluator reads from a hot-path store (ingester memory via gRPC) rather than hitting the query service, to keep alert latency below 30 seconds.

**What you skip.** Single global region still. Users in other regions tolerate higher dashboard latency. Compliance-driven data residency not yet addressed.

**Failure mode.** Regional outage still takes out the whole system. Global blast radius: a bad tenant, bad deploy, or bad query can still affect others despite per-tenant quotas, because Kafka and the query service are shared. Cross-ocean users see 200ms+ dashboard latency because query service is in one region.

### Stage 5: 10M+ DP/sec (Hyperscale)

**Goal.** Multi-region, multi-tenant, compliance-constrained. Global dashboards that aggregate across regions, local alerting that fires even during region partitions, regulated data that must stay in-region.

**Architecture.** Each region runs an independent, self-contained metrics stack: ingestion, Kafka, TSDB, rollups, alerting, Alertmanager. Alerts evaluate locally against local data so a region can page its on-call even if the global plane is down - this is critical because monitoring must work when everything else fails.

A **global federation layer** answers cross-region dashboard queries by fan-out-and-merge: send the query to each region's query service, each returns a pre-aggregated result at the requested step, the federator merges. Rollups are federated the same way - a "global p99" panel actually shows merged histograms from every region, not a separately computed global series.

Cold storage is per-region object store (S3 in each region) with a global catalog that knows where each block lives. Data residency is enforced because blocks never leave the region they were written in. For global users, a thin read-only replica of recent rollups is pushed to a central region for fast overview dashboards, while drill-down queries go back to the owning region.

High-cardinality handling is now adaptive: the system auto-detects cardinality explosions (a metric whose series count doubles in an hour), flags the offending label, and either auto-drops it with a warning or forces the team to acknowledge it before ingestion resumes. This is the only way to stay ahead of cardinality at this scale, because no human can review every new metric.

Every assumption from earlier stages gets audited: batching, compression, chunk sizes, index layouts, query planner heuristics. The gains are smaller per change but compound across 10M+ DP/sec.

---

## Expected Depth by Level

| Level | Functional + NFRs | High-Level Design | Deep Dives | Scale |
|---|---|---|---|---|
| **Mid (L4)** | States requirements clearly, identifies ingest/query/alert as the three pipelines, catches the 1-minute alert SLO. | Draws ingestion -> storage -> query -> alert, names Prometheus or Datadog as reference, uses a TSDB without explaining why. | Discusses one deep dive (usually ingestion or storage) at a surface level. Mentions sharding without specifying the shard key. | Reasons about ~100K DP/sec; does not explicitly plan for multi-region or cardinality explosions. |
| **Senior (L5)** | Calls out cardinality as a first-class NFR, quantifies storage (1 GB/s raw -> PB over retention), distinguishes raw vs rollup retention. | Introduces Kafka as a buffer and justifies it (spikes, replay, multi-consumer). Shards by series_id and explains why. Separates hot and cold storage tiers. | Explains TSDB internals (delta-of-delta, Gorilla XOR, inverted index on labels). Discusses the percentile-of-percentiles trap and pushes for histograms. Describes alert HA via two evaluators + dedup. | Reasons about 1M-10M DP/sec, discusses rollup tiers and their retention policies, proposes per-tenant cardinality quotas. |
| **Staff (L6+)** | Treats monitoring as a tier-0 system whose availability must exceed the systems it monitors; calls out that local alerting must work during regional partitions. | Argues for or against pull vs push with real trade-offs; discusses exemplars for high-cardinality observability; separates hot-path (for alerts) from cold-path (for dashboards) storage. | Drives tiered storage with a query planner that picks the right tier per query step. Proposes adaptive cardinality detection and auto-dropping. Designs the federation layer and explains why global alerts are usually a bad idea. Debates t-digest vs HDR histograms for rollups. | Sketches multi-region federation, per-region data residency, global read-only replicas, and the failure semantics when regions partition. Discusses cost: compression ratios, storage tiering, and the unit economics of monitoring a fleet. |
