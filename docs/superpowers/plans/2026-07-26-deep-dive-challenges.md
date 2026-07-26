# Deep-Dive Challenges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four researched, scenario-driven authored checkpoints to each of the Kafka, Cassandra, ZooKeeper, Flink, and Redis deep-dive pages.

**Architecture:** The existing site builder derives each article slug from its Markdown filename and merges `content/challenges/<slug>.json` into that page's challenge payload. Add five independent JSON files using the established duel, ladder, builder, and bottleneck schema; do not modify Markdown, generator code, UI code, or generated `site/` output.

**Tech Stack:** JSON, Node.js ES modules, the existing `tools/gen-challenges.mjs` integration, and InterviewVault's Python/Mermaid/site verification gates.

---

## File Map

- Create `content/challenges/kafka.json`: Kafka ordering, partitioning, delivery, architecture, and skew diagnosis.
- Create `content/challenges/cassandra.json`: query-driven partitioning, quorum consistency, write path, and tombstone diagnosis.
- Create `content/challenges/zookeeper.json`: predecessor watches, quorum/session behavior, leader election, and herd-effect diagnosis.
- Create `content/challenges/flink.json`: event time, watermarks, checkpoints, dataflow construction, and idle-input diagnosis.
- Create `content/challenges/redis.json`: Streams versus Pub/Sub, cluster slots and durability, routed command flow, and hot-key diagnosis.

No shared helper or schema change is needed because `tools/gen-challenges.mjs` already loads authored JSON for every discovered document slug.

### Task 1: Kafka Challenge Set

**Files:**
- Create: `content/challenges/kafka.json`
- Reference: `LLD/SystemDesign/DeepDives/Kafka.md`
- Test integration: `tools/gen-challenges.mjs`

- [ ] **Step 1: Run the focused assertion before the file exists**

Run:

```bash
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Kafka.md', 'kafka'); if (c.authoredCount !== 4) throw new Error('expected 4 Kafka checkpoints, got ' + c.authoredCount)"
```

Expected: FAIL with `expected 4 Kafka checkpoints, got 0`.

- [ ] **Step 2: Create the Kafka challenge file**

Create `content/challenges/kafka.json` with exactly this content:

