# 📬 How Slack Put Kafka in Front of Its Redis Job Queue

![Slack](assets/slack.3ifu5_ng7dxey.svg)

Originally published by Slack Engineering on December 6, 2017

> **Overview**: Slack's async job queue was built entirely in Redis, holding both the backlog and the dispatch bookkeeping in one finite pool of RAM. A database slowdown let jobs pile up until Redis hit its memory limit, and because dequeuing itself needed free memory, the queue locked up rather than degrading gracefully. The fix put Kafka in front of Redis as a durable, disk-backed buffer plus two new Go services to shuttle jobs in and out — separating the burst backlog from the short dispatch window while leaving the application's queue logic untouched.

## 📋 Table of Contents
- [Layman's Explanation](#laymans-explanation)
- [The TLDR](#the-tldr)
- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Conclusion](#conclusion)
- [Key Takeaways](#key-takeaways)
- [Related Concepts](#related-concepts)

---

## 🧒 Layman's Explanation

Think of a busy restaurant kitchen. Orders (jobs) get clipped onto a ticket rail at the pass (Redis), and cooks (workers) grab the next ticket to cook. The rail only has so much space. When the kitchen slows down — say an ingredient supplier is late (a database slowdown) — tickets pile up until the rail is completely full. And here's the nasty part: once the rail is jammed, you can't clip new orders on *and* the cooks can't even pull tickets off, because shuffling a ticket to the "cooking now" spot needs a little free space that a full rail doesn't have. Everything locks up, and it stays locked even after the supplier shows back up.

Slack's fix was to add a long spindle behind the pass (Kafka) that holds overflow tickets on paper — essentially unlimited room, kept on the counter (disk) instead of in the cook's hand (RAM). A runner (JQRelay) feeds tickets from the spindle onto the rail only as fast as the cooks can actually keep up. Now a rush just makes the paper stack taller; the rail stays short and workable, and nothing ever seizes.

## 🎯 The TLDR

On its busiest days, Slack’s async job queue handles more than 1.4 billion jobs, peaking at 33,000 per second. It powers nearly everything too slow for a web request, including posting messages, sending push notifications, generating URL unfurls, triggering calendar reminders, and running billing calculations.

That queue was built entirely in [Redis](https://www.hellointerview.com/learn/system-design/deep-dives/redis), which held both the backlog and the dispatch bookkeeping. That is until a database slowdown made jobs pile up until Redis hit its memory limit. At that point, the queue could neither accept new jobs nor, since dequeuing also needed a little free memory, hand out the old ones.

To prevent this from happening again, they added Kafka in front of Redis as a [durable buffer](https://www.hellointerview.com/learn/system-design/patterns/scaling-writes#write-queues-for-burst-handling) plus two new Go services to move jobs in and out, keeping the application's queue logic untouched. As a result, a backlog now piles up on disk while operators throttle the flow into Redis.

We picked [Slack's write-up](https://slack.engineering/scaling-slacks-job-queue/) because it's a canonical example of putting a durable log in front of a fast dispatch layer in order to handle bursts.

## ⚠️ The Problem

### The whole queue lives in RAM

Slack's job queue runs on a fleet of Redis clusters, with pools of worker machines polling those clusters for new work. When something in Slack needs to happen later, the web app builds a job identifier from the job type and its arguments, then hashes it with the logical queue name to pick which Redis host the job lands on. That host runs limited deduplication, discarding the request if an identical identifier is already waiting. Workers pull jobs off the pending queue, moving each onto an in-flight list before spawning an async task to run it. Finished jobs come off the list, and failures retry until they land in a permanently-failed list that humans repair by hand.

The lifecycle each job travels through inside Redis:

```mermaid
stateDiagram-v2
    [*] --> Pending: web app enqueues<br/>(dedup by job ID)
    Pending --> InFlight: worker pulls job<br/>(RPOPLPUSH onto in-flight list)
    InFlight --> Done: task succeeds
    InFlight --> Pending: failure retries
    InFlight --> PermanentlyFailed: retries exhausted
    Done --> [*]
    PermanentlyFailed --> [*]: repaired by hand

    classDef bad fill:#FFB6C1
    classDef good fill:#90EE90
    class PermanentlyFailed bad
    class Done good
```

Slack doesn't say which Redis structures they used or exactly why dequeuing cost grew with queue length, but a typical Redis task queue shows how that happens. Waiting jobs sit in a list per logical queue that enqueues push onto. Deduplication needs an index you can check by job ID, a set or a hash maintained alongside the pending jobs. Moving a job to an in-flight list before execution means it remains recoverable if the worker dies. `RPOPLPUSH` makes that handoff cheap, popping the oldest pending job and pushing it onto another list at constant cost. Removing one particular job by value is a different operation, a command like `LREM` that scans the list end to end, and a scan like that on every dequeue produces the linear cost Slack described.

Jobs run from a few milliseconds to several minutes, and the queue had scaled from Slack's earliest days without the core architecture changing. The same finite pool of RAM held both the buffer that absorbs bursts of new work and the working space where dispatch, dedup, and retries get tracked.

### Why the queue stayed down after the database recovered

Resource contention in the database layer slowed job execution, so jobs accumulated in Redis until it hit its configured maximum memory. Enqueues began failing, and with them every Slack feature that depended on the queue. The dequeue path then prevented the queue from recovering. Pulling a job off the queue moves it onto a processing list, and that move needs free memory a full Redis doesn't have, so even after the database recovered the queue stayed stuck, and it took extensive manual intervention to revive.

> ⚠️ **The deadlock trap:** When the buffer and the working space share one bounded pool of RAM, a full queue can't be drained — draining itself requires the free memory the queue no longer has. Overload ends in lockup, not lag, and recovery isn't automatic even once the upstream problem clears.

![Redis queue](assets/UcqnYw1DfhW0.3wsf4r98es-xu.svg)

Memory exhaustion was only one of the problems the post-mortem turned up. Every job-queue client connected to every Redis instance, a complete bipartite graph. Workers couldn't be scaled independently either, because each added worker adds polling load on Redis, so adding execution capacity could push an already overloaded Redis further under. The linear-cost dequeue made a second feedback loop, since a longer queue slows every dequeue at the moment draining matters most. And because the queue's exact semantics were never pinned down, engineers hesitated to build on it or to change dedup behavior that many jobs depended on.

## 🛠️ The Solution

### Kafka in front

The post-mortem set the requirements. The backlog had to live somewhere durable that couldn't run out of memory whether jobs flooded in or drained too slowly, scheduling needed real rate limits and priorities, and execution capacity had to scale without adding polling load on Redis. Slack put Kafka in front of Redis instead of replacing Redis with it. Why run two queue-shaped systems? Why not just make Kafka the queue?

Slack could have rebuilt the queue directly on Kafka. It's a [durable append-only log](https://www.hellointerview.com/learn/system-design/deep-dives/kafka#how-kafka-works), split into partitions, where each consumer tracks its own read position as an offset, and the log lives on disk, bounded by a retention window rather than by RAM, so a burst of enqueues just makes the log longer. An offset is a position in a partition, not per-job state, so per-job acknowledgment, retries, dedup, and in-flight tracking have to be built on top, retries as re-enqueues onto the topic, dedup as a small keyed store, and plenty of teams run job systems on Kafka in exactly this way. Slack had all of those semantics already built in Redis, with years of application code depending on their exact behavior, so rebuilding on Kafka alone would have turned a narrowly scoped availability fix into a rewrite.

![Kafka in front of Redis](assets/yRUrbi0lodxT.3gecfd569iyr1.svg)

RabbitMQ, SQS, and beanstalkd all persisted to disk, and all had the same problem, since each brings its own delivery semantics and adopting one meant the same rewrite against a different API. Turning on Redis persistence wouldn't have helped either, because a Redis dataset has to fit in RAM whether or not it's also written to disk, and the outage was a capacity problem, not a durability one. And keeping Redis alone was the design that had just failed, where the burst buffer and the dispatch workspace compete for the same RAM and overload ends in lockup rather than lag.

So Slack made what they called the "minimum viable change". The web app enqueues into Kafka, which durably buffers everything, a relay drains Kafka into Redis at a controlled rate, and Redis keeps providing the short queue and the semantics the application understands. Neither the enqueue interface nor the worker side changed. Slack first protected the enqueue path, then planned to revisit scheduling and worker scaling after running the new path in production.

### Kafkagate and JQRelay

Slack wrote two new stateless Go services to run the new path. Kafkagate is the enqueue path from the web app into Kafka. The interface is a plain HTTP POST, simplified here:

```
POST /enqueue
{
  "topic": "jobs-cluster-07",
  "partition": 12,
  "content": { "type": "url_unfurl", "args": { ... } }
}
```

Kafkagate holds persistent broker connections, follows partition leadership as it moves, and writes synchronously, so the caller always gets a positive ack or an error. It [waits only for the partition leader to acknowledge a write](https://www.hellointerview.com/learn/system-design/deep-dives/kafka#fault-tolerance-and-durability), not for replication, taking the lowest latency in exchange for a small chance of losing a job if a broker dies before replicating, a tradeoff Slack judged right for most jobs. Enqueuing hosts prefer a Kafkagate in their own availability zone, failing over to others when needed. This also retired the enqueue half of the connection fan-out, since the web app now talks to a nearby gateway instead of holding connections to fifty Redis clusters.

JQRelay is the drain, one instance relaying one Kafka topic into its corresponding Redis cluster. Coordination runs through Consul, a service that provides [distributed locks](https://www.hellointerview.com/learn/system-design/deep-dives/zookeeper#zookeeper-for-distributed-locks). On startup an instance tries to acquire the lock for a topic, and if it wins it relays all of that topic's partitions. If it ever loses the lock, it releases everything and restarts so another instance can take over, and since instances run in an auto-scaling group, replacements go through the same flow. The result is one relay responsible for each topic.

JQRelay tracks progress with Kafka's per-partition commit offsets, and the core loop, simplified, advances an offset only after the job is safely in Redis:

```
for job in consume(topic, partition):
    write_to_redis(job)       # retry indefinitely while Redis is down
    commit_offset(partition)  # only after the Redis write succeeds
```

If Redis is down, the relay retries until it returns or is replaced while the log absorbs new work behind it. If a specific job errors, JQRelay re-enqueues it to Kafka, which keeps the queue moving without losing the job. The rate limits live in Consul, picked up through its watch API. During a buildup the web app keeps enqueueing at full speed while operators turn the relay down to match what workers can execute.

Following a single job through the new path over time — note that the Kafka offset only advances *after* the Redis write is confirmed, and that the relay is throttled independently of the enqueue rate:

```mermaid
sequenceDiagram
    participant W as Web App
    participant KG as Kafkagate
    participant K as Kafka
    participant JQ as JQRelay
    participant R as Redis
    participant WK as Worker

    W->>KG: POST /enqueue
    KG->>K: write (wait for partition leader ack)
    K-->>KG: ack
    KG-->>W: ack / error
    Note over K,JQ: backlog waits on disk,<br/>bounded by retention
    loop drain at Consul-throttled rate
        JQ->>K: consume(topic, partition)
        JQ->>R: write_to_redis(job)
        R-->>JQ: ok
        JQ->>K: commit_offset (only after Redis write)
    end
    WK->>R: poll for work
    R-->>WK: dispatch job to execute
```

### Proving it with production traffic

The cluster ran 16 brokers, with 32 partitions per topic, replication factor 3, two days of retention, and rack-aware replication mapped to availability zones. Unclean leader election, where Kafka accepts a stale replica as leader to restore availability at the risk of losing acknowledged writes, was enabled. The team sized the cluster with load tests at expected production rates, then ran failure drills covering broker loss, a forced unclean leader election, and a full cluster restart, and every scenario met their availability goals.

The rollout itself started with double writes, every job going to both the old Redis path and the new Kafka path while JQRelay ran in what they called "shadow" mode, reading everything from Kafka and dropping it, which put real production traffic through every new component with zero user impact. They counted jobs at each hop, web app to Kafkagate to Kafka to Redis, and ran heartbeat canaries, one per partition per minute across all 1,600 partitions (50 topics of 32, one per Redis cluster), with alerts on end-to-end flow and timing. The new path served Slack internally for a few weeks before rolling out to customers one job type at a time.

One snag came from putting a second runtime into a PHP-only pipeline. JQRelay decodes and re-encodes each job's JSON, and Go by default escapes `<`, `>`, and `&` into unicode entities while PHP escapes `/`. The same data structure produced different bytes depending on the runtime, and it caused real trouble, "heartache" in the team's own word.

## 📝 Conclusion

Slack's outage was because of one structural fact: the burst buffer and the dispatch workspace shared a single bounded pool of RAM. An in-memory queue is fast and its job semantics are easy to build, but the backlog, the dedup index, and the in-flight bookkeeping all compete for the same memory with no durable backstop, and overload ends in lockup rather than lag. The fix separated the two roles. Kafka holds the backlog on disk, where it's bounded by retention rather than RAM, and Redis holds only the short dispatch window that workers actually drain, with operators throttling the relay between them. As far as we can tell, that's still largely the system Slack runs today: Kafka for durable buffering, Redis for short-term dispatch state, workers for execution.

That assembly was fairly novel in 2017. Today, few teams of scale would start with their entire backlog in an in-memory queue, and fewer would build the Kafka-to-Redis bridge by hand, but only because modern tools have evolved to absorb the separation Slack built. Kafka with consumer groups serves as the backbone of plenty of job systems directly. SQS bundles durable buffering with acknowledgment, retries, and dead-letter handling, though application-specific scheduling, prioritization, and dedup may still live elsewhere. Durable-execution engines like Temporal go further and persist every step of a job, not just the fact that it was enqueued. Even Redis added Streams a year after this post, a log structure with consumer groups and acknowledgments, though in a conventional deployment the data still has to fit in RAM. The pattern outlived the architecture and is the thing to takeaway here: keep the backlog somewhere that can't run out of memory, and let the fast layer hold only what's in flight.

[Read the original at Slack Engineering](https://slack.engineering/scaling-slacks-job-queue/)

## 🎓 Key Takeaways

- **The root cause was structural, not a bug:** a single bounded pool of RAM held both the burst buffer (the backlog) and the dispatch workspace (dedup index + in-flight bookkeeping), so under overload they starved each other and the queue seized.
- **Full Redis can't self-heal:** dequeuing moves a job onto a processing list, which needs free memory — so a memory-exhausted queue stayed locked even after the database recovered, requiring extensive manual intervention.
- **The fix separates roles:** Kafka holds the durable backlog on disk (bounded by a retention window, not RAM) while Redis keeps only the short dispatch window workers actually drain, with operators throttling the relay between them.
- **Minimum viable change:** two stateless Go services — Kafkagate (enqueue → Kafka) and JQRelay (Kafka → Redis at a controlled rate) — left the enqueue interface and the entire worker side untouched.
- **Correctness comes from ordering:** JQRelay commits a Kafka offset only *after* the Redis write succeeds (at-least-once delivery), coordinates one relay per topic via a Consul distributed lock, and re-enqueues erroring jobs back to Kafka.
- **Ship it safely:** the rollout used double writes, a "shadow" relay that read and dropped real traffic, per-hop job counting, and heartbeat canaries across all 1,600 partitions before touching customers.
- **The pattern outlived the architecture:** keep the backlog somewhere that can't run out of memory, and let the fast layer hold only what's in flight.

## 📚 Related Concepts

- [Redis](../../CoreConcepts/Redis.md) — the in-memory store that held the entire queue, and why fitting the dataset in RAM is the binding constraint.
- [Kafka](../DeepDives/Kafka.md) — the durable append-only log, partitions, offsets, and leader-ack durability tradeoffs Slack relied on.
- [Distributed Locking](../../CoreConcepts/DistributedLocking.md) — the one-relay-per-topic coordination pattern JQRelay runs through Consul.
- [Scaling Writes](../Patterns/ScalingWrites.md) — write queues as durable buffers for burst handling, the pattern this outage motivated.
- [Managing Long Running Tasks](../Patterns/ManagingLongRunningTasks.md) — async job queues and worker pools for work too slow for a web request.
- [Job Scheduler](../ProblemBreakdowns/JobScheduler.md) — designing a job queue from scratch, including dedup, retries, and in-flight tracking.

---
*Source: [https://www.hellointerview.com/learn/system-design/in-the-wild/slack-job-queue](https://www.hellointerview.com/learn/system-design/in-the-wild/slack-job-queue)*
