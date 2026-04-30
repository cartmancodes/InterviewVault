# Design Payment System

> **Pattern**: Ledger / Idempotency
> **Difficulty**: Hard
> **Source**: [hellointerview.com](https://www.hellointerview.com/learn/system-design/problem-breakdowns/payment-system)

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
   - [Functional Requirements](#functional-requirements)
   - [Non-Functional Requirements](#non-functional-requirements)
2. [Core Entities](#core-entities)
3. [API Design](#api-design)
4. [High-Level Design](#high-level-design)
5. [Deep Dives](#deep-dives)
   1. [Idempotency End-to-End](#1-idempotency-end-to-end)
   2. [Double-Entry Ledger](#2-double-entry-ledger)
   3. [PSP Integration (Stripe/Adyen)](#3-psp-integration-stripeadyen)
   4. [Consistency vs Availability for Money](#4-consistency-vs-availability-for-money)
   5. [Reconciliation and Settlement](#5-reconciliation-and-settlement)
6. [Scaling Journey: 0 to Infinity](#scaling-journey-0-to-infinity)
   - [Stage 1: 0 to 100 Transactions per day (MVP)](#stage-1-0-to-100-transactionsday-mvp)
   - [Stage 2: 100 to 10K Transactions per day](#stage-2-100-to-10k-transactionsday)
   - [Stage 3: 10K to 1M Transactions per day](#stage-3-10k-to-1m-transactionsday)
   - [Stage 4: 1M to 100M Transactions per day](#stage-4-1m-to-100m-transactionsday)
   - [Stage 5: 100M+ Transactions per day (Hyperscale)](#stage-5-100m-transactionsday-hyperscale)
7. [Insider Tips and Tricks](#insider-tips-and-tricks)
8. [Expected Depth by Level](#expected-depth-by-level)

---

## Understanding the Problem

A payment system sits between merchants, customers, and one or more external payment service providers (PSPs like Stripe, Adyen, Braintree). Its job is to accept a charge request, move money from the customer's funding source to the merchant's account, and record that movement in a way that survives retries, partial failures, and audits. The hard part is not the happy path; it is guaranteeing that every dollar is accounted for exactly once even when the network, the PSP, or your own services fail mid-transaction.

### Functional Requirements

**Core**
- Merchants can initiate a payment request to charge a customer a specific amount for a specific order.
- Customers can pay using credit or debit cards (the PSP tokenizes the card; we never see PAN data).
- Merchants can poll or subscribe to status updates for a payment: `PENDING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `REFUNDED`.
- Every state transition is written to an append-only ledger that reconciles against the PSP's record of truth.

**Out of scope (below the line)**
- Stored payment methods / card-on-file vaulting (delegated to the PSP's vault).
- Partial or full refunds (can be a follow-on deep dive).
- Recurring billing and subscriptions.
- Payouts to merchants (batch settlement is mentioned but not fully designed).
- Multi-currency FX conversion and cross-border routing.
- Fraud scoring and chargeback lifecycle.

### Non-Functional Requirements

**Core**
- **Correctness over availability on the write path.** No double-charges, no lost captures, no phantom credits. If we must choose, we fail the request rather than risk a duplicated debit.
- **Idempotency end-to-end.** Every money-moving call is safe to retry without side effects.
- **Auditability.** Every state change is append-only, timestamped, and traceable to an API call, a user, and a PSP event. Regulators and accountants must be able to replay history.
- **Scale.** Peak load target around 10,000 TPS, with steady-state in the hundreds-to-low-thousands.
- **Latency.** Authorize under ~500 ms P95 (dominated by PSP round trip). Status reads under ~50 ms P95.

**Below the line**
- PCI-DSS compliance. Raw card data never touches our servers; the PSP's hosted fields / SDK returns a token.
- Durable write-ahead for ledger entries. Losing a ledger row is a regulatory incident.
- Encryption at rest for the tokens and metadata; TLS 1.2+ in transit.
- Observability: transaction success rate, PSP latency, reconciliation drift, idempotency-key collision rate.

---

## 🧒 Layman's Explanation

Imagine a small coffee shop that uses **double-entry bookkeeping**. Every dollar that moves leaves two records — "money out of the customer's account" AND "money into the shop's account." If the two sides don't match, something is broken. That paired-record discipline is the foundation of every payment system, big or small.

Now picture a **bank teller with a stamping mat**. Every transaction is stamped, dated, and entered into a ledger book. You can't erase entries; you can only add a new "correction" entry next to the old one. That's the *immutable ledger* — the audit trail that lets you answer "where did the $3 go?" six months later.

When you Venmo a friend, your bank doesn't actually beam money over the wire. It just *promises* to settle up later. The actual money movement happens overnight, batch-style, between banks — a giant **handshake between institutions**. That gap between "promised" and "really moved" is called clearing and settlement.

A few other ideas the system must respect:

- **Idempotency** — if your phone retries a payment after a crash, the system must not charge you twice. Each payment gets a unique ID, like a numbered raffle ticket; the second ticket with the same number is ignored.
- **ACID transactions** — money can never be in two accounts at once or in zero accounts. Either both ledger entries commit together, or neither does. No half-moves.
- **Reconciliation** — at end of day, the shop's internal ledger must match the bank statement to the penny. Any drift is either a bug or fraud, and you must hunt it down.
- **The "exactly-once" myth** — there's no true exactly-once delivery in distributed systems. You get "at-least-once + idempotency keys," which produces the same outcome from the user's point of view.
- **Saga patterns** for cross-service flows — book hotel + book flight + charge card; if any one step fails, the others must roll back via *compensating transactions* (cancel the hotel, refund the card).

### When the analogy breaks down

Real payment systems do far more than the coffee-shop ledger. They run **fraud detection** models on every charge, fight **chargebacks** months after the fact, juggle **multi-currency** conversions and FX rates, enforce regulatory **KYC/AML** checks before onboarding a merchant, absorb multi-day **settlement delays** from card networks, eat **interchange and scheme fees** on every swipe, and live inside the constant tension between user experience (fast, frictionless) and risk management (cautious, slow). The teller's stamping mat is a great mental model for the ledger; it does not capture the regulatory and adversarial environment that real money lives in.

---

## Core Entities

| Entity | Purpose | Key Attributes |
|--------|---------|----------------|
| **User / Customer** | The person being charged | `user_id`, `email`, `billing_address`, `psp_customer_id` |
| **Merchant** | The party receiving funds | `merchant_id`, `name`, `psp_account_id`, `payout_schedule` |
| **PaymentMethod** | A tokenized funding source | `payment_method_id`, `user_id`, `psp_token`, `brand`, `last4`, `exp_month`, `exp_year` (no PAN, no CVV) |
| **Transaction** | A single attempt to move money | `transaction_id`, `merchant_id`, `user_id`, `payment_method_id`, `amount_cents`, `currency`, `status`, `psp_charge_id`, `idempotency_key`, `created_at`, `updated_at` |
| **LedgerEntry** | An immutable accounting row | `entry_id`, `transaction_id`, `account_id`, `direction` (DEBIT/CREDIT), `amount_cents`, `currency`, `posted_at` |
| **Account** | A logical bucket in the ledger | `account_id`, `owner_type` (user/merchant/platform/psp_clearing), `owner_id`, `currency` |
| **Payout** | A batched transfer to a merchant | `payout_id`, `merchant_id`, `amount_cents`, `currency`, `period_start`, `period_end`, `psp_payout_id`, `status` |
| **IdempotencyKey** | De-dup record for write APIs | `key`, `request_hash`, `response_payload`, `status`, `expires_at` |

Key relationships: every Transaction writes two or more LedgerEntry rows that sum to zero (double-entry). A Transaction belongs to one Merchant and references one User and one PaymentMethod. Payouts aggregate many Transactions over a settlement window.

Note that monetary amounts are stored in the smallest denomination of the currency (`amount_cents` for USD/EUR, integer yen for JPY). Never use a float column for money.

---

## API Design

```
# Create a charge (merchant-initiated, idempotent)
POST /v1/payments
  headers: { Idempotency-Key: "uuid-from-merchant" }   # client-generated, mandatory
  body:    { merchant_id, amount_cents, currency, payment_method_token, metadata }
  -> 201  { transaction_id, status: "PENDING" | "AUTHORIZED", psp_charge_id }

# Capture an authorized payment (for auth/capture flows)
POST /v1/payments/{transaction_id}/capture
  headers: { Idempotency-Key: "..." }
  body:    { amount_cents? }    # optional partial capture
  -> 200  { transaction_id, status: "CAPTURED" }

# Read status
GET  /v1/payments/{transaction_id}
  -> 200  { transaction_id, status, amount_cents, currency, created_at, ledger_entries: [...] }

# Webhook from PSP (signed)
POST /v1/webhooks/psp
  body:    { event_type, data: { charge_id, status, ... } }
  -> 200  { received: true }
```

Notes:
- `Idempotency-Key` is mandatory on all write endpoints and **must be generated by the client before sending the request** — not by the server on receipt. A UUID generated on the client side is correct. Two requests with the same key return the same response, even days apart.
- `payment_method_token` is the PSP's token; we never accept a PAN. The mobile/web client talks directly to the PSP SDK to exchange card data for a token.
- Auth is mTLS or signed API keys for merchant-to-server calls; customer-facing flows use short-lived session tokens minted by the merchant's backend.
- Webhook signatures are verified on every call; the handler is itself idempotent (the `event_id` is the natural idempotency key).
- `amount_cents` is always an integer representing the currency's smallest unit. The display layer converts to decimal representation.

---

## High-Level Design

```
                        +-----------------------+
   Merchant backend --> |   API Gateway / WAF   | -> auth, rate-limit, mTLS
                        +-----------+-----------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
          Payment Service                     Webhook Handler
          (orchestrator)                        (PSP callbacks)
                  |                                   |
          +-------+--------+                          |
          |                |                          |
   Idempotency Store   Ledger Service  <--------------+
      (Postgres /         (Postgres,
       Redis + DB)      double-entry,
                        strong write
                        consistency)
          |
          v
   PSP Adapter  --->  Stripe / Adyen / Braintree
          |
   Outbox table --> Kafka --> [ Notification, Analytics, Search projection, Reconciliation ]
```

- **API Gateway** terminates TLS, enforces mTLS for merchant traffic, rate-limits by API key, and routes to the Payment Service.
- **Payment Service** is the orchestrator. It validates the request, checks/writes the idempotency key, calls the PSP via the adapter, and writes ledger entries in a single transactional unit (via outbox).
- **Idempotency Store** records every write request's key + body hash + response. Short path: Redis for hot lookups backed by Postgres for durability; all state-changing decisions take a lock on the key row.
- **Ledger Service** owns the double-entry ledger. It is the only component allowed to write `LedgerEntry` rows. Writes are append-only.
- **PSP Adapter** wraps each PSP behind a common interface so we can add or swap providers without touching the Payment Service.
- **Webhook Handler** is the second source of truth ingestion. PSPs fire asynchronous events (`charge.succeeded`, `charge.failed`, `charge.refunded`) that may arrive before or after our synchronous response. The handler reconciles these into the ledger.
- **Outbox + Kafka** decouples downstream consumers (email receipts, analytics, reconciliation) from the write path so that a downstream outage never blocks a payment.

---

## Deep Dives

### 1. Idempotency End-to-End

The core invariant: if a merchant sends the same `POST /payments` request twice (because the first response timed out), we charge the customer once and return the same `transaction_id` both times.

**The client-generation requirement.** The idempotency key must be generated by the client *before* the first request is sent, not by the server on receipt. If the server generated the key, a network timeout (client never receives the response) would cause the client to retry with no key — the server generates a new one and the payment runs twice. The client generates a UUID, stores it locally, and re-sends it on every retry attempt. Stripe, Braintree, and Adyen all mandate this pattern in their API contracts.

**Layer 1: the idempotency key table.** On every write, Payment Service does:

```sql
INSERT INTO idempotency_keys (key, request_hash, status, created_at)
VALUES ($1, $2, 'IN_PROGRESS', now())
ON CONFLICT (key) DO NOTHING
RETURNING *;
```

Three outcomes:
- Insert succeeded -> this is a fresh request, proceed with PSP call.
- Insert conflicted and existing row is `COMPLETED` -> return the cached response payload, do nothing else.
- Insert conflicted and existing row is `IN_PROGRESS` -> return HTTP 409 `{ "error": "request_in_progress" }` so the client retries later (or we wait briefly on a row lock).

We also store a hash of the request body. If the same key is reused with a different body, we reject with `422` -- this catches merchant bugs where they reuse a key across unrelated charges.

**Layer 2: idempotent PSP calls.** Stripe and Adyen both accept their own idempotency key header. We pass through a deterministic derivation (e.g., `{our_transaction_id}-charge`) so that a network retry against the PSP does not result in two charges either. This is a critical second layer: even if our idempotency store fails, the PSP's own deduplication is a backstop.

**Layer 3: idempotent ledger writes.** The `LedgerEntry` table has a unique constraint on `(transaction_id, account_id, direction, sequence)`. Re-applying the same ledger operation is a no-op due to the conflict constraint. This means a retry of the entire payment flow that makes it past the idempotency key check is still safe at the ledger layer.

**Layer 4: idempotent webhook handling.** Every PSP webhook carries a unique `event_id`. The webhook handler checks this against a `webhook_events` dedupe table before processing. PSPs commonly retry webhooks for up to 72 hours; without this layer, a transient webhook handler failure causes duplicate state transitions.

**Retention.** Keep idempotency rows for at least 24 hours, ideally 7 days. After that, a replayed request would appear fresh, but PSPs hold their idempotency records for a similar window, so the PSP layer still catches duplicates.

**The PENDING recovery path.** When the synchronous PSP call times out, the transaction remains `PENDING` and the idempotency key is left `IN_PROGRESS`. A background worker queries transactions in `PENDING` state older than a configurable threshold (e.g., 2 minutes) and calls the PSP's retrieve API (`GET /charges/{psp_charge_id}`) to learn the true final state. This closes the gap between timeout ambiguity and final consistency without requiring a client retry.

### 2. Double-Entry Ledger

Every payment is not a single row update; it is a set of balanced journal entries. For a $100 charge with a $3 PSP fee:

```
Debit  user:alice           $100
Credit psp_clearing         $100
--- (at settlement) ---
Debit  psp_clearing         $100
Credit merchant:acme         $97
Credit platform_revenue       $3
```

Two hard rules:
1. **Every transaction's entries sum to zero per currency.** Enforced at write time with a check constraint, and validated by a nightly `SELECT SUM(CASE WHEN direction='DEBIT' THEN amount_cents ELSE -amount_cents END) FROM ledger_entries` job that pages if the result is non-zero.
2. **Ledger rows are append-only.** Corrections happen via reversing entries, never by mutating a prior row. This preserves the audit trail and makes the invariant checkable without needing distributed locks.

**Why double-entry over a single `balance` column?** A balance column is fast but lies the moment something goes wrong mid-transaction: you see a debit without the paired credit, or vice versa. With double-entry the invariant is provable by a single `SELECT SUM(CASE WHEN direction='DEBIT' THEN amount_cents ELSE -amount_cents END) FROM ledger_entries WHERE account_id = ?`. Balance becomes a materialized view over the ledger, regenerable at any time. If the materialized balance ever disagrees with the journal sum, there is a bug — and you can find it.

**Event sourcing angle.** The ledger *is* the event log. Snapshots (account balance at end-of-day) are periodic materializations for fast reads, but the journal remains the source of truth. This is how you debug a "where did the $3 go" question six months later. You can reconstruct any account's state at any point in time by replaying from the journal.

**Reversals, not updates.** If a captured payment must be corrected, you do not update the original entries. You post a reversing journal: `Credit user:alice $100`, `Debit psp_clearing $100`, with a `reversal_of` foreign key pointing to the original transaction. The audit trail is complete; no row was ever mutated.

**Schema sketch.**

```sql
CREATE TABLE ledger_entries (
  entry_id       UUID PRIMARY KEY,
  transaction_id UUID NOT NULL,
  account_id     UUID NOT NULL,
  direction      CHAR(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),   -- integer, never float
  currency       CHAR(3) NOT NULL,
  sequence       INT NOT NULL,
  posted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, account_id, direction, sequence)
);
CREATE INDEX ON ledger_entries (account_id, posted_at);
```

`BIGINT` not `FLOAT` and not `NUMERIC(18,4)`: integers are exact; floats are not. $10.50 is stored as `1050`. A lost half-cent on a floating-point rounding error is a ledger-breaking bug that is nearly impossible to detect at scale.

### 3. PSP Integration (Stripe/Adyen)

The Payment Service never talks to a card network directly. It talks to a PSP, which handles PCI, card-network routing, 3DS, and fraud. The integration has three surfaces:

**Synchronous API call (authorize/capture).**
```
1. Payment Service writes idempotency row (IN_PROGRESS) + transaction row (PENDING) in one DB txn.
2. Payment Service calls PSP.charges.create(...) with its own idempotency key (derived from transaction_id).
3. On 2xx: update transaction to AUTHORIZED/CAPTURED, write ledger entries, mark idempotency row COMPLETED. All in one DB txn.
4. On 4xx (hard failure): update transaction to FAILED, mark idempotency row COMPLETED with the failure payload.
5. On 5xx or timeout: leave transaction in PENDING. Mark idempotency row IN_PROGRESS. Rely on webhook reconciliation and the PENDING recovery worker to finalize.
```

The critical rule: **never hold a DB transaction open across the PSP HTTP call.** The PSP round trip is 200 to 2000 ms; holding a connection open across it strangles the connection pool at modest concurrency. Open a txn, write pending state, commit, call PSP, open a second txn, write final state. Yes, this means two write transactions per charge and a window of ambiguity between them. That window is resolved by the webhook handler and the PENDING recovery worker.

**Webhook ingestion.** The PSP will send `charge.succeeded` or `charge.failed` asynchronously. Sometimes the webhook arrives before our sync response, sometimes hours later (during PSP outages). The webhook handler:
1. Verifies the signature header (HMAC-SHA256 for Stripe, HMAC-SHA512 for Adyen). Reject silently on failure — do not log the payload, which may contain PAN fragments.
2. Checks the `event_id` against a `webhook_events` dedupe table (`INSERT ... ON CONFLICT DO NOTHING`).
3. Loads the local transaction by `psp_charge_id`.
4. Applies the state transition *only if* it advances state (PENDING -> AUTHORIZED is valid; AUTHORIZED -> PENDING is not). Use explicit allowed-transition validation, not implicit timestamp comparisons.
5. Writes to the outbox in the same transaction so downstream consumers learn of the transition atomically.

**Adapter pattern for multi-PSP.** Different merchants, regions, or card types may route to different PSPs (primary Stripe, fallback Adyen for EU). A `PSPAdapter` interface with `authorize()`, `capture()`, `refund()`, `parseWebhook()` lets us add a new provider without changing the Payment Service core logic. Routing rules (by country, BIN, merchant preference) live in a separate `PSPRouter` component.

**Circuit breaker.** If a PSP's error rate spikes or P99 latency exceeds a threshold, the circuit breaker trips to OPEN state and fails fast with `503` rather than letting slow PSP responses exhaust the thread pool. A half-open probe request tests PSP health on a timer; successful probes close the circuit. If a fallback PSP is configured, the circuit breaker optionally reroutes in-flight requests rather than failing them. This protects your entire service from a slowdown at one PSP cascading into total unavailability.

**Payment state machine.** State transitions are not inferred from field nullness; they are explicit and validated. The valid transitions are:

```
initiated -> pending -> authorized -> captured -> settled
                    \-> failed
                              \-> refunded (after settled)
                              \-> disputed (after settled)
```

The application layer rejects any transition that is not in the allowed set. You cannot capture a payment that is not authorized. You cannot refund a payment that is not settled.

### 4. Consistency vs Availability for Money

Classic CAP trade-off, but with a thumb on the scale: **for ledger writes, we always pick consistency.** A payment that cannot be recorded correctly is a payment we refuse, not one we accept and reconcile later.

Concrete choices:
- **Ledger DB is a single strongly consistent store** (Postgres with synchronous replication to a standby, or Spanner/CockroachDB at extreme scale). We do not shard the ledger by random hash; we shard by `account_id` or `merchant_id` so all entries for one account are co-resident and transactional.
- **Read paths can be eventually consistent.** Transaction status pages, analytics, merchant dashboards all read from replicas or projections that may lag by seconds. A merchant seeing a 3-second-stale status is fine; a ledger missing a credit is not.
- **Availability is recovered by retries, not by relaxing consistency.** If the ledger primary is down, the API returns `503`. The merchant's SDK retries with the same idempotency key. When the primary comes back, the retry succeeds and the charge is recorded exactly once.
- **No cross-region synchronous writes** unless we are on Spanner-class infra. Instead, each region owns some set of accounts/merchants (account-home-region model); writes for an account always route to its home region.

**The outbox solves the dual-write problem.** A payment service must both update the database and publish a Kafka event. If these are two separate operations, a crash between them produces an inconsistency: DB shows captured, Kafka never hears about it, or vice versa. The outbox pattern writes the business data (ledger entries) and the event row to the same DB transaction. A separate outbox consumer reads unprocessed rows and publishes to Kafka, then marks them processed. The event is published at-least-once and exactly-once in practice because the consumer is idempotent on the event ID.

The one place we accept eventual consistency on the write path is the **outbox**. Ledger entry + outbox row commit together; downstream (Kafka, notifications, search index, reconciliation feed) are eventually consistent projections.

### 5. Reconciliation and Settlement

Even with perfect idempotency and double-entry, our ledger can drift from the PSP's ledger. Causes: webhook lost, PSP-side state change we missed, network partition during capture, manual intervention by the PSP's ops team. Reconciliation closes this gap daily. **Reconciliation is not optional.** It is your source of truth check. Without it, silent payment processing failures compound undetected and eventually produce regulatory penalties.

**Daily reconciliation job.**
1. Pull the PSP's transaction report for the prior day (Stripe's "Balance Transactions" API, Adyen's settlement report). The PSP's records are the authoritative source for what payments actually processed.
2. For each PSP record, look up the local transaction by `psp_charge_id`.
3. Compare state, amount, fees, currency.
4. Emit discrepancies to a `reconciliation_exceptions` table with category: `MISSING_LOCAL`, `MISSING_PSP`, `AMOUNT_MISMATCH`, `STATUS_MISMATCH`.
5. Auto-heal common cases (missed webhook -> re-fire our own webhook handler). Escalate unresolved cases to ops.
6. Discrepancy rates above 0.01% of transaction volume trigger a P1 page. Money bugs do not wait.

**Settlement / payouts.** The PSP holds funds for a rolling window (Stripe default: 2 days), then settles to the merchant. Our payout records mirror this: nightly job aggregates captured transactions per merchant, matches them to the PSP's payout event, and writes the balancing ledger entries (`Debit psp_clearing, Credit merchant`).

**Invariants the recon job verifies.**
- For each day: `sum(debits) == sum(credits)` per currency. A non-zero result means there is a bug somewhere in the ledger write path.
- For each transaction: local status == PSP status. Any mismatch requires investigation within 24 hours.
- For each merchant: `captured_amount - fees - refunds == payout_amount` for the settled window.

**Streaming reconciliation (at scale).** At 10K+ TPS a nightly batch introduces up to 24 hours of undetected drift. Replace or augment the batch with a streaming reconciliation consumer: ingest the PSP's webhook firehose and the ledger's outbox into the same Kafka topic partition-keyed by `psp_charge_id`, and join them within a bounded time window (e.g., 5 minutes). Discrepancies surface within minutes rather than overnight.

---

## Scaling Journey: 0 to Infinity

Every stage answers four questions: what is the goal, what does the architecture look like, what are we explicitly skipping, and what failure mode forces us into the next stage. Note that the bottleneck in payments is rarely raw QPS; it is correctness under partial failure.

### Stage 1: 0 to 100 Transactions/day (MVP)

**Goal.** Ship the simplest thing that correctly charges a card and records the result. Prove the flow end-to-end against Stripe test mode, then switch to live.

**Architecture.**
- Single application server (monolith). One endpoint: `POST /payments`.
- Single Postgres instance with three tables: `transactions`, `ledger_entries`, `idempotency_keys`.
- Synchronous Stripe call inline in the HTTP handler. Flow: insert idempotency row, insert pending transaction, call Stripe, update transaction to captured, write the two balancing ledger entries, return response. Two short DB transactions flanking the Stripe call -- never one long transaction across it.
- Idempotency key is required on the request header and must be client-generated; duplicate keys return the cached response.
- Webhook handler exists but is simple: a single POST endpoint that updates transaction status by `psp_charge_id`.

**What you skip.**
- No outbox, no Kafka, no async workers.
- No separate services -- everything in one process.
- No read replicas, no caching.
- No multi-PSP. Stripe only.
- No automated reconciliation; manual CSV compare once a week.

**Failure mode -> next stage.** Stripe has a 3-minute outage during which 40 charges return 504. Some actually went through on Stripe's side; some did not. Merchants are calling to ask "did my customer get charged?" and we have no answer because we only have local state. Our synchronous design gave up on pending requests, and our webhook handler is unreliable because it runs inline in the same overloaded process. We need to decouple the PSP call from the response, handle webhooks reliably, and recover pending state.

### Stage 2: 100 to 10K Transactions/day

**Goal.** Survive PSP hiccups without losing money or confusing merchants. Make every write safely retryable.

**Architecture.**
- Split the monolith into **Payment Service** (HTTP, orchestration) and **Webhook Handler** (separate process, separate scaling). Still one Postgres.
- Introduce the **outbox pattern**: the ledger write transaction also inserts a row into an `outbox` table. A worker process polls the outbox and publishes events to a lightweight queue (can be Postgres `LISTEN/NOTIFY` at this scale; Kafka comes later). Downstream consumers (email receipts, merchant dashboard updates) live behind the queue.
- Add an **async retry worker** for transactions stuck in `PENDING` longer than a threshold: it queries Stripe by idempotency key to learn the true state, then finalizes locally. This catches every case where the sync request timed out but the charge went through.
- Idempotency key table gets a `status` column (`IN_PROGRESS`, `COMPLETED`, `FAILED`) so retries during in-flight requests get a 409 instead of a double-charge race.
- Postgres gets a read replica for the merchant dashboard and status reads; the write path stays on the primary.
- Introduce structured logging with `transaction_id` as a correlation key. Add metrics: PSP success rate, P99 latency, pending-age histogram.

**What you skip.**
- Still one Postgres primary. 10K/day is ~1 TPS peak; Postgres is bored.
- Still Stripe only. No PSP routing.
- No sharding, no multi-region.
- Reconciliation is still a weekly script, but it now runs against an API rather than a CSV.

**Failure mode -> next stage.** We onboard a large marketplace doing 100 charges per second at peak. Two problems appear. First, the `ledger_entries` table is now tens of millions of rows and account balance queries ("how much do we owe Acme?") take seconds. Second, a junior engineer accidentally runs `UPDATE ledger_entries SET amount = ...` to "fix" a typo and breaks the audit trail. We need a real double-entry ledger with strict invariants and materialized balance views.

### Stage 3: 10K to 1M Transactions/day

**Goal.** Formalize the ledger as the system of record. Scale the write path to hundreds of TPS. Start reconciling automatically.

**Architecture.**
- Introduce a dedicated **Ledger Service**. It is the only component with write access to `ledger_entries`. Its API is narrow: `post_journal(transaction_id, entries[])` with the precondition that entries sum to zero per currency. Ledger rows are append-only; the service rejects any write that would mutate an existing row (enforced at the DB with row-level triggers and revoked `UPDATE/DELETE` grants).
- Add **account balance snapshots** computed hourly and stored in a separate `account_balances` materialized table, so "current balance" queries do not scan the full journal.
- Replace the Postgres-queue outbox with **Kafka**. Payment Service writes to outbox, a Debezium connector streams outbox to Kafka, consumers subscribe. Notification service, analytics pipeline, and reconciliation feed all become independent Kafka consumers.
- Build an **automated daily reconciliation job** that pulls Stripe balance transactions, compares to the local ledger by `psp_charge_id`, and emits exceptions to a queue watched by ops.
- Introduce a **PSPAdapter interface** and add a second PSP (Adyen) behind it, even if traffic is still 100% Stripe. This forces the abstraction before it is urgent.
- Add a **circuit breaker** around each PSP call. If Stripe's error rate goes above 5% over a rolling minute, fail fast with `503` and let the async retry worker pick up later.
- Payment Service is now horizontally scaled behind an L7 load balancer; Postgres is still a single primary with two read replicas.
- Webhook handler is also horizontally scaled; webhooks are written to a queue first and processed by workers so a traffic burst cannot overwhelm the DB.

**What you skip.**
- Still a single Postgres primary. Writes are in the low thousands of TPS and Postgres handles that fine with PgBouncer and properly indexed tables.
- Ledger is single-region. Disaster recovery is warm-standby in a second AZ, not active-active.
- No sharding yet.

**Failure mode -> next stage.** We start processing for a global marketplace doing 3,000 TPS sustained and 10,000 TPS at flash-sale peaks. The single Postgres primary's write latency climbs above 50 ms as the ledger hits a billion rows, and autovacuum struggles. Separately, we expand to EU and India and a single US-East primary adds 150 ms of round-trip latency to every European charge. We need to shard the ledger and move some writes closer to users.

### Stage 4: 1M to 100M Transactions/day

**Goal.** Scale the write path horizontally without sacrificing the double-entry invariant. Bring latency down for global merchants.

**Architecture.**
- **Shard the ledger by `account_id`.** All entries for a given account live on one shard. Transactions that touch two accounts (every charge touches at least two) require a coordinated write across at most two shards. Implement this with a **two-phase commit coordinator** in the Ledger Service -- or, more practically, **pre-assign every transaction a "home shard" (the merchant's account shard)** and require that all entries for that transaction live there, modeling the user-side debit as an entry on a per-region "customer clearing" account that lives on the same shard. This keeps every ledger write single-shard.
- Introduce a **transaction coordinator**: Payment Service writes the transaction row to a routing table (`transactions_routing`, keyed by `transaction_id` -> shard), then all subsequent writes for that transaction go to the chosen shard.
- **Regional write primaries.** Each region (US, EU, APAC) hosts a subset of shards as primaries. A transaction is pinned to the merchant's home region; customer funds transit through a regional `psp_clearing` account. This removes cross-region synchronous writes from the hot path.
- **Active-passive DR per shard.** Every shard has a synchronous standby in a second AZ and an async replica in a second region. RPO ~0, RTO 2-5 minutes on regional failover.
- **Reconciliation moves to streaming**: instead of a nightly batch, consume Stripe's event stream (or webhook firehose) continuously and compare against the ledger in near-real-time. Drift alerts fire within minutes instead of overnight.
- **Multi-PSP routing becomes active.** PSPRouter picks the cheapest / fastest PSP per BIN and merchant, with automatic failover on circuit-breaker trip. Ledger records the PSP used so recon knows where to look.
- **Dedicated fraud/risk scoring service** on the async path (it advises; it does not block the synchronous flow at this stage).
- Kafka is now the backbone. Outbox -> Kafka -> [notifications, analytics, recon, search projection, fraud scoring, merchant webhook fanout].

**What you skip.**
- No global single ledger view. "Total balance across regions" is an eventual aggregation, not a synchronous query.
- No multi-region active-active writes per shard. A given shard has one writable region at a time.
- Fraud scoring is advisory, not enforcing. That is a separate product investment.

**Failure mode -> next stage.** We become a global payments platform processing tens of thousands of TPS sustained. A single region outage (US-East lightning strike, EU AZ network partition) takes out several hundred merchants for the duration of failover. Large customers demand five-nines availability with zero data loss, which means we can no longer tolerate a 2-minute failover window per shard. We also now operate in jurisdictions with data residency laws (EU data in EU, India data in India) that forbid cross-region replication of certain PII.

### Stage 5: 100M+ Transactions/day (Hyperscale)

**Goal.** Run at Stripe/Adyen scale. Tolerate region failures transparently. Honor data residency. Maintain penny-perfect reconciliation across a globally distributed ledger.

**Architecture.**
- **Per-account consistency, global eventual aggregation.** Each account's ledger lives in a single home region with synchronous replication across multiple AZs. Writes for that account are linearizable within the region. Cross-account operations (e.g., platform-revenue accounting) happen via asynchronous journals that reconcile at the end-of-day boundary.
- **Spanner-class storage for the hottest shards.** Accounts that require multi-region strong consistency (global enterprise merchants) move onto Spanner or CockroachDB with regional primary + synchronous replicas across regions. Everyone else stays on sharded Postgres, which is cheaper and faster within a region.
- **Active-active for reads everywhere.** Every region has a read replica of every shard (subject to residency rules). Merchant dashboards, status polling, and analytics serve from the nearest region.
- **Data residency enforcement at the routing layer.** Merchant metadata includes a `data_region`; Payment Service refuses to accept transactions whose home region violates residency rules. Ledger shards are tagged with residency constraints that the shard router honors.
- **Continuous reconciliation as a first-class system.** A dedicated Reconciliation Service streams every PSP event and every ledger event in parallel, joins them by `psp_charge_id` within a bounded time window, and emits exceptions in seconds. It is instrumented as critical infrastructure, not a cron job.
- **Multi-PSP with smart routing** becomes table stakes. Routing rules optimize for acceptance rate, cost, and local-card-scheme preference per country. Fallback is automatic and recorded in the ledger.
- **Fraud/risk becomes inline** with a strict latency budget (sub-100 ms) and a fallback-to-allow policy if it exceeds its budget. The ledger records a `fraud_score` on every transaction.
- **Formal change control on the ledger schema and balance definitions.** Any schema or account-taxonomy change goes through a double-entry-preserving migration: back-fill, dual-write, switch-read, drop-old. Accountants sign off.
- **Chaos engineering and game-days.** Regular drills that kill a shard primary, drop a PSP connection, or replay a day of webhooks. Reconciliation drift during a drill is a blocking bug.
- **Tiered storage for the ledger.** Entries older than 90 days migrate to a cold store (still queryable, slower). Account balance snapshots stay hot. Query APIs hide this split.

**What you skip.**
- Strong consistency across regions for aggregate balances. Platform-level "how much money is in flight right now" is eventual, with bounded staleness (tens of seconds).
- ML-driven revenue optimization on PSP routing, dynamic fee optimization. These are product bets on top of the platform, not prerequisites.

At this point the bottleneck is organizational, not technical: regulatory approvals, new-country licensing, bank relationships, and the engineering cost of maintaining invariants across a system that now outlives the team members who built it.

---

## Insider Tips and Tricks

### Idempotency Keys Must Be Client-Generated, Not Server-Generated
If the server generates idempotency keys on receipt of a request, a network timeout (client never receives the 200) means the client retries and gets a new server-generated key — the payment runs twice. The client must generate the idempotency key before sending the request (a UUID generated on the client side). On retry, the same key is re-sent. The server detects the duplicate key and returns the cached response without re-processing. Stripe, Braintree, and Adyen all require client-generated idempotency keys.

### The Outbox Pattern Solves the Dual-Write Problem
A payment service must: (1) update account balance in DB; (2) publish "payment completed" event to Kafka. If these are separate operations, a crash between them leaves the system inconsistent. The outbox pattern: write both the balance update AND the event to the same DB transaction (in an `outbox` table). A separate transactional outbox consumer reads unprocessed outbox rows and publishes to Kafka, then marks them processed. The event is published exactly once because it's committed atomically with the business data.

### Double-Entry Bookkeeping Makes Financial Bugs Auditable
Every financial transaction debits one account and credits another — the sum of all debits equals the sum of all credits. If you find an imbalance, there's a bug. This accounting invariant makes silent corruption detectable via a simple `SELECT SUM(amount) FROM transactions` check. Store every financial event as a pair of ledger entries: `(accountA, -$100)` and `(accountB, +$100)`. Never have a unilateral balance change without a corresponding counter-entry.

### Payment States Must Be Explicit and Exhaustive
A payment goes through: `initiated → pending → authorized → captured → settled | refunded | disputed | failed`. Each state must be explicit in the DB. Never infer state from the absence of a field (e.g., "no capture timestamp means not captured" — what if the field is null due to a bug?). Transitions must be validated: you cannot capture a payment that isn't authorized; you cannot refund a payment that isn't settled. Use a state machine with explicit allowed transitions enforced at the application layer.

### PSP (Payment Service Provider) Calls Must Be Wrapped in a Circuit Breaker
If Stripe's API is slow (2-second response instead of 200ms), and 1,000 requests are in-flight, each waiting 2 seconds, your thread pool exhausts. All subsequent requests fail with "no threads available" — not because Stripe is down, but because it's slow. A circuit breaker (half-open/open/closed states) stops sending requests to a degraded PSP after N consecutive failures, failing fast with a clear error. This protects your system from PSP slowness cascading into total failure.

### Reconciliation Is Not Optional — It's Your Source of Truth
Your payment pipeline has bugs you don't know about. The PSP's records are the authoritative source for what payments actually processed. A nightly reconciliation job: (1) downloads the PSP's settlement report; (2) compares every transaction ID against your internal records; (3) flags discrepancies (your DB shows "authorized" but PSP shows "declined" — or vice versa). Discrepancies above 0.01% trigger investigation. Without reconciliation, silent payment processing failures will compound and result in regulatory penalties.

### Currency Handling Requires Storing the Smallest Denomination
Store monetary amounts in the currency's smallest indivisible unit: cents for USD/EUR, pence for GBP, yen for JPY (which has no decimal). `$10.50` is stored as `1050` (integer). Never store `10.50` as a float — floating-point arithmetic is not commutative for financial values ($1.10 + $2.20 ≠ $3.30 in IEEE 754). Display-layer formatting converts from integer cents to the user-facing decimal representation.

### Chargebacks and Disputes Require a Separate System
A chargeback occurs when a cardholder disputes a charge with their bank. The bank reverses the funds immediately; you must respond with evidence within 7-14 days or permanently lose the money. Chargebacks require: a dispute management system, automated evidence collection (transaction logs, delivery confirmation, previous communications), a workflow for human review, and a deadline tracking system. This is a distinct system from the payment processing pipeline — often a third-party integration or a separate internal service.

---

## Expected Depth by Level

| Level | Breadth : Depth | What the interviewer expects |
|-------|-----------------|------------------------------|
| **Mid (E4)** | 80 : 20 | Clean API with idempotency key header. Correct data model including a ledger table. Can explain why single-entry `balance` columns are dangerous. Gets the synchronous happy path right; answers the webhook / retry question when prompted. One correct statement about PCI (tokens, not PANs). |
| **Senior (E5)** | 60 : 40 | Proactively raises idempotency end-to-end (client -> service -> PSP -> ledger). Designs double-entry with clear invariants. Articulates outbox pattern for downstream decoupling. Explains why we never hold a DB transaction across a PSP call. Walks through webhook reconciliation and the PENDING-state recovery path. Names PCI boundary cleanly. |
| **Staff (L6+)** | 40 : 60 | Minimal hand-holding on basics. Deep dives with operational detail: reconciliation drift detection and auto-heal, multi-PSP routing with circuit breakers, ledger sharding strategy (single-shard transactions via clearing accounts), data residency and multi-region trade-offs, capacity planning for flash sales, migration strategy for ledger schema changes. Discusses invariant preservation as a first-class engineering problem, not a nice-to-have. Offers opinions on Spanner vs sharded Postgres with concrete criteria. |