```json
{
  "slug": "kafka",
  "checkpoints": [
    {
      "id": "tradeoff", "type": "duel", "tier": "senior", "title": "Tradeoff duel", "xp": 80,
      "prompt": "Order events per customer while scaling consumption across partitions.",
      "options": [
        { "id": "random", "label": "No message key", "sub": "let the producer spread batches", "correct": false, "verdict": "Traffic spreads well, but events for one customer can land in different partitions. Kafka only guarantees order within a partition, so concurrent consumers may apply that customer's updates out of order." },
        { "id": "customer", "label": "Key by customer_id", "sub": "one customer maps to one partition", "correct": true, "verdict": "All events for a customer share one ordered log while different customers distribute across partitions. The cost is that an unusually busy customer can create a hot partition and must be handled explicitly." }
      ],
      "defend": {
        "prompt": "What follows from keying by customer_id?",
        "options": [
          { "label": "Ordering is guaranteed only inside that partition", "correct": true },
          { "label": "Consumer-group parallelism is bounded by partition count", "correct": true },
          { "label": "A high-volume customer can create skew", "correct": true },
          { "label": "Every consumer group shares one committed offset", "correct": false }
        ],
        "explain": "Each consumer group tracks its own offsets, so groups replay independently. Within one group, each partition has one active owner and preserves the order of records sharing the customer key."
      }
    },
    {
      "id": "capacity", "type": "ladder", "tier": "senior", "title": "Semantics ladder", "xp": 70,
      "prompt": "Reason from partitions to processing guarantees.",
      "rungs": [
        { "q": "Ordering scope", "choices": ["Whole topic", "One partition", "One broker"], "answer": 1, "note": "Offsets define a total order inside each partition, not across the topic." },
        { "q": "Maximum active consumers for 12 partitions in one group", "choices": ["6", "12", "Unlimited"], "answer": 1, "note": "Each partition has one active consumer in the group; extra consumers are idle." },
        { "q": "Crash after output but before offset commit", "choices": ["Record is lost", "Record is reprocessed", "Partition is deleted"], "answer": 1, "note": "The replacement resumes from the older committed offset, producing at-least-once behavior." }
      ],
      "explain": "Partitions determine both ordering and useful consumer parallelism. Committing after processing avoids loss but permits replay, so external effects must be idempotent unless offsets and output participate in one transaction."
    },
    {
      "id": "architecture", "type": "builder", "tier": "staff", "title": "Architecture builder", "xp": 100,
      "prompt": "Build a durable at-least-once event path.",
      "palette": ["Producer Event", "Partition Key", "Partition Leader", "ISR Replication", "Consumer Group", "Idempotent Sink", "Random Router", "Blob Payload", "Offset Before Work"],
      "slots": [
        { "accept": "Producer Event" }, { "accept": "Partition Key" }, { "accept": "Partition Leader" },
        { "accept": "ISR Replication" }, { "accept": "Consumer Group" }, { "accept": "Idempotent Sink" }
      ],
      "explain": "The key selects the partition leader, which appends and replicates the record to in-sync replicas. One group member processes that partition, and an idempotent sink makes replay after a crash safe. Commit the offset only after the effect succeeds."
    },
    {
      "id": "bottleneck", "type": "bottleneck", "tier": "staff", "title": "Spot the bottleneck", "xp": 90,
      "prompt": "Consumer lag rises rapidly, but only for one partition.",
      "cards": [
        { "name": "Partition 7", "metric": "lag 2.4M", "delta": "+2.1M", "state": "hot" },
        { "name": "Other Partitions", "metric": "lag < 8k", "delta": "+1k", "state": "ok" },
        { "name": "Broker Network", "metric": "38% used", "delta": "+3pt", "state": "ok" },
        { "name": "Consumer Fleet", "metric": "CPU 44%", "delta": "+4pt", "state": "warn" }
      ],
      "answer": "Partition 7",
      "explain": "Cluster-wide resources are available while one partition falls behind. A skewed key is routing disproportionate traffic to Partition 7, and adding consumers cannot split one partition within the same group. Revisit the key or deliberately shard the hot entity if its ordering requirement permits it.",
      "wrong": {
        "Other Partitions": "Their low lag shows that the topic and consumer group are broadly healthy.",
        "Broker Network": "Network headroom rules out a cluster-wide transfer bottleneck.",
        "Consumer Fleet": "Fleet CPU is moderate; one partition cannot use additional group members anyway."
      }
    }
  ]
}
```

- [ ] **Step 3: Parse and integrate the Kafka file**

