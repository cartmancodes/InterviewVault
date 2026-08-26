# 🧭 Engineering Notes — Two Platform Migrations

> **Overview**: Working notes across two pieces of platform work at Arcesium: moving a
> regulatory ETL off single-JVM Spark onto Kubernetes, and putting a firm-wide LLM
> gateway behind persistent budgets and rate limits. They were separate projects with
> separate stacks. The failure modes rhymed enough that the overlap is worth writing
> down on its own.

## 🧒 Layman's Explanation

Renovate two very different buildings with two different contractors and you start
noticing the same defects. A light switch that clicks satisfyingly but is wired to
nothing — configuration that parses and does nothing. A smoke alarm that has never once
been tested — a safety control whose failure mode is silence. Load ratings scribbled on
a napkin instead of stamped next to the beam — capacity arithmetic held in someone's
head. Widening the doorway only to move the queue to the stairwell — scaling one stage
relocates the bottleneck. And two fuse boxes with identical ratings that blow in
opposite directions — architectural choices that look like performance questions and
are actually about failure semantics.

None of these defects belongs to one kind of building. That is what makes them worth a
notebook of their own.

## 🗺️ The Two Migrations

| Full write-up | What it covers |
|---|---|
| [How We Ran Spark on Kubernetes](HowWeRanSparkOnKubernetes.md) | Local → cluster mode → client mode. Pod templates, the memory model, `ownerReference` and exit-code propagation, dynamic allocation, skew, and a troubleshooting runbook. |
| [How We Built a Firm-Wide LLM Gateway](HowWeBuiltTheFirmwideLlmGateway.md) | LiteLLM behind Kerberos. Persistent budgets on Postgres, in-memory rate limits sized deliberately, prompts and per-request logs to S3, and the coupling between those three decisions. |

## 🔁 The Five Things That Transferred

### 1. Config that parses is not config that works

The most expensive bugs in both projects were settings that were accepted, ignored, and
silent about it.

- Spark **overwrites** the pod-template fields it considers its own — name, namespace,
  image, cpu/memory. Setting them in YAML looks like configuration and behaves like a
  comment.
- `spark.kubernetes.authenticate.driver.serviceAccountName` is a cluster-mode property.
  In client mode there is no driver pod for Spark to create, so it is a no-op and the
  identity that actually matters is the workflow pod's.
- LiteLLM's cold-storage logger was documented under one key name while the code read a
  different variable. The setting parsed cleanly and did nothing.

None of these produce an error. The system starts, looks healthy, and does something
other than what the file says.

**Practice:** for every setting that matters, know which layer owns it, and prove the
value took effect by observing behaviour rather than by reading the file back.

### 2. Controls that fail permissively must be tripped on purpose

Both platforms had safety mechanisms whose failure mode was silence.

- A Spark application could fail in cluster mode while its Argo step exited green —
  the pipeline continued on data nobody wrote.
- LiteLLM has shipped versions where the budget limiter was instantiated but never
  registered as a callback, so nothing was enforced.

Both look exactly like a healthy system. Nothing errors, no alert fires.

**Practice:** an enforcement mechanism you have never seen say *no* is a hypothesis, not
a control. Fail a job deliberately and assert the orchestrator turns red. Over-spend a
test identity and assert the rejection comes from a **different replica** than the one
that recorded the spend. Re-run both on every version bump — these are exactly the bugs
that regress.

### 3. Write the arithmetic down next to its inputs

Every capacity decision in both projects reduced to a formula, and the ones that caused
trouble were the ones held in someone's head.

```text
# Container memory: budget DOWN from the hard limit, not up from the heap.
heap      = pod_limit / (1 + overhead_factor)     # 0.10 JVM, 0.40 PySpark
overhead  = pod_limit - heap

# Effective rate limit with unshared counters.
effective = configured × instances × workers      # workers default to 1/core
per_user  = provider_quota / (instances × workers × concurrent_heavy_users)

# Budget enforcement error with cached, batched spend.
overspend ≈ (cache_ttl + batch_write_interval) × instances × spend_rate
```

