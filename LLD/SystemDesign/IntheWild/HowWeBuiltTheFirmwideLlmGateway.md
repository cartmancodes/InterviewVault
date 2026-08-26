# 🚪 How We Built a Firm-Wide LLM Gateway on LiteLLM

> **Overview**: A Kerberos-authenticated Nginx proxy in front of a LiteLLM fleet gave the firm one entry point to every model provider — and no memory. Rate limits lived in each pod's RAM, so a "50 RPM per user" policy actually permitted 50 × pods × workers, and spend was not tracked at all. We shipped persistent budgets on Postgres, kept rate limiting **in memory** rather than introducing Redis, and moved prompts and per-request logs out of the database into **S3 cold storage**. Those two choices are not independent: declining Redis means the database has no write-shedding path, and moving the largest table off it is what makes that safe. This is the reasoning, the arithmetic that has to hold for it to stay safe, and the conditions under which it stops being the right answer.

*Identifiers here — hostnames, namespaces, database names, service names — are generalized. The configuration semantics, failure modes and the published LiteLLM behaviour they rest on are real, and sourced at the end.*

## 🧒 Layman's Explanation

Think of a company canteen where every employee gets ten coffees a day. The rule is written on a card behind the counter, and there is one barista. Easy to enforce: the barista remembers who has had what.

Now the queue grows and you open ten more counters. Each barista gets their own copy of the card — and their own memory. Nobody has had eleven coffees *from any one barista*, so nobody is ever refused, and the firm quietly buys a hundred coffees per person per day. Nothing is broken; the rule is being enforced perfectly, ten separate times. That is what a rate limit held in a single process's memory does when you scale to ten processes.

There are two ways out. Give every barista a phone line to a shared tally board that they must check *before* pouring — accurate, but now the coffee stops entirely if the tally board goes down. Or let them keep their own cards and reconcile every minute — cheap and always pouring, but with a minute's worth of over-pouring baked in.

The second thing the canteen never had is a ledger. Ten coffees a day was a *rate*, and nobody was recording spend, so there was no way to say "this department has used its quarterly allowance". Adding the ledger is the easy part. Making the ledger fast enough that writing to it does not become the new queue is the part that takes design.

## 🎯 The TLDR

The gateway sits between every internal caller and every model provider: Nginx terminates Kerberos, injects the authenticated principal as a header, and LiteLLM resolves that principal into an identity, applies limits, routes to a provider and records what it cost. Two capabilities were missing. Three decisions closed them.

**Budgets go to Postgres.** LiteLLM enforces spend limits at every level of its identity hierarchy, but only if you give it a database — without one there is no persistence and nothing survives a restart. Adding it is a one-line change plus a migration LiteLLM runs itself. The design work is all downstream of that line.

**Rate limiting stays in memory.** The in-memory limiter is not inaccurate, it is *multiplied*: the effective ceiling is `configured × instances × workers`, and workers default to one per CPU core, so an 8-core pod multiplies by eight before you count replicas. The fix is a shared counter in the request path, and LiteLLM's supported answer is Redis with atomic Lua check-and-increment — which converts a correctness problem into an availability dependency, since in the current limiter generation a Redis outage fails requests rather than falling back to local counting. We chose not to take that dependency. That is defensible, and it is only defensible **as long as per-user limits are sized against the provider ceiling divided by `instances × workers`**. The multiplier stops being a footnote and becomes a capacity-planning input that has to be revisited on every scale-out.

**Prompts and per-request logs go to S3, not Postgres.** Spend logs are the fastest-growing table in the system — roughly 1–2 KB per request, about ten times that with prompts — and they are also the least useful thing for Postgres to hold, since nothing on the hot path reads them. Writing them to S3 through the cold-storage logger and disabling the database table removes the dominant write from the accounting database entirely.

The third decision is what makes the second one safe, and the connection is worth stating plainly. Declining Redis also declines LiteLLM's write-shedding path for spend updates — the Redis transaction buffer that keeps Postgres from deadlocking at scale. Without it, database write volume is the constraint that decides how far this architecture scales, so taking the largest writer off the database is not a storage optimization. It is the thing that buys headroom the Redis path would otherwise have provided.

Two corrections to the original draft still stand: the schema must not be hand-written (LiteLLM owns it through Prisma migrations), and had we gone the other way on the cache, a Hazelcast provider would not have delivered distributed rate limiting, because the limiter depends on server-side atomics rather than on the cache interface.

## 🧭 Where We Started

```mermaid
flowchart LR
    U["Internal caller"] -->|"Kerberos"| N["Nginx<br/>authenticates, injects x-forwarded-user"]
    N --> L1["LiteLLM pod 1<br/>in-memory counter"]
    N --> L2["LiteLLM pod 2<br/>in-memory counter"]
    N --> L3["LiteLLM pod N<br/>in-memory counter"]
    L1 --> P["Model providers"]
    L2 --> P
    L3 --> P

    classDef bad fill:#FFB6C1
    classDef infra fill:#e1f5ff
    classDef ext fill:#f3e5f5
    class L1,L2,L3 bad
    class N infra
    class P ext
```

Nginx handles Kerberos, adds `x-forwarded-user`, and rewrites paths onto the completions endpoint. A custom `user_api_key_auth` hook in LiteLLM turns that header into an identity — which is the right shape, and is the hook the rest of this design builds on. Everything after that is per-pod state.

Three gaps follow:

- **No spend tracking at all.** Without a database LiteLLM has nowhere to persist cost, so there is no ledger, no budget, and no answer to "what has this team spent this quarter".
- **Rate limits multiply instead of aggregate.** Each pod counts only its own traffic.
- **No shared identity.** Users exist only for the lifetime of a request, so there is nothing to attach a budget, a role or a history to.