Run:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('content/challenges/kafka.json','utf8')); if(c.slug!=='kafka'||c.checkpoints.length!==4||new Set(c.checkpoints.map(x=>x.id)).size!==4) process.exit(1)"
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Kafka.md', 'kafka'); if (c.authoredCount !== 4) process.exit(1)"
```

Expected: both commands exit 0 with no output.

- [ ] **Step 4: Commit the Kafka challenge**

```bash
git add content/challenges/kafka.json
git commit -m "Add Kafka practice challenges"
```

### Task 2: Cassandra Challenge Set

**Files:**
- Create: `content/challenges/cassandra.json`
- Reference: `LLD/SystemDesign/DeepDives/Cassandra.md`
- Test integration: `tools/gen-challenges.mjs`

- [ ] **Step 1: Run the focused assertion before the file exists**

Run:

```bash
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Cassandra.md', 'cassandra'); if (c.authoredCount !== 4) throw new Error('expected 4 Cassandra checkpoints, got ' + c.authoredCount)"
```

Expected: FAIL with `expected 4 Cassandra checkpoints, got 0`.

- [ ] **Step 2: Create the Cassandra challenge file**

Create `content/challenges/cassandra.json` with four checkpoints containing these exact scenarios and answers:

```json
{
  "slug": "cassandra",
  "checkpoints": [
    {
      "id": "tradeoff", "type": "duel", "tier": "senior", "title": "Tradeoff duel", "xp": 80,
      "prompt": "A chat channel can accumulate billions of messages. Design for recent-message reads.",
      "options": [
        { "id": "channel", "label": "Partition by channel_id", "sub": "cluster by message_id descending", "correct": false, "verdict": "Recent reads are simple, but a busy channel creates one partition that grows forever. Large partitions increase compaction, repair, and read costs until the hottest channels become operational liabilities." },
        { "id": "bucket", "label": "Partition by channel and time bucket", "sub": "cluster by message_id descending", "correct": true, "verdict": "A bounded time bucket preserves the recent-message access pattern while capping partition growth. Most reads touch the current bucket and cross a boundary only when pagination requires it." }
      ],
      "defend": {
        "prompt": "What must the bucketed model account for?",
        "options": [
          { "label": "Bucket width follows worst-case partition size", "correct": true },
          { "label": "Boundary pagination may query two buckets", "correct": true },
          { "label": "Message IDs should preserve clustering order", "correct": true },
          { "label": "Cassandra will join buckets automatically", "correct": false }
        ],
        "explain": "Cassandra data models are query-driven. The application knows which buckets to query and merges boundary results; Cassandra does not provide cross-table joins or arbitrary scatter-gather as a cheap default."
      }
    },
    {
      "id": "capacity", "type": "ladder", "tier": "senior", "title": "Consistency ladder", "xp": 70,
      "prompt": "Replication factor 3 with tunable consistency.",
      "rungs": [
        { "q": "Replicas required by QUORUM", "choices": ["1", "2", "3"], "answer": 1, "note": "A majority of three is two." },
        { "q": "QUORUM write plus QUORUM read", "choices": ["Guarantees overlap", "Never overlaps", "Requires all replicas"], "answer": 0, "note": "Two sets of two drawn from three share at least one replica." },
        { "q": "Switch reads to ONE", "choices": ["Lower latency, possible stale read", "Strict serializability", "Cross-partition ACID"], "answer": 0, "note": "Waiting for fewer replicas favors latency and availability over freshness." }
      ],
      "explain": "Consistency levels control how many responses the coordinator waits for, not how many replicas receive the write. With RF=3, QUORUM plus QUORUM intersects; ONE trades that overlap guarantee for speed and availability."
    },
    {
      "id": "architecture", "type": "builder", "tier": "staff", "title": "Architecture builder", "xp": 100,
      "prompt": "Build Cassandra's acknowledged write path.",
      "palette": ["Client Write", "Coordinator", "Replica Set", "Commit Log", "Memtable", "Quorum Ack", "SSTable Flush", "Global Join", "Single Leader"],
      "slots": [
        { "accept": "Client Write" }, { "accept": "Coordinator" }, { "accept": "Replica Set" },
        { "accept": "Commit Log" }, { "accept": "Memtable" }, { "accept": "Quorum Ack" }
      ],
      "explain": "Any node can coordinate. It routes the mutation to replicas, where each replica appends to its commit log for durability and updates its Memtable. The coordinator responds after the selected consistency level acknowledges; SSTable flush happens later off the acknowledgment path."
    },
    {
      "id": "bottleneck", "type": "bottleneck", "tier": "staff", "title": "Spot the bottleneck", "xp": 90,
      "prompt": "Read p99 spikes after a TTL-heavy workload begins expiring data.",
      "cards": [
        { "name": "Tombstone Scan", "metric": "180k/read", "delta": "+175k", "state": "hot" },
        { "name": "Compaction Queue", "metric": "42 pending", "delta": "+36", "state": "warn" },
        { "name": "Coordinator CPU", "metric": "48%", "delta": "+5pt", "state": "ok" },
        { "name": "Gossip", "metric": "nodes live 12/12", "delta": "0", "state": "ok" }
      ],
      "answer": "Tombstone Scan",
      "explain": "Expired and deleted values remain as tombstones until compaction can safely purge them. Reads now scan huge numbers of dead cells, while the growing compaction queue explains why cleanup is behind. Fix the data model and TTL pattern, then restore compaction capacity.",
      "wrong": {
        "Compaction Queue": "It explains why tombstones persist, but the direct read-path cost shown here is the tombstone scan.",
        "Coordinator CPU": "CPU is healthy and does not explain the TTL-correlated scan amplification.",
        "Gossip": "All nodes are live; membership and failure detection are not the read bottleneck."
      }
    }
  ]
}
```

- [ ] **Step 3: Parse and integrate the Cassandra file**

Run:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('content/challenges/cassandra.json','utf8')); if(c.slug!=='cassandra'||c.checkpoints.length!==4||new Set(c.checkpoints.map(x=>x.id)).size!==4) process.exit(1)"
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Cassandra.md', 'cassandra'); if (c.authoredCount !== 4) process.exit(1)"
```

