# Deep-Dive Challenges Design

## Goal

Add authored interactive challenges for the Kafka, Cassandra, ZooKeeper, Flink,
and Redis deep-dive articles. Each article should receive a challenge set with
the same interaction pattern and level of explanation as
`content/challenges/ad-click-aggregator.json`.

The challenges should test system-design judgment and operational reasoning,
not isolated product trivia.

## Scope

Create these files:

- `content/challenges/kafka.json`
- `content/challenges/cassandra.json`
- `content/challenges/zookeeper.json`
- `content/challenges/flink.json`
- `content/challenges/redis.json`

Do not modify the source articles, challenge generator, challenge UI, or
generated `site/` output. Existing filename-to-slug behavior already maps the
five deep-dive articles to these authored challenge files.

## Challenge Shape

Each file will contain four authored checkpoints matching the established
schema:

1. A senior `duel` worth 80 XP that asks the learner to choose between two
   plausible designs, followed by a multi-select defense.
2. A senior `ladder` worth 70 XP with three progressively connected questions.
3. A staff `builder` worth 100 XP with a palette, six ordered slots, realistic
   distractors, and an explanation of the resulting flow.
4. A staff `bottleneck` worth 90 XP with four operational signals, one root
   cause, targeted explanations for the distractors, and a causal diagnosis.

Checkpoint IDs remain `tradeoff`, `capacity`, `architecture`, and `bottleneck`
so the files remain consistent with the current corpus. Labels and metrics
must be concise enough for the existing sidecar UI.

## Content Design

### Kafka

- Duel: preserve per-key ordering without creating a hot partition. Contrast a
  naive high-skew key with a partitioning strategy whose trade-off is explicit.
- Ladder: establish that ordering is partition-local, consumer-group
  parallelism is bounded by partition count, and default processing is
  at-least-once unless processing and offset commits are coordinated.
- Builder: arrange producer, topic partition leader, replicated log, consumer
  group, idempotent processor, and sink into a durable processing path.
- Bottleneck: diagnose one partition accumulating lag while sibling partitions
  and brokers remain healthy as key skew rather than insufficient cluster-wide
  capacity.

### Cassandra

- Duel: contrast an unbounded partition key with a query-driven, time-bucketed
  partition key for a high-volume timeline or message workload.
- Ladder: connect replication factor, quorum intersection, and the impact of
  lower consistency levels on latency, availability, and stale reads.
- Builder: arrange coordinator routing, commit log, Memtable, SSTable flush,
  replication, and query response around Cassandra's write path.
- Bottleneck: diagnose read-latency and disk-pressure symptoms caused by
  tombstone accumulation or compaction debt rather than blaming the
  coordinator or gossip layer.

### ZooKeeper

- Duel: contrast watching the leader or parent node from every contender with
  watching only the immediately preceding ephemeral sequential ZNode.
- Ladder: connect odd-sized ensembles, majority quorum, session expiration,
  and ephemeral-node cleanup.
- Builder: arrange contender registration, ephemeral sequential ZNode
  creation, sequence ordering, predecessor watch, leader work, and failover.
- Bottleneck: diagnose a watch herd or an overly aggressive session timeout
  from the supplied operational signals.

### Flink

- Duel: contrast processing-time windows with event-time windows and bounded
  out-of-orderness for delayed events.
- Ladder: connect watermarks, window closure, allowed lateness, checkpoints,
  and the boundary of exactly-once guarantees at external sinks.
- Builder: arrange Kafka source, timestamp/watermark assignment, `keyBy`,
  stateful window, checkpointed state, and idempotent or transactional sink.
- Bottleneck: diagnose a stalled watermark or checkpoint under an idle or
  backpressured input rather than treating healthy downstream components as
  the cause.

### Redis

- Duel: choose between ephemeral Pub/Sub and durable Streams based on offline
  delivery and replay requirements, or between naive and token-safe lock
  release where that produces the clearer system-design trade-off.
- Ladder: connect the 16,384 hash slots, hash tags for colocated multi-key
  operations, and asynchronous replication's acknowledged-write loss window.
- Builder: arrange cluster-aware client routing, slot calculation, primary
  command execution, asynchronous replication, and client handling of
  redirection or failover.
- Bottleneck: diagnose a hot key or lock safety failure after asynchronous
  replica promotion from the supplied metrics and symptoms.

## Research Standard

Challenge facts must agree with both the local deep-dive article and current
official documentation. Primary references are:

- Apache Kafka design documentation for partitioning, consumer positions,
  delivery semantics, replication, and transactions.
- Apache Cassandra architecture documentation for consistent hashing,
  replication, tunable consistency, gossip, and storage behavior.
- Apache ZooKeeper recipes and internals documentation for ephemeral sequential
  nodes, predecessor watches, quorum behavior, and sessions.
- Apache Flink documentation for event time, watermarks, windows, state, and
  checkpoints.
- Redis cluster and distributed-lock documentation for hash slots, redirects,
  asynchronous replication, Pub/Sub, Streams, and lock ownership tokens.

Numeric prompts should use stable architectural constants or explicit values
from the local articles. Avoid benchmark numbers that vary substantially by
hardware unless the question clearly marks them as rough estimates.

## Quality Rules

- Every wrong answer must be plausible and teach why it fails.
- Every bottleneck explanation must distinguish the root cause from downstream
  symptoms.
- Each builder must describe one meaningful ordered path; optional branches
  belong in the palette or explanation rather than ordered slots.
- Do not claim end-to-end exactly-once behavior unless the source, state, and
  sink participate through idempotent or transactional semantics.
- Preserve the article's interview-oriented level: senior checkpoints test
  decisions, while staff checkpoints test architecture and failure diagnosis.
- Use ASCII text in JSON files.

## Verification

Implementation is complete when:

1. All five files parse as JSON and each has exactly four authored checkpoints
   with unique IDs and valid answer references.
2. A site build embeds an `authoredCount` of four for the Kafka, Cassandra,
   ZooKeeper, Flink, and Redis deep-dive pages.
3. The repository's required gates pass:

   ```bash
   python3 tools/check-python.py
   cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
   node tools/check-site.mjs
   ```

4. No generated `site/` files are committed or manually edited.