### The multiplication, stated precisely

The common framing is that in-memory limits are "50–60% accurate". That is the wrong mental model, and it understates the problem. The limit is enforced *perfectly* — once per counter. The number of counters is what is wrong:

```
effective limit  =  configured limit  ×  instances  ×  workers per instance
```

The `workers` term is the one that surprises people. LiteLLM's production guidance is to run one ASGI worker per CPU core, so a 4-core pod is already a 4× multiplier before any replica count. Ten pods at 4 workers turns a 50 RPM policy into a 2,000 RPM ceiling — and the upstream provider's own limit is what you hit instead, as 429s that appear to come from nowhere. This exact behaviour is reported against the multi-instance flag: limits landing at `threshold × instances × num_workers`.

That reframing matters for the decision. If a 40× overshoot is tolerable because your per-user limits are generous and the provider ceiling is far away, in-memory is genuinely fine and costs nothing. If you are sizing per-user limits against a provider quota, it is not a tuning problem — the architecture cannot express the policy.

## 🏛️ The Identity Model You Inherit

Before configuring anything, it is worth understanding the hierarchy LiteLLM already has, because a custom auth hook is *populating* that model rather than replacing it.

Organizations contain teams; teams contain users; users hold keys; keys make requests on behalf of an end-user. Every request's spend is attributed at **every** level simultaneously — key, user, team, organization — and a budget can be set at each. A request is rejected when any level on its path is over budget.

```mermaid
flowchart TD
    O["Organization<br/>budget, models"] --> T["Team<br/>budget, RPM/TPM"]
    T --> US["User<br/>budget, RPM/TPM"]
    US --> K["Virtual key<br/>budget, models, RPM/TPM"]
    K --> EU["End user (customer)<br/>budget"]
    R["A request"] -.->|"spend attributed at every level"| O
    R -.-> T
    R -.-> US
    R -.-> K
    R -.-> EU

    classDef good fill:#90EE90
    classDef warn fill:#FFE4B5
    class O,T,K,EU good
    class US warn
```

Two things to get right before writing any code:

- **Pick the level that matches the policy, once.** A per-user quota belongs on the user or on a per-user key; a per-department allowance belongs on a team; a per-application allowance belongs on a key. Mapping a Kerberos principal onto the *wrong* level is the kind of decision that is very cheap now and very expensive after a quarter of spend history exists.
- **Beware the precedence trap.** There is a documented issue where, when a request's identity resolves through a team, the team's limits are enforced and the **user's limits are effectively ignored**. If the design is "every engineer gets 50 RPM" *and* users are grouped into teams, verify empirically which limit actually fires before assuming both do. This is the single most important thing to test on day one, because it fails silently in the permissive direction.

The custom auth hook is where the mapping happens. The existing shape is right — the additions are returning the identity fields LiteLLM's limiters read, and caching the lookup so the hot path is not a database round trip:

```python
async def user_api_key_auth(request, api_key: str) -> UserAPIKeyAuth:
    if request.url.path in ("/health/readiness", "/health/liveness"):
        return UserAPIKeyAuth()

    principal = request.headers.get("x-forwarded-user")
    if not principal:
        raise HTTPException(status_code=401, detail="Missing user principal")

    username = get_krb5_localname(principal)
    profile = await user_directory.get(username)      # cached, see ttl below

    if ENABLE_AUTHZ and not is_authorized(profile):
        raise HTTPException(status_code=403, detail="User not entitled")

    return UserAPIKeyAuth(
        user_id=profile.user_id,
        user_email=profile.email,
        user_rpm_limit=profile.rpm_limit,
        max_budget=profile.max_budget,
        spend=profile.current_spend,
        models=allowed_models(profile),
    )
```

Two notes on that hook. It runs on **every** request, so the directory lookup must be cached — `user_api_key_cache_ttl` in `general_settings` governs how long LiteLLM holds the resolved identity, and it is one of the two staleness windows discussed below. And raising bare `Exception` (as the original draft does) produces a 500; raising `HTTPException` with an explicit status is what gives callers a 401 or 403 they can act on, and keeps genuine 500s meaningful in your dashboards.

## 💰 Budgets: Making Spend Persistent

Enabling persistence really is one setting:

```yaml
general_settings:
  database_url: os.environ/DATABASE_URL
  store_model_in_db: true
```

Everything interesting is what follows from it.

### Do not hand-write the schema

The original draft proposes `CREATE TABLE litellm_users (...)` and `litellm_spend_logs (...)`. **Delete that.** LiteLLM ships its own Prisma schema and runs its own migrations at startup, creating tables it owns — `LiteLLM_UserTable`, `LiteLLM_VerificationToken`, `LiteLLM_TeamTable`, `LiteLLM_SpendLogs`, `LiteLLM_EndUserTable` and the daily-aggregate tables among them. Hand-created tables with different names are simply invisible to the proxy: budgets would never be read from them, spend would never be written to them, and the only symptom is that enforcement silently does nothing.

The practical guidance that replaces it:

- Point `database_url` at a database the proxy owns, and let migrations manage it. Treat the schema as vendor-controlled, the way you would any embedded library's storage.
- If your own systems need this data, **read** from those tables or from an export — do not write to them. A join from your reporting layer is safe; an `UPDATE` is not.
- Pin the proxy version and let schema changes ride the image upgrade, so a migration never runs unexpectedly on a rollback.

### The secret in the ConfigMap