Note how often `instances × workers` appears. In the gateway that one product governs
rate-limit accuracy, Postgres connection count, and throughput simultaneously — so an
instance-type change silently moves all three.

**Practice:** state bounds as formulas with named inputs, not as percentages. "<1% false
positives" is unfalsifiable; "20 seconds × 10 instances of unbudgeted spend" is a number
you can decide about. And keep the derivation next to the value, so the next person
scaling out knows the limit has to be recomputed.

### 4. Scaling one stage relocates the bottleneck

- Spark's heavy ETL stage got 2.25× faster for 5× the data, then stopped — a
  single-transaction `MERGE` over plain JDBC was waiting downstream. The ingestion job
  on the same platform got 5× faster and kept going, because nothing was.
- Adding Postgres to the gateway made spend durable and made the accounting rows the
  contended resource at roughly 1,000 RPS.

Same infrastructure, opposite returns, because the binding constraint sat in a different
place.

**Practice:** the honest measure of a migration is what it exposes downstream, not what
it fixes upstream. Before starting, name the next constraint and how you would detect it.
When wall-clock stops improving as you add workers, the bottleneck has already left the
thing you are tuning.

### 5. The architectural choice is usually about failure semantics

Both projects had a decision that looked like a performance question and was not.

- **Where the driver runs.** Cluster and client mode scale identically. Cluster mode gives
  the driver its own resources and failure domain but detaches it from the orchestrator —
  exit codes need polling, logs live elsewhere, and nothing owns the driver pod. Client
  mode makes all three correct by construction and pays for it with a driver that is sized
  and fated like the pod it squats in. If the orchestrator is the system of record for
  "did this succeed", that is not close.
- **Whether the rate-limit counter is shared.** In-memory fails open — always available,
  systematically permissive. Redis-backed fails closed — exact, and now every LLM call in
  the firm depends on a cache being up.

**Practice:** when two options have the same throughput, you are choosing a failure mode.
Name which way each fails, decide deliberately, and give the failing dependency the
availability tier that decision implies.

## ✅ Production Checklist

Distilled from both. Ordered roughly by how expensive each is to retrofit.

### Before scaling anything

- [ ] Measure the **fixed floor**. A 10k-record Spark job took 15 minutes in both local and
      cluster mode — image pull, scheduling, credential setup. Below the floor,
      distribution is pure overhead. Know where your crossover is.
- [ ] Name the constraint you are actually relieving. Per-node memory, not total memory,
      was the Spark ceiling — the fix raised aggregate usage and improved schedulability.
- [ ] Name the constraint you expect to hit next, and how it will present.

### Resource limits

- [ ] Budget **down** from the container limit; make the hard external constraint the input.
- [ ] Count *every* limit, not just memory: heap, overhead, ephemeral storage, connection
      pool, file descriptors. Ephemeral storage evicts pods as abruptly as memory does, and
      it is where shuffle spill and local checkpoints land.
- [ ] Distinguish `OOMKilled` (exit 137, no stack trace — container exceeded its limit,
      raise *overhead*) from `OutOfMemoryError` (heap too small, raise *memory*). The
      remedies are opposite; raising the heap on an OOMKill makes the pod larger and no
      less likely to be killed.
- [ ] Account for native and off-heap allocation — Kerberos/GSS libraries, cloud SDKs,
      Python workers. None of it lives in the JVM heap.

### Lifecycle and ownership

- [ ] Every resource you create needs an owner, or you are the garbage collector. Spark
      owns executors from the driver but sets nothing above it, so driver pods accumulate.
- [ ] Owner references must be **same-namespace** — cross-namespace ones are treated as
      invalid and the object is collected as an orphan, the opposite of the intent.
- [ ] Retention is a design decision, not an afterthought: S3 lifecycle rules, partition
      drops rather than `DELETE` (deleting rows leaves dead tuples for autovacuum), upload
      paths that nothing ever cleans.