Expected: both commands exit 0 with no output.

- [ ] **Step 4: Commit the Cassandra challenge**

```bash
git add content/challenges/cassandra.json
git commit -m "Add Cassandra practice challenges"
```

### Task 3: ZooKeeper Challenge Set

**Files:**
- Create: `content/challenges/zookeeper.json`
- Reference: `LLD/SystemDesign/DeepDives/Zookeeper.md`
- Test integration: `tools/gen-challenges.mjs`

- [ ] **Step 1: Verify the missing authored set fails integration**

Run:

```bash
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Zookeeper.md', 'zookeeper'); if (c.authoredCount !== 4) throw new Error('expected 4 ZooKeeper checkpoints, got ' + c.authoredCount)"
```

Expected: FAIL with authored count 0.

- [ ] **Step 2: Create the ZooKeeper challenge file**

Create `content/challenges/zookeeper.json` with this complete payload:

```json
{
  "slug": "zookeeper",
  "checkpoints": [
    {
      "id": "tradeoff", "type": "duel", "tier": "senior", "title": "Tradeoff duel", "xp": 80,
      "prompt": "Ten thousand contenders wait for a distributed lock.",
      "options": [
        { "id": "leader", "label": "Everyone watches the lock holder", "sub": "wake all contenders on release", "correct": false, "verdict": "One deletion wakes every contender, which all call getChildren and race again. That herd effect turns each release into a burst against the ensemble." },
        { "id": "predecessor", "label": "Watch the immediate predecessor", "sub": "ephemeral sequential queue", "correct": true, "verdict": "Sequence order establishes fairness, and one deletion wakes only the next contender. Ephemeral ownership also releases the position after session expiration if a client crashes." }
      ],
      "defend": {
        "prompt": "Why does the predecessor recipe work?",
        "options": [
          { "label": "Sequential suffixes establish an order", "correct": true },
          { "label": "Ephemeral nodes disappear with the session", "correct": true },
          { "label": "Only one waiter is notified per release", "correct": true },
          { "label": "Watches remain installed forever", "correct": false }
        ],
        "explain": "ZooKeeper watches are notifications, not durable subscriptions; clients re-read state and reinstall the watch. Watching only the predecessor avoids a herd while preserving progress."
      }
    },
    {
      "id": "capacity", "type": "ladder", "tier": "senior", "title": "Quorum ladder", "xp": 70,
      "prompt": "A five-server ZooKeeper ensemble coordinates workers.",
      "rungs": [
        { "q": "Servers needed for a write quorum", "choices": ["2", "3", "5"], "answer": 1, "note": "A majority of five is three." },
        { "q": "Simultaneous server failures tolerated", "choices": ["1", "2", "3"], "answer": 1, "note": "Three remaining servers still form a majority." },
        { "q": "Worker disconnects briefly, then reconnects before timeout", "choices": ["Session can recover", "Ephemeral nodes vanish immediately"], "answer": 0, "note": "Ephemeral cleanup occurs on session expiration, not every transient disconnect." }
      ],
      "explain": "The ensemble needs a majority for progress, while client liveness is governed by sessions. A timeout balances fast failure detection against false expiration during temporary network trouble."
    },
    {
      "id": "architecture", "type": "builder", "tier": "staff", "title": "Architecture builder", "xp": 100,
      "prompt": "Build leader election without a watch herd.",
      "palette": ["Contender", "Ephemeral Sequential ZNode", "Sort Sequence Numbers", "Watch Predecessor", "Lowest Node Leads", "Session Expiry Failover", "Watch Parent", "Persistent Claim", "Poll Every Second"],
      "slots": [
        { "accept": "Contender" }, { "accept": "Ephemeral Sequential ZNode" }, { "accept": "Sort Sequence Numbers" },
        { "accept": "Watch Predecessor" }, { "accept": "Lowest Node Leads" }, { "accept": "Session Expiry Failover" }
      ],
      "explain": "Each contender creates an ephemeral sequential child. The lowest sequence leads; every other contender watches only the node immediately before it. If the leader's session expires, its node disappears and exactly the next contender is prompted to re-evaluate."
    },
    {
      "id": "bottleneck", "type": "bottleneck", "tier": "staff", "title": "Spot the bottleneck", "xp": 90,
      "prompt": "One leader failure causes the ensemble to saturate for 20 seconds.",
      "cards": [
        { "name": "Watch Set", "metric": "9,800 on leader", "delta": "+9,700", "state": "hot" },
        { "name": "Write Quorum", "metric": "3/5 healthy", "delta": "-1", "state": "warn" },
        { "name": "ZNode Data", "metric": "2 KB max", "delta": "0", "state": "ok" },
        { "name": "Transaction Log", "metric": "fsync p99 4ms", "delta": "+1ms", "state": "ok" }
      ],
      "answer": "Watch Set",
      "explain": "Nearly every contender watches the same leader node, so its deletion wakes 9,800 clients at once. They stampede into reads and writes even though quorum and storage are healthy enough. Use ephemeral sequential nodes and predecessor watches.",
      "wrong": {
        "Write Quorum": "Three healthy servers still form a majority and can make progress.",
        "ZNode Data": "The metadata is tiny and unchanged.",
        "Transaction Log": "Fsync latency is healthy before the client stampede arrives."
      }
    }
  ]
}
```