`database_url: "postgresql://user:${DATABASE_PASSWORD}@host:5432/db"` written into `configmap.yaml` puts a database password in a ConfigMap — an object that is not encrypted at rest by default, is readable by anything with namespace read access, and shows up in `kubectl get -o yaml`. The same applies to `redis_password` in the distributed-cache variant.

LiteLLM reads `os.environ/VAR` syntax anywhere in the config, so the fix costs nothing: keep the *reference* in the ConfigMap and the *value* in a Secret sourced from the firm's vault. While you are there, two more values belong in the same place — the proxy master key, and the salt key that encrypts stored provider credentials. On the salt key specifically: **do not rotate it after credentials have been stored**, because it is the key those credentials were encrypted with. That is a one-way door worth knowing about before the first deploy, not after.

### The largest table, and why it left the database

Storage is dominated by the spend-log table, at roughly 1–2 KB per request and about **ten times that** with prompt storage enabled. At a firm-wide gateway's volume that is the difference between tens of gigabytes a month and hundreds — and it is the same table whose row-by-row inserts compete with the budget updates the hot path actually depends on.

There is a second objection that has nothing to do with size. Storing prompts means every question anyone asks the gateway — client names, position data, unreleased figures, whatever people paste in — is persisted in a Postgres table whose access-control boundary is not the one the source data came from. That is a data-classification decision, and it should not arrive as a config default.

Both objections point the same way, so we moved that data to object storage. LiteLLM's cold-storage path writes the request and response payloads to S3 through a logging callback and keeps the accounting in the database:

```yaml
litellm_settings:
  callbacks: ["s3_v2"]
  cold_storage_custom_logger: s3_v2
  s3_callback_params:
    s3_bucket_name: os.environ/SPEND_LOG_BUCKET
    s3_region_name: us-east-1
    s3_path: spend-logs
    # No credentials here: boto3's default chain picks up the pod's
    # IRSA role from AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN.

general_settings:
  store_prompts_in_cold_storage: true
  store_prompts_in_spend_logs: false
  disable_spend_logs: true
```

The write path splits by what reads it, which is the right axis:

```mermaid
flowchart LR
    R["Request completes"] --> A["Spend attribution<br/>key, user, team, org"]
    R --> B["Request and response payloads"]
    A -->|"batched, proxy_batch_write_at"| PG["Postgres<br/>read on every budget check"]
    B -->|"async callback"| S3["S3 cold storage<br/>read rarely, in bulk"]
    PG --> BC["Budget enforcement"]
    S3 --> AU["Audit and forensics<br/>via Athena or a pipeline"]

    classDef good fill:#90EE90
    classDef store fill:#e1f5ff
    classDef warn fill:#FFE4B5
    class PG,S3 store
    class BC good
    class AU warn
```

Four things to get right, three of which bit us or nearly did.

**Do not enable both prompt destinations.** Setting `store_prompts_in_cold_storage` *and* `store_prompts_in_spend_logs` to `true` writes the payloads to S3 **and** keeps them in Postgres. That is the configuration you end up with by adding cold storage to an existing config without removing what it replaces, and it produces the worst of both: the database still carries the 10× multiplier and the prompts still sit in a table you moved them out of to avoid. If the goal is to get prompts out of the database, the second flag must be `false`.

**Budgets keep working with `disable_spend_logs: true`, and this is the point that makes the whole design viable.** Budget enforcement reads the running `spend` figures on the key, user, team and organization rows, not the per-request log table. Disabling that table removes the per-request insert while leaving spend attribution — and therefore every budget check — completely intact. You lose per-request detail *in the database*; the payloads are in S3, and the aggregate cost metrics still flow to Prometheus and any other logging integration.

**The credentials in the draft config are LocalStack's.** `s3_aws_access_key_id: "test"`, `s3_endpoint_url: "http://localhost:4566"`, `s3_use_ssl: false`, `s3_verify: false` — correct for a laptop, and every one of them must be absent from anything that reaches a cluster. `s3_verify: false` in particular disables TLS verification on a channel carrying the prompts you just moved to S3 for governance reasons. On EKS, omit the credential keys entirely: LiteLLM's S3 logger uses boto3, whose default chain picks up the pod's IRSA identity from `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN`. That is both the AWS-recommended pattern and one fewer secret to rotate. Where an explicit value is genuinely needed, `os.environ/VAR` keeps it out of the ConfigMap.

**Pin the version, and verify against it.** These flags are newer than the rest of the surface and have had real bugs. `cold_storage_custom_logger` was, for a period, the documented config key while the code read a *differently named* variable — so the setting parsed cleanly and did nothing. And a v1.77.2 report has `store_prompts_in_spend_logs` writing empty objects rather than payloads. Both fail silently and in the same direction: the config looks right and the data is not where you think. The acceptance test is to make one request and then read the object out of the bucket. Re-run it on every upgrade.

What this costs, stated honestly: **S3 is not queryable.** A Postgres spend-log table answers "show me every request this user made last Tuesday" with a `SELECT`; a prefix of JSON objects in a bucket answers it with Athena, a Glue crawler, or a pipeline you build. For an audit and forensics record that is read rarely and in bulk, that is the right trade. If someone expects interactive per-request search in the LiteLLM UI, it is not — and that expectation is worth settling before the table is switched off rather than after.

Finally, set a lifecycle policy on the bucket. The retention problem does not disappear by moving storage; it just becomes an S3 lifecycle rule instead of a Postgres vacuum problem, and it is much cheaper to solve there. If per-request rows do stay in Postgres for any reason, set retention explicitly — deleting rows does not return disk to the OS, it leaves dead tuples for autovacuum, and native range partitioning on the timestamp turns expiry into an instant `DROP TABLE` instead:

```yaml
general_settings:
  maximum_spend_logs_retention_period: "30d"
  maximum_spend_logs_cleanup_cron: "0 3 * * *"     # off-peak
```

### How stale is a budget check?

The draft's config sets a 10-second local cache TTL and a 10-second batch-write interval, then claims enforcement with "<1% false positives". That number has no mechanism behind it. The honest statement is a bound, and it composes from two independent windows:

```
worst-case overspend  ≈  (cache TTL + batch write interval) × instances × spend rate per instance
```

`proxy_batch_write_at` controls how long an instance holds spend before flushing it to Postgres; the cache TTL controls how long an instance trusts a budget figure it has already read. A user at their limit can keep spending for roughly the sum of the two, on every instance independently. With ten instances and a 20-second combined window, that is 200 instance-seconds of unbudgeted spend past the line — usually trivial in dollars, occasionally not, and always worth stating as a number rather than a percentage.

Shrink the windows and you trade accuracy against database load, which is the same dial the next section is about. If some budgets genuinely must not be exceeded, LiteLLM exposes `fail_closed_budget_enforcement`, which validates spend against the database for budgeted requests and **rejects with 503 when it cannot verify** — correctness at the cost of availability, applied deliberately and narrowly.

### Verify that enforcement actually fires

Budget enforcement in LiteLLM has had real bugs in which the limiter was instantiated but never registered as a callback, letting requests through unchecked, and in which zero-cost models bypassed checks. The failure mode of every one of them is the permissive direction: everything looks healthy and nothing is enforced.

So treat "budgets work" as a claim requiring evidence, on every version bump:

1. Create a test identity with a tiny `max_budget`.
2. Spend past it.
3. Assert the next request is rejected — from a *different pod* than the one that recorded the spend.

That third clause is the one that catches the interesting failures. It is the same discipline as deliberately failing a job to prove an orchestrator turns red: an enforcement mechanism you have never seen say **no** is a hypothesis, not a control.

## 🚦 Rate Limiting: We Kept the Counter in Memory

LiteLLM's limiter has been through several generations, and which one you get depends on version and flags. The current shape is worth knowing even though we did not adopt it: **Redis sits in the request path**, not as a background sync, and the check-and-increment runs as a Lua script executed server-side so the whole operation is atomic. That closes the time-of-check-to-time-of-use race any read-then-write scheme has, and it is why the shared counter can be exact rather than approximate.

The trade it introduces is the one that decided this for us, and it rarely appears on a pros-and-cons list:

- **In-memory:** limits multiply by `instances × workers`. Redis is not in the path, so a cache outage cannot fail a request. **Fails open — always available, systematically permissive.**
- **Redis-backed:** limits are exact across the fleet. But in the current limiter generation there are reports that **requests fail when Redis is down**, rather than degrading to local counting. **Fails closed — exact, and now the gateway has a hard dependency on a cache.**

For a gateway that every application in the firm calls, adding a component whose failure stops all LLM traffic is a large thing to trade for limit precision, and it obliges you to run that component at the gateway's own availability tier. We took the other side: keep the fail-open behaviour, and make the permissiveness a number we control rather than one we discover.

### The arithmetic that has to hold

Choosing in-memory is only safe if the multiplied ceiling stays under the ceiling that actually hurts — the upstream provider's quota. That inverts the sizing:

```
per-user limit  =  provider quota  ÷  (instances × workers × concurrent heavy users)
```

Three consequences follow, and they are the operational cost of this decision:

- **The limit is a function of the deployment, not of the policy.** Doubling replicas doubles the effective ceiling. Scaling out is therefore a change to rate-limit safety, and it has to be treated as one — the per-user value must be recomputed, not inherited.
- **Worker count is part of the multiplier.** The same number that governs throughput and the Postgres connection pool also governs this. Set it in one place, reference it everywhere, and never let it drift silently with an instance-type change.
- **The upstream 429 is the real alarm.** Because local limits never trip in aggregate, the first signal of a breach comes from the provider. Alert on upstream 429 rate as a first-class signal, not as a sub-case of general errors — it is the only thing that can tell you the sizing has gone stale.

### What would change our minds

Three conditions, any one of which makes in-memory the wrong answer:

1. **Per-user limits have to be tight** — sized close to the provider quota rather than comfortably beneath it, because the multiplied headroom no longer fits.
2. **Rate limits become a chargeback or fairness mechanism** rather than a safety valve. Approximation is fine for "don't melt the provider"; it is not fine for "this team gets exactly this share".
3. **We cross the write-volume threshold in the next section**, at which point Redis arrives anyway to shed database writes — and once it is on the request path with the availability tier that implies, the marginal cost of also using it for exact limits is close to zero.

The third is the likeliest, and it is worth noticing that it makes the decision self-correcting: the scale that breaks the no-Redis storage story is roughly the scale that makes the no-Redis limiter untenable. Until then, the sizing formula above is the whole control.

### The Hazelcast fork we did not take

The alternative on the table was a Hazelcast provider — inheriting `BaseCache` and mapping `get_cache` / `set_cache` onto `IMap` — to get shared state without a new Redis dependency. It is worth recording why that was not simply a cheaper Redis, because the reasoning outlives this decision.

**The distributed rate limiter does not go through the generic cache interface.** It depends on Redis executing a script that performs check-and-increment atomically, server-side. `get_cache` and `set_cache` are a get and a put; implementing them against `IMap` yields a working *cache* — identity lookups, config, response caching — and a limiter that reads, decides and writes as three separate operations with a race between them. Under exactly the concurrent load that makes limits matter, that reintroduces the overshoot the shared cache was adopted to remove.