### State and its blast radius

- [ ] Any counter not shared across processes is multiplied by process count. If that is
      acceptable, size against it explicitly and re-derive on every scale-out.
- [ ] When many writers converge on hot rows, batch through one committer. Many writers →
      shared queue → single lock-holding flusher → one transaction, is the shape.
- [ ] Prefer removing writes to making them cheaper. The best candidate is data you store
      because it might be useful, not because something depends on it.
- [ ] Know which store answers which question. Object storage is a cheap bulk audit record
      and a terrible index; a relational table is the reverse.

### Configuration hygiene

- [ ] No secrets in ConfigMaps — database URLs, cache passwords, master keys, salt keys.
- [ ] No dev endpoints or credentials in deployable config. `verify: false` disables TLS on
      the exact channel you moved sensitive data onto.
- [ ] Prefer ambient workload identity (IRSA, mounted service-account tokens) to static keys.
- [ ] Render environment-specific config from one parameterised source with defaults;
      checked-in near-duplicates drift.
- [ ] Pin versions of fast-moving dependencies, and re-run acceptance tests on upgrade.

### Observability, before tuning

- [ ] Ship the durable record first — event logs to object storage, metrics to Prometheus.
      Diagnosing from application logs alone is the hard way, and it is what you are left
      with if you defer this.
- [ ] Keep failed workers around long enough to inspect them. Defaults usually delete them
      before you can look.
- [ ] Watch queue depth and lock ownership, not just throughput — a monotonically growing
      queue is the earliest warning that a flusher is losing.
- [ ] Alert on the signal that only appears when your own limits fail. With unshared rate
      limits, the upstream provider's 429 rate is the only thing that can tell you the
      sizing has gone stale.

## 🧑‍🏫 What I Would Tell Someone Starting Either Project

Start from the failure modes, not the feature list. Both platforms are large and
well-documented, and the documentation is organised around what you *can* configure. The
questions that actually determined the outcome were: what happens when this component is
unreachable, who owns cleanup when a run dies halfway, and what does the system do when a
limit is exceeded but the counter that would have caught it lives in another process.

Neither project's hardest problem was in the technology being adopted. Spark's was a
`MERGE` statement in a database, and the gateway's was that a rate limit means nothing
until you decide what it costs to enforce it. Both were visible from the start to anyone
asking where the constraint actually sat.

## 🎓 Key Takeaways

- **Config that parses is not config that works.** The most expensive bugs in both
  projects were settings that were accepted, ignored, and silent. Prove a value took
  effect by observing behaviour, never by reading the file back.
- **Trip every permissive control on purpose.** A budget or exit code you have never seen
  fail is a hypothesis, not a control — deliberately break it on every version bump.
- **Write capacity arithmetic next to its inputs.** Bounds belong as formulas with named
  inputs (`instances × workers` decided three things at once in the gateway), so the next
  scale-out knows what to recompute.
- **Scaling one stage relocates the bottleneck.** Judge a migration by what it exposes
  downstream, not what it fixes upstream — and name the next constraint before you start.
- **Equal-throughput options differ in failure semantics.** Where the Spark driver runs
  and whether a rate-limit counter is shared are both choices about *which way the system
  fails*, not about speed.

## 📚 Related Concepts

- [How We Ran Spark on Kubernetes](HowWeRanSparkOnKubernetes.md) — the full Spark
  migration write-up these notes distil from.
- [How We Built a Firm-Wide LLM Gateway](HowWeBuiltTheFirmwideLlmGateway.md) — the full
  gateway write-up, including the arithmetic behind the in-memory rate-limit decision.
- [Scaling Writes](../Patterns/ScalingWrites.md) — the many-writers-into-one-committer
  shape both projects converged on.
- [Dealing with Contention](../Patterns/DealingWithContention.md) — why hot rows and hot
  keys are the same problem in a database and a rate limiter.