- [ ] **Step 3: Parse and integrate the ZooKeeper file**

Run:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('content/challenges/zookeeper.json','utf8')); if(c.slug!=='zookeeper'||c.checkpoints.length!==4||new Set(c.checkpoints.map(x=>x.id)).size!==4) process.exit(1)"
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Zookeeper.md', 'zookeeper'); if (c.authoredCount !== 4) process.exit(1)"
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the ZooKeeper challenge**

```bash
git add content/challenges/zookeeper.json
git commit -m "Add ZooKeeper practice challenges"
```

### Task 4: Flink Challenge Set

**Files:**
- Create: `content/challenges/flink.json`
- Reference: `LLD/SystemDesign/DeepDives/Flink.md`
- Test integration: `tools/gen-challenges.mjs`

- [ ] **Step 1: Verify the missing authored set fails integration**

Run:

```bash
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Flink.md', 'flink'); if (c.authoredCount !== 4) throw new Error('expected 4 Flink checkpoints, got ' + c.authoredCount)"
```

Expected: FAIL with authored count 0.

- [ ] **Step 2: Create the Flink challenge file**

Create `content/challenges/flink.json` with this complete payload:

```json
{
  "slug": "flink",
  "checkpoints": [
    {
      "id": "tradeoff", "type": "duel", "tier": "senior", "title": "Tradeoff duel", "xp": 80,
      "prompt": "Mobile events arrive up to two minutes late, but hourly totals must reflect when actions occurred.",
      "options": [
        { "id": "processing", "label": "Processing-time windows", "sub": "group by arrival at Flink", "correct": false, "verdict": "This is fast and simple, but delayed events move into the wrong hour and replay after an outage can produce different totals. Arrival time does not satisfy the requirement." },
        { "id": "event", "label": "Event time with watermarks", "sub": "two-minute bounded out-of-orderness", "correct": true, "verdict": "Embedded event timestamps place records in the correct hour, while the watermark delays closure long enough for expected disorder. The two-minute wait is the explicit freshness-versus-completeness trade-off." }
      ],
      "defend": {
        "prompt": "What must the event-time design define?",
        "options": [
          { "label": "How timestamps are extracted", "correct": true },
          { "label": "The expected out-of-order bound", "correct": true },
          { "label": "A policy for events later than the watermark", "correct": true },
          { "label": "That every event eventually arrives", "correct": false }
        ],
        "explain": "A watermark is a progress claim, not proof that no older event can arrive. Very late events need allowed lateness, a side output, or offline reconciliation."
      }
    },
    {
      "id": "capacity", "type": "ladder", "tier": "senior", "title": "Streaming ladder", "xp": 70,
      "prompt": "Reason about time, windows, and recovery.",
      "rungs": [
        { "q": "Two-input operator watermark", "choices": ["Maximum input", "Minimum input", "Average input"], "answer": 1, "note": "The operator cannot advance beyond its slowest input." },
        { "q": "Five-minute sliding window emitted every minute", "choices": ["No overlap", "Five overlapping windows", "One global window"], "answer": 1, "note": "Each event can contribute to multiple overlapping evaluations." },
        { "q": "Exactly-once checkpoint plus plain HTTP side effect", "choices": ["End-to-end exactly once", "HTTP effect still needs idempotency"], "answer": 1, "note": "Flink restores managed state exactly, but cannot roll back an arbitrary external call." }
      ],
      "explain": "Watermarks coordinate event-time progress, window shape controls state and compute cost, and checkpoints cover managed state plus source positions. External effects need transactional or idempotent cooperation."
    },
    {
      "id": "architecture", "type": "builder", "tier": "staff", "title": "Architecture builder", "xp": 100,
      "prompt": "Build a recoverable event-time aggregation.",
      "palette": ["Kafka Source", "Timestamps and Watermarks", "keyBy", "Stateful Window", "Checkpointed State", "Idempotent Sink", "Processing Clock", "Local Variable", "Fire-and-Forget API"],
      "slots": [
        { "accept": "Kafka Source" }, { "accept": "Timestamps and Watermarks" }, { "accept": "keyBy" },
        { "accept": "Stateful Window" }, { "accept": "Checkpointed State" }, { "accept": "Idempotent Sink" }
      ],
      "explain": "Kafka supplies replayable input. Watermarks drive event-time windows, keyBy colocates per-key state, and checkpoints capture state with source positions. An idempotent or transactional sink closes the end-to-end recovery gap."
    },
    {
      "id": "bottleneck", "type": "bottleneck", "tier": "staff", "title": "Spot the bottleneck", "xp": 90,
      "prompt": "Windows stop closing although most records continue flowing.",
      "cards": [
        { "name": "Idle Source Partition", "metric": "watermark 18m behind", "delta": "-18m", "state": "hot" },
        { "name": "Active Partitions", "metric": "watermark current", "delta": "+0s", "state": "ok" },
        { "name": "Task Slots", "metric": "CPU 52%", "delta": "+4pt", "state": "ok" },
        { "name": "Sink", "metric": "p99 24ms", "delta": "+2ms", "state": "warn" }
      ],
      "answer": "Idle Source Partition",
      "explain": "A downstream operator advances to the minimum input watermark. One idle partition keeps reporting an old watermark, so event time stalls even while active partitions flow. Configure idleness detection so an inactive input no longer holds back global progress.",
      "wrong": {
        "Active Partitions": "Their watermarks are current and show healthy progress.",
        "Task Slots": "Moderate CPU does not explain a frozen event-time clock.",
        "Sink": "The sink remains fast enough; window results are not being triggered upstream."
      }
    }
  ]
}
```