Hazelcast can do atomic server-side mutation — entry processors over `IMap`, `IAtomicLong`, a `CPSubsystem` counter. The point is that this is **reimplementing the limiter**, not writing a cache adapter: porting the check-and-increment semantics, matching the sliding-window behaviour, then keeping that port aligned with an upstream limiter that changes between releases. Priced honestly it is a build-and-maintain commitment, not an integration — and a small dedicated Redis, if it ever becomes necessary, is the smaller of the two.

| | In-memory (chosen) | Redis (native) | Hazelcast (fork) |
|---|---|---|---|
| **Rate-limit behaviour** | Multiplied by instances × workers | Exact, atomic | Exact **only if** you port the atomics |
| **Effort** | None | Configuration | Custom limiter + ongoing upstream tracking |
| **New infrastructure** | None | A Redis tier at gateway availability | None — reuses the existing cluster |
| **Failure mode** | Fails open | Fails closed on cache outage | Whatever you implement |
| **Upstream alignment** | Native | Native, gets fixes for free | Diverges with every release |
| **Budgets** | Full (Postgres) | Full | Full |

## 🗄️ The Database Is the Second Bottleneck

Adding Postgres solves persistence and creates a new pressure point, and it appears at a predictable scale: **roughly 1,000 requests per second, or about ten instances.** Every instance issues updates against the same key, user and team rows for spend attribution. Concurrent updates to the same rows from many writers produce lock contention, deadlocks, and connection-pool exhaustion — and it is worth being clear that this is *accounting* write traffic, entirely separate from the spend-log inserts discussed earlier.

LiteLLM's answer inverts the write path:

```mermaid
flowchart TB
    subgraph POD["Each proxy instance"]
      direction TB
      RQ["Request completes"] --> IMQ["In-memory update queue"]
    end
    IMQ -->|"flush every few seconds"| RQU["Redis: shared spend-update queue"]
    RQU --> LK{"Which pod holds<br/>the distributed lock?"}
    LK -->|"exactly one"| FL["Lock holder aggregates<br/>the whole queue"]
    FL -->|"one batched transaction"| PG["Postgres"]
    LK -->|"all others"| SK["Skip: keep queueing"]

    classDef good fill:#90EE90
    classDef infra fill:#e1f5ff
    classDef warn fill:#FFE4B5
    class FL,PG good
    class RQU infra
    class LK warn
```

Instead of N instances contending on the same rows, each queues its updates in Redis and a **single** lock-holding instance aggregates and commits them in one transaction. Contention on the hot rows drops to one writer. It is enabled with `use_redis_transaction_buffer: true`, and watched with the queue-depth gauges and pod-lock-manager metric LiteLLM exposes.

**We do not have this path, because we do not have Redis.** That is the real cost of the in-memory decision, and it is a larger one than the rate-limit imprecision that decision is usually framed around. Without the buffer there is nothing between the fleet and the accounting rows, so database write volume is the ceiling on how far this architecture scales — and it is a ceiling that arrives as deadlocks and pool exhaustion rather than as a graceful slowdown.

Three things keep us comfortably under it:

- **The largest writer is gone.** Per-request spend-log inserts were the dominant write, and they now go to S3 instead. What remains hitting Postgres is spend attribution — a much smaller number of updates to a much smaller set of rows. This is the sense in which the cold-storage decision is what makes the no-Redis decision safe rather than merely cheaper.
- **`proxy_batch_write_at` amortizes what is left.** Each instance accumulates spend and flushes in batches rather than per request, which is the same many-writers-into-fewer-transactions idea as the Redis buffer, just without cross-instance aggregation. It is strictly weaker — N instances still contend, just less often — and it is the main dial available to us.
- **Size the connection pool against `instances × workers`.** Every worker process holds its own pool, so the connection count is multiplied by exactly the same factor as the rate limits were. This is the third appearance of that product in this document, and the third reason to set worker count deliberately in one place.

The architectural consequence to internalize: **above roughly a thousand requests per second, Redis stops being an optional cache and becomes part of the accounting path.** Deferring it is a legitimate choice at our volume and a structurally incomplete one at high volume. What makes the deferral responsible rather than lucky is knowing the threshold and instrumenting for it — deadlock counts and Postgres connection saturation belong on the same dashboard as the upstream 429 rate, because those two graphs are the pair that says the no-Redis architecture has run out of room.

## 📊 Counting Requests, Not Tokens

LiteLLM prices in dollars from token counts. The internal quota system counts *requests*. Reconciling those is the last piece, and the draft's two options are not equivalent — one of them does not work.

**The callback approach does not.** Assigning `_hidden_params["response_cost"]` inside a `success_callback` runs after the cost has already been computed and attributed for that request. You end up with a value that is right in your own log line and wrong everywhere it matters — the spend tables, the budget check, the customer info endpoint. Worse, it is wrong *inconsistently*, which is the hardest kind of accounting bug to notice.

**The configuration approach does.** LiteLLM supports custom pricing declared on the model — any pricing key from its cost map can be overridden in the model's config — and a margin configuration that adds a fixed amount per request. Because the number is produced by the cost calculation itself, every consumer agrees:

```yaml
cost_margin_config:
  global:
    fixed_amount: 1.0          # one unit per request

model_list:
  - model_name: gpt-4
    litellm_params:
      model: azure/gpt-4
      api_key: os.environ/AZURE_API_KEY
    model_info:
      input_cost_per_token: 0   # zero out tokens so only the fixed amount remains
      output_cost_per_token: 0
```

Two consequences worth stating out loud before adopting it:

- **You lose the real cost.** Zeroing token pricing means the system no longer knows what anything actually cost in dollars. For a gateway whose reason for existing includes cost attribution, that is a large thing to give up for a unit conversion. The better shape is to keep true pricing as the cost model and express the request quota as a *rate limit* (`rpm_limit`), which is what a request quota actually is — reserving budget for money. If the quota genuinely must be a consumable balance rather than a rate, keep a parallel counter of your own rather than overwriting the price of everything.
- **Verify custom pricing is applied end to end.** There is a reported issue where custom pricing loaded correctly into the model map but failed to reach the final spend calculation. Test it the same way as budgets: make one request, read the recorded cost from the spend tables, assert the number.

## 🛡️ What the Design Was Missing

Four areas that belong in a firm-wide gateway and were not in the original document. Each is cheap to configure and expensive to retrofit after an incident.

### Routing and failover

A single gateway in front of every provider is a single point of failure unless it is configured not to be. LiteLLM's router handles this natively:

```yaml
router_settings:
  routing_strategy: usage-based-routing-v2
  num_retries: 2
  allowed_fails: 3
  cooldown_time: 30
  fallbacks:
    - gpt-4: ["gpt-4-secondary", "claude-sonnet"]
```

`num_retries` governs attempts within a model group; `fallbacks` moves to a different group when those are exhausted, so a provider outage degrades to a slower or cheaper model instead of a wall of 500s. `allowed_fails` plus `cooldown_time` pull a misbehaving deployment out of rotation rather than sending every request into a failing endpoint — the load-balancer circuit breaker, applied to model deployments.

### Security

- **Nothing but the gateway should hold provider credentials**, and no caller should ever use the master key. Issue scoped virtual keys per application, so a leak is bounded by that key's budget and model list instead of your provider account.
- **One key per workload**, so revocation is surgical.
- **Prefer signed identities to shared secrets** for service-to-service traffic. JWT-based auth against the firm's OIDC provider maps claims onto users, teams and models — which fits an environment that already has Kerberos for humans and needs something for workloads.
- **Enable audit logging** for key creation, deletion, role changes and team updates. For a system that gates spend, who changed a budget is as important as what it was.

### Performance

The proxy's own overhead is small — sub-10ms at the P95 at meaningful request rates, on the order of a few milliseconds against a raw provider call — and a single instance has been tested into the thousands of QPS. The dominant configuration mistake is worker count: **set workers to the CPU count**. Under-provisioned workers show up as a proxy that is slow while its CPU sits near idle, which reads like a network problem and is not. Note the symmetry with everything else here — the same `workers` number multiplies your rate limits, your database connections and your throughput, so it is worth setting deliberately in one place and referencing it in the others.

### Observability

Everything above is only manageable if it is visible. LiteLLM exposes Prometheus metrics on `/metrics`, and four families matter here:

| Signal | Why it is the one to watch |
|---|---|
| Spend and remaining-budget gauges per key/team | The whole point of the system, and the input to "warn at 80%" alerts |
| Spend-update queue depth (in-memory and Redis) | Monotonic growth means the flusher is losing; the earliest warning of database pressure |
| Pod lock manager | Confirms exactly one instance is flushing, which is the invariant the transaction buffer rests on |
| Request latency and error rate by model and provider | Separates "the gateway is slow" from "the provider is slow", which is otherwise unanswerable |

One flag worth knowing: by default budget metrics appear only for identities that have received traffic, so a key sitting at 99% of budget and idle is invisible. Setting `prometheus_initialize_budget_metrics` emits them for everything, which is what you want for alerting on approach rather than on breach.

## 🧱 The Approval Workflow Nobody Ships

LiteLLM enforces budgets; it does not have a request-and-approve workflow for changing them. Its management endpoints are administrative CRUD — create a customer, update a budget, list users, assign roles — and they assume the caller is already authorized.

That gap is real and correctly identified, and the shape of the answer is a thin layer of your own:

- A **request** endpoint any user can call, which writes a pending record and notifies an approver. No LiteLLM call happens here.
- An **approval** endpoint restricted to approvers, which on approval calls the corresponding management endpoint and records who approved what, when and why.
- **Role checks backed by the firm's authorization service**, not a hardcoded list — the current arrangement works and does not survive its first audit.

The design principle worth holding: the approval layer should be the *only* thing that calls the mutating management endpoints in production, so that every budget change has a reason attached to it. Direct access is what turns a spend control into a suggestion.

## 🗺️ The Rollout

**Phase 1 — Persistence, budgets and cold storage. Shipped.** Postgres for accounting with migrations owned by the proxy, secrets out of ConfigMaps, prompts and per-request logs to S3 under a lifecycle policy, and rate limits left in memory with per-user values sized against `provider quota ÷ (instances × workers)`.

*Done when:* a deliberately over-budget identity is rejected by a pod that did not record the spend; a request's payload can be read back out of the bucket; no credential appears in any ConfigMap; and the sized per-user limit is written down next to the instance and worker counts it was derived from.

**Phase 2 — Redis, if and when.** Not scheduled, and deliberately so. The trigger is not a date but a threshold, and there are three: sustained load approaching the deadlock region, Postgres connection saturation or deadlock counts appearing at all, or a policy change that makes limits a fairness mechanism rather than a safety valve. Any one of those makes Redis the answer, and the transaction buffer and the exact limiter arrive together.

*Done when:* a load test at N instances shows the aggregate limit equal to the configured limit rather than a multiple of it; and a deliberate Redis outage produces the failure behaviour you chose, not the one you discovered.

The ordering is right for a reason worth naming: persistence has no workaround, while imprecise rate limiting has one — set the limits lower. Phase 1 buys a capability that did not exist; Phase 2 buys precision on a capability that already works well enough, plus headroom we do not yet need. Ship the capability first, and write down the number that tells you when "well enough" stops being true.

## 📝 Conclusion

The gateway's original design got the hard architectural decision right: one authenticated entry point, with a custom auth hook translating the firm's identity system into the proxy's. Everything in this document is downstream of that, and none of it requires changing it.

The lesson that generalizes past LiteLLM is about where state lives. A rate limiter is a counter, and a counter in a process's memory is correct exactly once — the moment you run a second process, the policy you wrote down and the policy you enforce diverge, silently and in the permissive direction. Nothing errors. No alert fires. The only visible symptom is a bill, or a 429 from someone else's API. **Any limit that is not shared is not a limit; it is a limit multiplied by your replica count** — and the multiplier includes worker processes, which is why it is usually larger than people expect. We chose to live with that multiplier rather than take a hard dependency on a cache, which is a perfectly good answer *provided the multiplier is a number you maintain*. An unshared limit you have sized against is engineering; an unshared limit you have not is a surprise waiting for a scale-out.

The second lesson is that persistence relocates the bottleneck rather than removing it. Postgres makes spend durable and then becomes the contended resource, and the mature answer routes accounting writes through a queue and a single flusher instead of letting every instance contend on the same rows. Declining Redis declines that fix too — which is why the decision that mattered most here was not about the cache at all. Taking the largest writer off the database entirely, into object storage that nothing on the hot path reads, is what created the headroom the queue would otherwise have provided. **When you cannot make the writes cheaper, make there be fewer of them**, and the best candidate is always the data you are storing because it might be useful rather than because something depends on it.

The third is about coupling. These three decisions look independent on a slide — a cache choice, a database choice, a storage choice — and they are not. Declining Redis raises the cost of every database write; moving logs to S3 lowers the number of them; and the volume at which the storage argument fails is roughly the volume at which the cache argument fails too. Architectures fail at their seams, and the useful artifact from a design like this is not the diagram but the arithmetic underneath it — the numbers that say which assumption breaks first, and what you will see when it does.

And the fourth is about verification. Budgets and rate limits fail permissively: a limiter that is not registered, a budget that is not read, a custom price that never reaches the spend calculation. All of them look exactly like a healthy system. The only way to know a control works is to trip it deliberately — over-spend a test identity, breach a limit from N pods at once, read the recorded cost back and check the number — and to do it on every version bump, because these are the bugs that come back.

## 🎓 Key Takeaways

- **An in-memory rate limit is multiplied, not approximated.** The effective ceiling is `configured × instances × workers`, and workers default to one per CPU core — so an 8-core pod is already 8× before replicas. Keeping it in memory is defensible; keeping it in memory *without* sizing per-user limits at `provider quota ÷ (instances × workers)` is not. That makes rate-limit safety a function of the deployment, so scaling out becomes a change that requires recomputing the limit.
- **Adding Redis is an availability decision, not a caching decision.** Exact limits come from atomic check-and-increment executed inside Redis, which puts it in the request path. In the current limiter generation a Redis outage fails requests rather than degrading to local counting. We chose fail-open imprecision over a hard dependency for a gateway the whole firm calls — and accepted that the upstream provider's 429 rate is now the alarm that says our sizing has gone stale.
- **Declining Redis costs more than limit precision.** It also declines the transaction buffer that keeps Postgres from deadlocking under concurrent spend updates, so database write volume becomes the ceiling on the architecture. Budget for that explicitly, or the decision is only half made.
- **Move the biggest table out of the database, not just prune it.** Per-request logs and prompts are ~1–2 KB each (10× with payloads) and nothing on the hot path reads them — S3 through the cold-storage logger is where they belong. Crucially, `disable_spend_logs: true` does **not** break budgets: enforcement reads the running spend on key/user/team rows, not the log table.
- **Do not enable both prompt destinations.** `store_prompts_in_cold_storage` and `store_prompts_in_spend_logs` both `true` writes payloads to S3 *and* keeps them in Postgres — the 10× multiplier and the governance exposure you moved them to avoid. The second must be `false`.
- **Object storage is an audit record, not an index.** S3 answers bulk forensic questions cheaply and interactive per-request search not at all, without Athena or a pipeline. Settle that expectation before switching the table off.
- **A generic cache adapter does not buy you distributed rate limiting.** The limiter depends on server-side atomic scripts, not on `get_cache` / `set_cache`. Porting it to Hazelcast means reimplementing the limiter and tracking upstream changes forever — price it as that, not as an integration.
- **Let LiteLLM own its schema.** It ships Prisma migrations and its own tables; hand-written DDL with different names is invisible to the proxy, so enforcement silently does nothing. Read from those tables, never write to them.
- **Budget freshness is a bound you choose, not a percentage.** Worst-case overspend ≈ `(cache TTL + batch write interval) × instances × spend rate`. Where a budget must be hard, `fail_closed_budget_enforcement` trades availability for it — deliberately and narrowly.
- **Storing prompts is a data-classification decision, not a config toggle** — every client name and position figure anyone pastes in, persisted under an access boundary that is not the source system's. Wherever it lands, it needs an owner, a retention rule and a lifecycle policy.
- **Postgres becomes the bottleneck around 1,000 RPS or ~10 instances**, as every instance updates the same key/user/team rows. The fix routes updates through a Redis queue with a single lock-holding flusher committing one batched transaction — so Redis ends up in the accounting path whether or not you adopted it for rate limiting. Knowing that threshold is what makes deferring it responsible rather than lucky.
- **Config that parses is not config that works.** The cold-storage key was documented under one name while the code read another, and prompt storage has shipped writing empty objects — both fail silently, in the permissive direction. Pin the version, and make "one request, then read the object back out of the bucket" an acceptance test you re-run on every upgrade.
- **Dev credentials do not belong in a deployable config.** LocalStack's `test`/`test` keys, a localhost endpoint, and `s3_verify: false` are correct on a laptop and disastrous in a cluster — the last one disables TLS verification on the channel carrying the prompts you moved to S3 for governance reasons. On EKS, omit the keys and let boto3's default chain pick up the pod's IRSA role.
- **Never repurpose the price field to model a request quota.** Zeroing token costs to make every call cost "1" destroys the cost attribution the gateway exists to provide. A request quota is a rate limit; express it as one, and keep true pricing.
- **These controls fail permissively, so verify them by tripping them.** Over-spend a test identity and confirm the rejection comes from a *different pod* than the one that recorded the spend. An enforcement mechanism you have never seen say no is a hypothesis.
- **Secrets do not belong in ConfigMaps.** Database URLs, Redis passwords, the master key and the salt key all belong in a Secret backed by the firm's vault — and the salt key must not be rotated after credentials are stored, because it is what encrypted them.