- [ ] **Step 3: Parse and integrate the Flink file**

Run:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('content/challenges/flink.json','utf8')); if(c.slug!=='flink'||c.checkpoints.length!==4||new Set(c.checkpoints.map(x=>x.id)).size!==4) process.exit(1)"
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Flink.md', 'flink'); if (c.authoredCount !== 4) process.exit(1)"
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the Flink challenge**

```bash
git add content/challenges/flink.json
git commit -m "Add Flink practice challenges"
```

### Task 5: Redis Challenge Set

**Files:**
- Create: `content/challenges/redis.json`
- Reference: `LLD/SystemDesign/DeepDives/Redis.md`
- Test integration: `tools/gen-challenges.mjs`

- [ ] **Step 1: Verify the missing authored set fails integration**

Run:

```bash
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Redis.md', 'redis'); if (c.authoredCount !== 4) throw new Error('expected 4 Redis checkpoints, got ' + c.authoredCount)"
```

Expected: FAIL with authored count 0.

- [ ] **Step 2: Create the Redis challenge file**

Create `content/challenges/redis.json` with this complete payload:

```json
{
  "slug": "redis",
  "checkpoints": [
    {
      "id": "tradeoff", "type": "duel", "tier": "senior", "title": "Tradeoff duel", "xp": 80,
      "prompt": "Workers must process notifications published while they are offline.",
      "options": [
        { "id": "pubsub", "label": "Redis Pub/Sub", "sub": "deliver to current subscribers", "correct": false, "verdict": "Pub/Sub is at-most-once and keeps no backlog. A disconnected worker misses every notification published while it is offline, which directly violates the requirement." },
        { "id": "streams", "label": "Redis Streams", "sub": "consumer group with pending entries", "correct": true, "verdict": "Streams persist entries according to Redis durability settings and consumer groups track pending work. A replacement can claim an idle entry after a worker fails, so processing must remain idempotent." }
      ],
      "defend": {
        "prompt": "What does the Streams choice still require?",
        "options": [
          { "label": "Acknowledging completed entries", "correct": true },
          { "label": "Claiming abandoned pending work", "correct": true },
          { "label": "Idempotent processing after redelivery", "correct": true },
          { "label": "Assuming Redis is a durable system of record", "correct": false }
        ],
        "explain": "Streams add backlog and recovery semantics, but durability still depends on Redis persistence and replication settings. Use Kafka or another durable broker when losing acknowledged events is unacceptable."
      }
    },
    {
      "id": "capacity", "type": "ladder", "tier": "senior", "title": "Cluster ladder", "xp": 70,
      "prompt": "Reason about Redis Cluster placement and failure.",
      "rungs": [
        { "q": "Hash slots in Redis Cluster", "choices": ["1,024", "16,384", "65,536"], "answer": 1, "note": "CRC16 maps keys into 16,384 slots." },
        { "q": "Make two keys eligible for one multi-key operation", "choices": ["Use the same hash tag", "Use the same TTL", "Put them in database 1"], "answer": 0, "note": "Only the substring inside matching braces is hashed, colocating the keys." },
        { "q": "Primary acknowledges before async replica receives write", "choices": ["Failover can lose it", "Failover always preserves it"], "answer": 0, "note": "Asynchronous replication leaves a real acknowledged-write loss window." }
      ],
      "explain": "Redis scales by mapping keys to slots and routing clients directly to the owning primary. Hash tags trade distribution for colocation, while asynchronous replication preserves speed at the cost of write safety during failover."
    },
    {
      "id": "architecture", "type": "builder", "tier": "staff", "title": "Architecture builder", "xp": 100,
      "prompt": "Build a cluster-aware Redis command path.",
      "palette": ["Client Command", "Cluster-aware Client", "Hash Slot", "Primary Node", "Async Replica", "Client Response", "Proxy Every Hop", "Cross-slot Join", "Synchronous Quorum"],
      "slots": [
        { "accept": "Client Command" }, { "accept": "Cluster-aware Client" }, { "accept": "Hash Slot" },
        { "accept": "Primary Node" }, { "accept": "Async Replica" }, { "accept": "Client Response" }
      ],
      "explain": "The client computes the slot and uses its cached slot map to contact the primary directly. The primary executes the command and asynchronously propagates it to a replica, then responds without waiting by default. MOVED refreshes a stale permanent mapping; ASK handles a slot being migrated."
    },
    {
      "id": "bottleneck", "type": "bottleneck", "tier": "staff", "title": "Spot the bottleneck", "xp": 90,
      "prompt": "Cluster p99 spikes during a product launch, but adding shards does not help.",
      "cards": [
        { "name": "Hot Key", "metric": "210k ops/s", "delta": "+195k", "state": "hot" },
        { "name": "Other Primaries", "metric": "CPU 22%", "delta": "+2pt", "state": "ok" },
        { "name": "Slot Map", "metric": "MOVED 0.01%", "delta": "+0.00pt", "state": "ok" },
        { "name": "Replica Reads", "metric": "disabled", "delta": "unchanged", "state": "warn" }
      ],
      "answer": "Hot Key",
      "explain": "One key maps to one slot and therefore one primary, so adding unrelated shards cannot divide its command stream. Use a short client-side cache, deliberate key copies for read traffic, or replica reads when staleness is acceptable; redesign write-hot keys because replicas do not split writes.",
      "wrong": {
        "Other Primaries": "Their idle capacity proves the traffic is not distributed across slots.",
        "Slot Map": "Redirections are negligible, so stale routing is not the latency source.",
        "Replica Reads": "Enabling them can relieve read load, but the concentrated key is the root cause and write traffic still hits the primary."
      }
    }
  ]
}
```