## 📖 References

- [LiteLLM — Production Best Practices](https://docs.litellm.ai/docs/proxy/prod)
- [LiteLLM — High Availability Setup (Resolve DB Deadlocks)](https://docs.litellm.ai/docs/proxy/db_deadlocks)
- [LiteLLM — Redis Sizing](https://docs.litellm.ai/docs/proxy/redis_sizing)
- [LiteLLM — Database Sizing](https://docs.litellm.ai/docs/proxy/db_sizing) and [What is stored in the DB](https://docs.litellm.ai/docs/proxy/db_info)
- [LiteLLM — Maximum Retention Period for Spend Logs](https://docs.litellm.ai/docs/proxy/spend_logs_deletion)
- [LiteLLM — Logging (S3 and the `s3_v2` callback)](https://docs.litellm.ai/docs/proxy/logging), [UI Spend Log Settings](https://docs.litellm.ai/docs/proxy/ui_spend_log_settings) and [config settings reference](https://docs.litellm.ai/docs/proxy/config_settings)
- [LiteLLM — User Management Hierarchy](https://docs.litellm.ai/docs/proxy/user_management_heirarchy) and [Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)
- [LiteLLM — Security Best Practices](https://docs.litellm.ai/docs/proxy/security_best_practices) and [Rotating the Master Key](https://docs.litellm.ai/docs/proxy/master_key_rotations)
- [LiteLLM — Custom LLM Pricing](https://docs.litellm.ai/docs/proxy/custom_pricing) and [Fee/Price Margin on LLM Costs](https://docs.litellm.ai/docs/proxy/provider_margins)
- [LiteLLM — Prometheus metrics](https://docs.litellm.ai/docs/proxy/prometheus)
- [LiteLLM — Server Tuning](https://docs.litellm.ai/docs/proxy/server_tuning) and [Proxy Performance](https://docs.litellm.ai/docs/proxy/perf)
- [LiteLLM — Fallbacks (Provider Failover)](https://docs.litellm.ai/docs/proxy/reliability)
- Issue [#13202](https://github.com/BerriAI/litellm/issues/13202) — multi-instance limits landing at `threshold × instances × num_workers`
- Issue [#14820](https://github.com/BerriAI/litellm/issues/14820) — requests fail when Redis is down under v3 rate limiting
- Issue [#14097](https://github.com/BerriAI/litellm/issues/14097) — budget and limit precedence: user limits ignored when a team is present
- Issue [#27381](https://github.com/BerriAI/litellm/issues/27381) — budget limiter instantiated but never registered
- Issue [#11975](https://github.com/BerriAI/litellm/issues/11975) — custom pricing in `model_info` not applied to cost tracking
- Issue [#15796](https://github.com/BerriAI/litellm/issues/15796) and PR [#15798](https://github.com/BerriAI/litellm/pull/15798) — the cold-storage logger key documented under one name while the code read another
- Issue [#15641](https://github.com/BerriAI/litellm/issues/15641) — `store_prompts_in_spend_logs` writing empty objects in v1.77.2
- Issue [#10278](https://github.com/BerriAI/litellm/issues/10278) — assuming an AWS IAM role for S3 logging rather than passing static credentials
- PR [#9690](https://github.com/BerriAI/litellm/pull/9690) and PR [#11283](https://github.com/BerriAI/litellm/pull/11283) — deadlock reduction, and sliding-window logic in the v2 limiter

## 📚 Related Concepts

- [Rate Limiter](../ProblemBreakdowns/RateLimiter.md) — the counter-in-a-shared-store problem this design is a production instance of.
- [Redis (Deep Dive)](../DeepDives/Redis.md) — single-threaded atomic execution and server-side scripting, which is exactly what the exact limiter depends on.
- [Distributed Locking](../../CoreConcepts/DistributedLocking.md) — the mechanism behind "exactly one instance flushes the spend queue".
- [Caching](../../CoreConcepts/Caching.md) — TTL as a staleness budget, which is what bounds budget-enforcement error here.
- [Dealing with Contention](../Patterns/DealingWithContention.md) — many writers converging on the same rows, and why batching through one committer resolves it.
- [Scaling Writes](../Patterns/ScalingWrites.md) — the queue-and-flush shape that keeps the spend ledger from becoming the bottleneck.
- [API Gateway](../DeepDives/ApiGateway.md) — authentication, routing and rate limiting at a single entry point, of which this is a domain-specific case.