- [ ] **Step 3: Parse and integrate the Redis file**

Run:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('content/challenges/redis.json','utf8')); if(c.slug!=='redis'||c.checkpoints.length!==4||new Set(c.checkpoints.map(x=>x.id)).size!==4) process.exit(1)"
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; const c = buildChallenges('./LLD/SystemDesign/DeepDives/Redis.md', 'redis'); if (c.authoredCount !== 4) process.exit(1)"
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the Redis challenge**

```bash
git add content/challenges/redis.json
git commit -m "Add Redis practice challenges"
```

### Task 6: Cross-File Validation and Repository Gates

**Files:**
- Verify: `content/challenges/kafka.json`
- Verify: `content/challenges/cassandra.json`
- Verify: `content/challenges/zookeeper.json`
- Verify: `content/challenges/flink.json`
- Verify: `content/challenges/redis.json`
- Generated but never edit or commit: `site/`

- [ ] **Step 1: Validate every authored file and answer reference together**

Run:

```bash
node -e "const fs=require('fs'); for(const slug of ['kafka','cassandra','zookeeper','flink','redis']){const c=JSON.parse(fs.readFileSync('content/challenges/'+slug+'.json','utf8')); if(c.slug!==slug||c.checkpoints.length!==4||new Set(c.checkpoints.map(x=>x.id)).size!==4) throw new Error('invalid '+slug); const b=c.checkpoints.find(x=>x.type==='bottleneck'); if(!b.cards.some(x=>x.name===b.answer)) throw new Error('bad bottleneck answer '+slug); for(const r of c.checkpoints.find(x=>x.type==='ladder').rungs) if(r.answer<0||r.answer>=r.choices.length) throw new Error('bad ladder answer '+slug)}"
```

Expected: exit 0 with no output.

- [ ] **Step 2: Validate all five article integrations together**

Run:

```bash
node --input-type=module -e "import { buildChallenges } from './tools/gen-challenges.mjs'; for (const [file,slug] of [['Kafka.md','kafka'],['Cassandra.md','cassandra'],['Zookeeper.md','zookeeper'],['Flink.md','flink'],['Redis.md','redis']]) { const c=buildChallenges('./LLD/SystemDesign/DeepDives/'+file,slug); if(c.authoredCount!==4) throw new Error(slug+' authoredCount='+c.authoredCount) }"
```

Expected: exit 0 with no output.

- [ ] **Step 3: Run the Python code-block gate**

Run:

```bash
python3 tools/check-python.py
```

Expected: exit 0 and report that Python snippets parse.

- [ ] **Step 4: Render diagrams and build the generated site**

Run:

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
```

Expected: exit 0 with diagram rendering and site build completing successfully.

- [ ] **Step 5: Run the site integrity gate**

Run:

```bash
node tools/check-site.mjs
```

Expected: exit 0 with links, assets, anchors, and client JavaScript checks passing.

- [ ] **Step 6: Confirm only intended source files are tracked**

Run:

```bash
git status --short
git log -6 --oneline
```

Expected: no untracked challenge files, no tracked changes under `site/`, and one commit for each challenge file. If the plan document itself remains uncommitted, commit it separately without including generated output:

```bash
git add docs/superpowers/plans/2026-07-26-deep-dive-challenges.md
git commit -m "Document deep-dive challenge implementation"
```

## Plan Self-Review

- Spec coverage: all five requested articles receive the four approved checkpoint types, focused integration checks, and full repository verification.
- Scope: no article, generator, UI, or generated-site edits are planned.
- Type consistency: every bottleneck answer matches a card name, every ladder answer indexes its choices, and all checkpoint IDs and tiers match the existing challenge schema.
- Placeholder scan: implementation payloads, commands, expected outcomes, paths, and commit boundaries are explicit.
