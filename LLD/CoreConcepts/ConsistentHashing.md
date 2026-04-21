# ⭕ Consistent Hashing

> **Core Concept**: Consistent hashing is an algorithm that minimizes data redistribution when adding or removing servers in a distributed system. It arranges data and servers in a circular space (hash ring) to ensure only a small fraction of data needs to move when the cluster changes.

## 📋 Table of Contents
- [Overview](#overview)
- [The Problem with Simple Hashing](#the-problem-with-simple-hashing)
- [How Consistent Hashing Works](#how-consistent-hashing-works)
- [Virtual Nodes](#virtual-nodes)
- [Real-World Applications](#real-world-applications)
- [Interview Strategy](#interview-strategy)
- [Conclusion](#conclusion)

---

## 🎯 Overview

### The Challenge

```mermaid
graph TB
    START[Growing Distributed System]
    
    START --> P1[Need to add servers<br/>for more capacity]
    START --> P2[Servers fail and<br/>need to be removed]
    
    P1 --> PROBLEM[💥 Problem:<br/>How to redistribute data<br/>with minimal disruption?]
    P2 --> PROBLEM
    
    PROBLEM --> BAD[❌ Simple Modulo:<br/>90% data moves]
    PROBLEM --> GOOD[✅ Consistent Hashing:<br/>Only 1/N data moves]
    
    style PROBLEM fill:#FFB6C1
    style BAD fill:#FFB6C1
    style GOOD fill:#90EE90
```

### Evolution of Data Distribution

```mermaid
graph LR
    SINGLE[Single Server<br/>No distribution needed]
    MODULO[Multiple Servers<br/>Simple Modulo]
    CONSISTENT[Multiple Servers<br/>Consistent Hashing]
    
    SINGLE -->|Scale up| MODULO
    MODULO -->|Resharding problem| CONSISTENT
    
    style SINGLE fill:#FFE4B5
    style MODULO fill:#FFB6C1
    style CONSISTENT fill:#90EE90
```

---

## ❌ The Problem with Simple Hashing

### Scenario: Ticketing System (TicketMaster)

#### Phase 1: Single Database

```mermaid
graph LR
    CLIENT1[Client 1]
    CLIENT2[Client 2]
    CLIENT3[Client 3]
    
    SERVER[Application Server]
    DB[(Single Database<br/>All Events)]
    
    CLIENT1 --> SERVER
    CLIENT2 --> SERVER
    CLIENT3 --> SERVER
    SERVER --> DB
    
    style DB fill:#90EE90
```

**Works great initially!** ✅

#### Phase 2: Need to Scale (Sharding)

```mermaid
graph TB
    CLIENTS[Multiple Clients]
    SERVER[Application Server]
    
    CLIENTS --> SERVER
    
    SERVER --> DB1[(Database 1<br/>Events subset)]
    SERVER --> DB2[(Database 2<br/>Events subset)]
    SERVER --> DB3[(Database 3<br/>Events subset)]
    
    QUESTION[❓ Which events<br/>go to which database?]
    
    style QUESTION fill:#FFE4B5
```

---

### Simple Modulo Hashing

> **Approach**: Hash the event ID, then modulo by number of databases

```mermaid
graph TB
    EVENT[Event ID: 1234]
    
    EVENT --> HASH[Hash Function<br/>hash 1234 = 987654]
    HASH --> MODULO[Modulo Operation<br/>987654 % 3 = ?]
    MODULO --> RESULT[Result: 1<br/>Store in Database 1]
    
    style HASH fill:#e1f5ff
    style RESULT fill:#90EE90
```

**Formula**: `database_id = hash(event_id) % number_of_databases`

#### Example Distribution with 3 Databases

```mermaid
graph LR
    subgraph "Events to Databases"
        E1[Event 1234<br/>hash % 3 = 1]
        E2[Event 5678<br/>hash % 3 = 0]
        E3[Event 9012<br/>hash % 3 = 2]
    end
    
    E1 --> DB1[(DB 1)]
    E2 --> DB0[(DB 0)]
    E3 --> DB2[(DB 2)]
    
    style DB0 fill:#90EE90
    style DB1 fill:#90EE90
    style DB2 fill:#90EE90
```

```
Event #1234 → hash(1234) % 3 = 1 → Database 1
Event #5678 → hash(5678) % 3 = 0 → Database 0
Event #9012 → hash(9012) % 3 = 2 → Database 2
```

---

### Problem 1: Adding a Server

```mermaid
sequenceDiagram
    participant System
    participant DB0 as Database 0
    participant DB1 as Database 1
    participant DB2 as Database 2
    participant DB3 as Database 3 (NEW)
    
    Note over System: Before: 3 databases (% 3)
    System->>DB1: Event 1234 stored here
    
    Note over System,DB3: Add Database 3!
    Note over System: Now: 4 databases (% 4)
    
    System->>System: Recalculate:<br/>hash(1234) % 4 = 0
    Note over System: Was DB1, now DB0!
    
    System->>DB1: Read event 1234
    System->>DB0: Move to DB0
    
    Note over System,DB3: 💥 Almost ALL data<br/>must be redistributed!
```

#### Data Movement Visualization

```mermaid
graph TB
    subgraph "Before: 3 Databases"
        B_E1[Event 1234 → DB 1]
        B_E2[Event 5678 → DB 0]
        B_E3[Event 9012 → DB 2]
    end
    
    ADD[Add Database 3<br/>Change: % 3 → % 4]
    
    subgraph "After: 4 Databases"
        A_E1[Event 1234 → DB 0 ❌]
        A_E2[Event 5678 → DB 2 ❌]
        A_E3[Event 9012 → DB 0 ❌]
    end
    
    B_E1 --> ADD
    B_E2 --> ADD
    B_E3 --> ADD
    
    ADD --> A_E1
    ADD --> A_E2
    ADD --> A_E3
    
    NOTE[90% of data must move!<br/>💥 Database overload<br/>😞 Slow response times]
    
    style ADD fill:#FFB6C1
    style NOTE fill:#FFB6C1
```

---

### Problem 2: Removing a Server

```mermaid
sequenceDiagram
    participant System
    participant DB0 as Database 0
    participant DB1 as Database 1
    participant DB2 as Database 2 (FAILED)
    
    Note over System: Before: 3 databases (% 3)
    System->>DB2: Event 9012 stored here
    
    Note over DB2: 💥 Database 2 fails!
    
    Note over System: Now: 2 databases (% 2)
    System->>System: Recalculate:<br/>hash(9012) % 2 = ?
    
    Note over System,DB2: 💥 Massive redistribution<br/>again!
```

#### The Redistribution Cascade

```mermaid
graph TB
    FAILURE[Database Failure]
    
    FAILURE --> CHANGE[Hash function changes<br/>% 3 → % 2]
    
    CHANGE --> MOVE1[Event A: DB0 → DB1]
    CHANGE --> MOVE2[Event B: DB1 → DB0]
    CHANGE --> MOVE3[Event C: DB2 → DB0]
    CHANGE --> MOVE4[Event D: DB0 → DB1]
    
    IMPACT[💥 High load on all DBs<br/>😞 Users see errors<br/>⏱️ Slow queries]
    
    MOVE1 --> IMPACT
    MOVE2 --> IMPACT
    MOVE3 --> IMPACT
    MOVE4 --> IMPACT
    
    style FAILURE fill:#FFB6C1
    style CHANGE fill:#FFB6C1
    style IMPACT fill:#FFB6C1
```

---

## ✅ How Consistent Hashing Works

### The Hash Ring Concept

> **Key Insight**: Arrange both data and servers in a circular space

```mermaid
graph TB
    subgraph "Hash Ring (0-100)"
        RING[Circular Space]
        
        RING --> P0[Position 0<br/>Database 1]
        RING --> P25[Position 25<br/>Database 2]
        RING --> P50[Position 50<br/>Database 3]
        RING --> P75[Position 75<br/>Database 4]
        
        RING --> E1[Event hashes to 10<br/>→ Goes to DB1]
        RING --> E2[Event hashes to 60<br/>→ Goes to DB4]
    end
    
    NOTE[Move clockwise to find<br/>next database]
    
    style RING fill:#e1f5ff
    style P0 fill:#90EE90
    style P25 fill:#90EE90
    style P50 fill:#90EE90
    style P75 fill:#90EE90
```

### Hash Ring Visualization

```mermaid
%%{init: {'theme':'base'}}%%
graph TB
    subgraph "Hash Ring Structure"
        direction TB
        
        TOP["Position 0<br/>🔵 Database 1"]
        RIGHT["Position 25<br/>🟢 Database 2"]
        BOTTOM["Position 50<br/>🟡 Database 3"]
        LEFT["Position 75<br/>🔴 Database 4"]
        
        TOP -.->|Clockwise| RIGHT
        RIGHT -.->|Clockwise| BOTTOM
        BOTTOM -.->|Clockwise| LEFT
        LEFT -.->|Clockwise| TOP
    end
    
    E1[Event at position 10<br/>→ Next DB clockwise = DB2]
    E2[Event at position 40<br/>→ Next DB clockwise = DB3]
    E3[Event at position 85<br/>→ Next DB clockwise = DB1]
    
    style TOP fill:#e1f5ff
    style RIGHT fill:#90EE90
    style BOTTOM fill:#FFE4B5
    style LEFT fill:#FFB6C1
```

### How Assignment Works

```mermaid
sequenceDiagram
    participant Event as Event ID: 1234
    participant Hash as Hash Function
    participant Ring as Hash Ring
    participant DB as Database
    
    Event->>Hash: Hash event ID
    Hash-->>Ring: Position: 15
    
    Note over Ring: Find position 15 on ring
    Note over Ring: Move clockwise
    Note over Ring: First DB found: DB2 at 25
    
    Ring->>DB: Store at Database 2
    
    Note over Event,DB: ✅ Event 1234 → Database 2
```

**Algorithm**:
1. Hash the event ID to get a position on the ring (0-100)
2. Find that position on the ring
3. Move clockwise until you hit a database
4. Store the event in that database

---

### Adding a Server (Consistent Hashing)

```mermaid
graph TB
    subgraph "Before: 4 Databases"
        B_DB1[DB1 at 0<br/>Handles 0-25]
        B_DB2[DB2 at 25<br/>Handles 25-50]
        B_DB3[DB3 at 50<br/>Handles 50-75]
        B_DB4[DB4 at 75<br/>Handles 75-100]
    end
    
    ADD[Add DB5 at position 90]
    
    subgraph "After: 5 Databases"
        A_DB1[DB1 at 0<br/>Handles 0-25<br/>✅ No change]
        A_DB2[DB2 at 25<br/>Handles 25-50<br/>✅ No change]
        A_DB3[DB3 at 50<br/>Handles 50-75<br/>✅ No change]
        A_DB4[DB4 at 75<br/>Handles 75-90<br/>⚠️ Reduced range]
        A_DB5[DB5 at 90<br/>Handles 90-100<br/>🆕 New data]
    end
    
    B_DB4 --> ADD
    ADD --> A_DB4
    ADD --> A_DB5
    
    NOTE[✅ Only 15% of data moves!<br/>From DB4 to DB5<br/>All other DBs untouched]
    
    style ADD fill:#90EE90
    style NOTE fill:#90EE90
```

#### Impact Analysis

```mermaid
graph LR
    IMPACT[Adding DB5]
    
    IMPACT --> MOVE[Only events in range<br/>75-90 move]
    IMPACT --> STAY1[DB1: 100% stays ✅]
    IMPACT --> STAY2[DB2: 100% stays ✅]
    IMPACT --> STAY3[DB3: 100% stays ✅]
    IMPACT --> PARTIAL[DB4: ~70% stays ✅<br/>~30% moves to DB5]
    
    style IMPACT fill:#e1f5ff
    style MOVE fill:#FFE4B5
    style STAY1 fill:#90EE90
    style STAY2 fill:#90EE90
    style STAY3 fill:#90EE90
    style PARTIAL fill:#FFE4B5
```

**Result**: Only ~15% of total data needs to move!

---

### Removing a Server (Consistent Hashing)

```mermaid
sequenceDiagram
    participant System
    participant DB1 as Database 1 (0)
    participant DB2 as Database 2 (25)
    participant DB3 as Database 3 (50)
    participant DB4 as Database 4 (75)
    
    Note over DB2: 💥 Database 2 fails!
    
    System->>System: Remove DB2 from ring
    
    Note over System: Events at 25-50<br/>need new home
    Note over System: Move clockwise from 25
    Note over System: Next DB: DB3 at 50
    
    System->>DB3: Move DB2's events to DB3
    
    Note over DB1: ✅ DB1 unchanged
    Note over DB4: ✅ DB4 unchanged
    Note over DB3: DB3 gets DB2's data
    
    Note over System: ✅ Only 25% of data moved<br/>Only from DB2 to DB3
```

#### Removal Impact

```mermaid
graph TB
    REMOVE[Remove Database 2]
    
    REMOVE --> UNCHANGED1[DB1: No change ✅]
    REMOVE --> AFFECTED[DB3: Gets DB2's data]
    REMOVE --> UNCHANGED2[DB4: No change ✅]
    
    AFFECTED --> LOAD[DB3 now handles<br/>positions 25-75<br/>2x normal load]
    
    NOTE[✅ Only 1/N data moves<br/>⚠️ Load imbalance issue]
    
    style REMOVE fill:#FFB6C1
    style UNCHANGED1 fill:#90EE90
    style UNCHANGED2 fill:#90EE90
    style AFFECTED fill:#FFE4B5
    style LOAD fill:#FFB6C1
```

---

## 🔀 Virtual Nodes

> **Problem**: When removing a server, all its load goes to one neighbor, creating imbalance

### The Load Imbalance Problem

```mermaid
graph LR
    subgraph "After Removing DB2"
        DB1[DB1: 25% load<br/>Position 0-25]
        DB3[DB3: 50% load 💥<br/>Position 25-75<br/>OVERLOADED!]
        DB4[DB4: 25% load<br/>Position 75-100]
    end
    
    NOTE[❌ DB3 has 2x load<br/>❌ Uneven distribution<br/>❌ Potential bottleneck]
    
    style DB1 fill:#90EE90
    style DB3 fill:#FFB6C1
    style DB4 fill:#90EE90
    style NOTE fill:#FFB6C1
```

---

### Solution: Virtual Nodes

> **Concept**: Place each database at multiple positions on the ring

```mermaid
graph TB
    DB1[Database 1]
    DB2[Database 2]
    DB3[Database 3]
    
    DB1 --> VN1_1[DB1-vn1 at pos 15]
    DB1 --> VN1_2[DB1-vn2 at pos 45]
    DB1 --> VN1_3[DB1-vn3 at pos 85]
    
    DB2 --> VN2_1[DB2-vn1 at pos 5]
    DB2 --> VN2_2[DB2-vn2 at pos 35]
    DB2 --> VN2_3[DB2-vn3 at pos 65]
    
    DB3 --> VN3_1[DB3-vn1 at pos 25]
    DB3 --> VN3_2[DB3-vn2 at pos 55]
    DB3 --> VN3_3[DB3-vn3 at pos 95]
    
    NOTE[Each DB appears<br/>multiple times on ring]
    
    style DB1 fill:#e1f5ff
    style DB2 fill:#e1f5ff
    style DB3 fill:#e1f5ff
```

### How Virtual Nodes Work

**Instead of**:
```
DB1 → hash("DB1") = position 0
```

**Use**:
```
DB1-vn1 → hash("DB1-vn1") = position 15
DB1-vn2 → hash("DB1-vn2") = position 45
DB1-vn3 → hash("DB1-vn3") = position 85
```

### Hash Ring with Virtual Nodes

```mermaid
%%{init: {'theme':'base'}}%%
graph TB
    subgraph "Ring with Virtual Nodes"
        P5[DB2-vn1<br/>pos 5]
        P15[DB1-vn1<br/>pos 15]
        P25[DB3-vn1<br/>pos 25]
        P35[DB2-vn2<br/>pos 35]
        P45[DB1-vn2<br/>pos 45]
        P55[DB3-vn2<br/>pos 55]
        P65[DB2-vn3<br/>pos 65]
        P85[DB1-vn3<br/>pos 85]
        P95[DB3-vn3<br/>pos 95]
        
        P5 -.-> P15 -.-> P25 -.-> P35
        P35 -.-> P45 -.-> P55 -.-> P65
        P65 -.-> P85 -.-> P95 -.-> P5
    end
    
    NOTE[Virtual nodes<br/>naturally intermixed<br/>around the ring]
    
    style P5 fill:#FFB6C1
    style P35 fill:#FFB6C1
    style P65 fill:#FFB6C1
    style P15 fill:#e1f5ff
    style P45 fill:#e1f5ff
    style P85 fill:#e1f5ff
    style P25 fill:#90EE90
    style P55 fill:#90EE90
    style P95 fill:#90EE90
```

---

### Removing Server with Virtual Nodes

```mermaid
sequenceDiagram
    participant Ring as Hash Ring
    participant DB1
    participant DB2
    participant DB3
    
    Note over Ring: DB2 has virtual nodes at:<br/>5, 35, 65
    
    Note over DB2: 💥 Database 2 fails!
    
    Ring->>Ring: Remove DB2-vn1 (pos 5)
    Note over Ring: Events 5-15 → DB1
    
    Ring->>Ring: Remove DB2-vn2 (pos 35)
    Note over Ring: Events 35-45 → DB1
    
    Ring->>Ring: Remove DB2-vn3 (pos 65)
    Note over Ring: Events 65-85 → DB1
    
    Note over DB1: Gets ~33% of DB2's load
    Note over DB3: Gets ~33% of DB2's load
    Note over Ring: Other DBs get rest
    
    Note over Ring: ✅ Load distributed evenly!
```

### Load Distribution Comparison

```mermaid
graph TB
    subgraph "Without Virtual Nodes"
        W1[DB1: 25%]
        W3[DB3: 50% 💥]
        W4[DB4: 25%]
    end
    
    subgraph "With Virtual Nodes"
        V1[DB1: 33%]
        V3[DB3: 33%]
        V4[DB4: 34%]
    end
    
    NOTE1[❌ Imbalanced<br/>One DB overloaded]
    NOTE2[✅ Balanced<br/>Even distribution]
    
    W3 --> NOTE1
    V3 --> NOTE2
    
    style W3 fill:#FFB6C1
    style NOTE1 fill:#FFB6C1
    style V1 fill:#90EE90
    style V3 fill:#90EE90
    style V4 fill:#90EE90
    style NOTE2 fill:#90EE90
```

### Benefits of Virtual Nodes

```mermaid
mindmap
    root((Virtual Nodes))
        Even Distribution
            Load spread across all servers
            No single overloaded server
            Better resource utilization
        Flexibility
            Different servers different VNs
            More VNs = more balanced
            Typical: 100-200 per server
        Graceful Degradation
            Server failure distributed
            Multiple servers share load
            No single point of stress
```

**Typical Configuration**: 100-200 virtual nodes per physical server

---

## 🌍 Real-World Applications

```mermaid
graph TB
    CH[Consistent Hashing]
    
    CH --> DB[Distributed Databases]
    CH --> CACHE[Distributed Caches]
    CH --> CDN[Content Delivery]
    CH --> BROKER[Message Brokers]
    
    DB --> DB1[Apache Cassandra<br/>Data partitioning]
    DB --> DB2[Amazon DynamoDB<br/>Auto-scaling]
    
    CACHE --> C1[Redis Cluster<br/>Key distribution]
    CACHE --> C2[Memcached<br/>Cache sharding]
    
    CDN --> CDN1[Edge Server Selection<br/>Content routing]
    
    BROKER --> B1[Kafka<br/>Partition assignment]
    
    style CH fill:#e1f5ff
    style DB1 fill:#90EE90
    style DB2 fill:#90EE90
    style C1 fill:#90EE90
    style C2 fill:#90EE90
    style CDN1 fill:#90EE90
    style B1 fill:#90EE90
```

### Example: Apache Cassandra

```mermaid
graph TB
    CLIENT[Client Request]
    
    CLIENT --> HASH[Hash partition key]
    HASH --> RING[Consistent Hash Ring]
    
    RING --> N1[Node 1<br/>Token range:<br/>0 - 25]
    RING --> N2[Node 2<br/>Token range:<br/>25 - 50]
    RING --> N3[Node 3<br/>Token range:<br/>50 - 75]
    RING --> N4[Node 4<br/>Token range:<br/>75 - 100]
    
    HASH -.->|Hash = 60| N3
    
    NOTE[Data automatically<br/>rebalanced on node<br/>addition/removal]
    
    style RING fill:#e1f5ff
    style N3 fill:#90EE90
```

### Example: Amazon DynamoDB

```mermaid
sequenceDiagram
    participant App as Application
    participant DDB as DynamoDB
    participant P1 as Partition 1
    participant P2 as Partition 2
    participant P3 as Partition 3
    
    App->>DDB: PUT item (partition_key="user123")
    DDB->>DDB: Hash partition key
    Note over DDB: Uses consistent hashing
    DDB->>P2: Route to partition
    P2-->>DDB: Success
    DDB-->>App: Item stored
    
    Note over DDB,P3: Auto-scales partitions<br/>using consistent hashing
```

---

## 🏭 Production Implementation Details

### Cassandra: 256 Virtual Nodes

Cassandra uses Murmur3 hash and by default assigns **256 virtual nodes (vnodes)** per physical node. This number is configurable in `cassandra.yaml`:

```yaml
# cassandra.yaml
num_tokens: 256   # Virtual nodes per physical node
partitioner: org.apache.cassandra.dht.Murmur3Partitioner
```

**Why 256?** At 256 vnodes, adding or removing a node redistributes ~1/N of data across ~N neighbors, rather than dumping everything onto one neighbor.

```mermaid
graph TB
    subgraph "3-Node Cassandra Cluster"
        N1[Node 1<br/>256 tokens spread<br/>around the ring]
        N2[Node 2<br/>256 tokens spread<br/>around the ring]
        N3[Node 3<br/>256 tokens spread<br/>around the ring]
    end

    subgraph "Adding Node 4"
        N4[Node 4<br/>New 256 tokens<br/>steal ~1/4 from each existing node]
    end

    NOTE[Each of N1, N2, N3 gives<br/>~64 tokens to N4<br/>Total moved: ~25% of data]

    style N4 fill:#90EE90
    style NOTE fill:#e1f5ff
```

### DynamoDB: Automatic Partition Splits

DynamoDB uses consistent hashing internally but abstracts it away. Partitions split automatically when:
- **Size exceeds 10GB** per partition
- **Throughput exceeds ~3,000 RCU or 1,000 WCU** per partition

```mermaid
sequenceDiagram
    participant App
    participant DDB as DynamoDB
    participant P1 as Partition 1 (0-50)
    participant P1A as Partition 1A (0-25)
    participant P1B as Partition 1B (25-50)

    App->>DDB: Heavy writes to partition 1
    Note over P1: Approaches 10GB / 3000 RCU
    DDB->>DDB: Trigger partition split
    P1->>P1A: Keys 0-25 → Partition 1A
    P1->>P1B: Keys 25-50 → Partition 1B
    App->>DDB: Traffic now spread across 1A and 1B
    Note over App,P1B: ✅ Transparent to application
```

**Hot partition problem**: If your partition key has low cardinality (e.g., `status = 'pending'`), all writes go to one partition regardless of consistent hashing. This is the DynamoDB hot key anti-pattern.

### Nginx Consistent Hashing for Upstream Proxies

Nginx and HAProxy use consistent hashing to route requests to the same backend (sticky routing without sessions):

```nginx
upstream backend {
    consistent_hash $request_uri;   # Route based on URL path
    server backend1:8080;
    server backend2:8080;
    server backend3:8080;
}
```

**Use case**: CDN origin routing — same content URL always goes to the same origin server, improving cache efficiency.

### Ketama Algorithm (Memcached Standard)

Libmemcached and most Memcached clients use the Ketama algorithm, which is consistent hashing with a specific MD5-based implementation:

```python
import hashlib
import bisect

class KetamaRing:
    def __init__(self, nodes, replicas=150):
        self.ring = {}
        self.sorted_keys = []

        for node in nodes:
            for i in range(replicas):
                key = self._hash(f"{node}-{i}")
                self.ring[key] = node
                self.sorted_keys.append(key)

        self.sorted_keys.sort()

    def _hash(self, key):
        return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)

    def get_node(self, key):
        if not self.ring:
            return None
        hash_val = self._hash(key)
        idx = bisect.bisect(self.sorted_keys, hash_val) % len(self.sorted_keys)
        return self.ring[self.sorted_keys[idx]]
```

**150 replicas** is the Ketama default — balances distribution quality vs memory overhead.

### Load Balancer Consistent Hashing (Session Affinity)

AWS ALB, GCP Load Balancer, and Nginx all support consistent hashing for session affinity:

```
Without consistent hashing:
- User's requests go to random backend
- Each backend has its own in-memory session
- Session data lost on next request

With consistent hashing:
- hash(user_ip or session_cookie) → always same backend
- Session stays consistent
- Backend crash → only that backend's users affected
```

---

## 🎤 Interview Strategy

### When to Discuss Consistent Hashing

```mermaid
flowchart TB
    START[System Design Interview]
    
    START --> Q1{Designing<br/>distributed system<br/>from scratch?}
    
    Q1 -->|Yes| DEEP[Deep Dive Required]
    Q1 -->|No| Q2{Using existing<br/>distributed DB?}
    
    Q2 -->|Yes| MENTION[Brief Mention]
    Q2 -->|No| SKIP[Not Needed]
    
    DEEP --> D1[Explain algorithm]
    DEEP --> D2[Discuss virtual nodes]
    DEEP --> D3[Handle edge cases]
    
    MENTION --> M1[DynamoDB/Cassandra<br/>uses consistent hashing]
    
    style DEEP fill:#FFE4B5
    style MENTION fill:#90EE90
    style SKIP fill:#e1f5ff
```

### Interview Scenarios

**Requires Deep Dive**:
- 🔴 Design a distributed database
- 🔴 Design a distributed cache
- 🔴 Design a distributed message broker
- 🔴 Infrastructure-focused interviews

**Brief Mention Sufficient**:
- 🟢 Using DynamoDB/Cassandra
- 🟢 Using Redis Cluster
- 🟢 Standard system design questions

---

### What to Explain in Interviews

```mermaid
mindmap
    root((Consistent Hashing Interview))
        The Problem
            Simple modulo fails
            90% data movement
            Cascading redistribution
        The Solution
            Hash ring concept
            Clockwise traversal
            Minimal data movement
        Virtual Nodes
            Load balancing
            Even distribution
            100-200 per server
        Trade-offs
            Complexity vs simplicity
            Memory overhead
            Rebalancing strategy
```

### Example Interview Script

**1. Identify the Problem**:
> "When we add or remove servers with simple modulo hashing, we have to redistribute almost all the data. For example, going from 3 to 4 servers changes the hash function from `% 3` to `% 4`, which remaps most keys."

**2. Introduce Consistent Hashing**:
> "Consistent hashing solves this by using a hash ring. We hash both the data keys and server IDs onto a circular space from 0 to 2^32. To find which server stores a key, we locate the key on the ring and move clockwise to the first server."

**3. Explain the Benefit**:
> "When we add a server, only the keys between the new server and its predecessor need to move - that's just 1/N of the data. When we remove a server, only its keys move to the next server clockwise."

**4. Address Virtual Nodes**:
> "To prevent load imbalance, we use virtual nodes. Each physical server is mapped to multiple positions on the ring - typically 100-200 positions. This ensures that when a server fails, its load gets distributed evenly across all remaining servers instead of overwhelming a single neighbor."

**5. Real-World Application**:
> "Systems like Cassandra and DynamoDB use consistent hashing internally to handle data distribution and rebalancing automatically."

---

## 📊 Comparison Summary

### Simple Modulo vs Consistent Hashing

```mermaid
graph TB
    subgraph "Simple Modulo Hashing"
        SM[hash key % N]
        SM --> SM1[❌ 90% data moves on resize]
        SM --> SM2[❌ All servers affected]
        SM --> SM3[✅ Simple to implement]
        SM --> SM4[✅ Even distribution]
    end
    
    subgraph "Consistent Hashing"
        CH[Hash Ring + Virtual Nodes]
        CH --> CH1[✅ Only 1/N data moves]
        CH --> CH2[✅ Minimal servers affected]
        CH --> CH3[❌ More complex]
        CH --> CH4[✅ Even distribution]
    end
    
    style SM fill:#FFB6C1
    style CH fill:#90EE90
```

### Performance Metrics

| Metric | Simple Modulo | Consistent Hashing | Winner |
|--------|---------------|-------------------|--------|
| **Data Movement (Add)** | 90% | 1/N (e.g., 10%) | ✅ CH |
| **Data Movement (Remove)** | 90% | 1/N (e.g., 10%) | ✅ CH |
| **Load Balance** | Even | Even (with VNs) | ✅ Tie |
| **Implementation** | Very Simple | Moderate | ⚠️ Modulo |
| **Query Routing** | O(1) | O(log N) or O(1) | ✅ Tie |
| **Memory Overhead** | Minimal | Higher (VN tracking) | ⚠️ Modulo |

---

## 🎓 Key Takeaways

```mermaid
mindmap
    root((Consistent Hashing))
        Core Concept
            Hash ring 0 to 2^32
            Clockwise traversal
            Minimal redistribution
        Key Benefits
            Only 1/N data moves
            Predictable behavior
            Scalable architecture
        Virtual Nodes
            Load balancing
            100-200 per server
            Even distribution
        Use Cases
            Distributed databases
            Distributed caches
            CDNs and load balancers
        Interview Tips
            Explain the problem first
            Draw the ring
            Mention virtual nodes
            Know when to go deep
```

### Algorithm Summary

```mermaid
flowchart TB
    START[Data Key]
    
    START --> HASH[Hash the Key]
    HASH --> POS[Get Position on Ring<br/>0 to 2^32-1]
    POS --> FIND[Find Position on Ring]
    FIND --> CLOCKWISE[Move Clockwise]
    CLOCKWISE --> SERVER[First Server Found]
    SERVER --> STORE[Store/Retrieve Data]
    
    style START fill:#e1f5ff
    style HASH fill:#FFE4B5
    style SERVER fill:#90EE90
    style STORE fill:#90EE90
```

### Quick Reference

**When Node Added**:
- ✅ Only keys between new node and predecessor move
- ✅ All other nodes unchanged
- ✅ ~1/N data movement

**When Node Removed**:
- ✅ Only that node's keys move
- ✅ Keys move to next node clockwise
- ✅ ~1/N data movement
- ⚠️ Use virtual nodes to prevent imbalance

**Virtual Nodes**:
- Each physical server = 100-200 virtual nodes
- Prevents load imbalance
- Better fault tolerance
- More even distribution

---

## 📝 Conclusion

### The Elegant Solution

```mermaid
graph LR
    PROBLEM[Distributed System<br/>Scaling Problem]
    
    PROBLEM --> SIMPLE[Simple Solution:<br/>Modulo Hashing]
    PROBLEM --> ELEGANT[Elegant Solution:<br/>Consistent Hashing]
    
    SIMPLE --> SIMPLE_ISSUE[90% data moves<br/>System overload]
    ELEGANT --> ELEGANT_WIN[1/N data moves<br/>Minimal disruption]
    
    style PROBLEM fill:#e1f5ff
    style SIMPLE fill:#FFB6C1
    style ELEGANT fill:#90EE90
    style SIMPLE_ISSUE fill:#FFB6C1
    style ELEGANT_WIN fill:#90EE90
```

### Core Principles

> **The Beauty of Consistent Hashing**: Arrange everything in a circle and walk clockwise.

**Three Key Ideas**:
1. 🔵 **Hash Ring**: Circular space where both data and servers live
2. 🔄 **Clockwise Rule**: Always move clockwise to find the next server
3. 🔀 **Virtual Nodes**: Place each server at multiple positions for balance

**The Impact**:
- 90% data movement → 10% data movement
- System-wide disruption → Localized changes
- Complex resharding → Simple addition/removal

### Remember for Interviews

✅ **Do**:
- Explain the problem first (simple modulo issues)
- Draw the hash ring visually
- Mention virtual nodes for load balancing
- Connect to real systems (Cassandra, DynamoDB)

❌ **Don't**:
- Jump straight to implementation
- Over-complicate for standard questions
- Forget to mention when NOT to discuss it
- Implement from scratch unless asked

### Final Thoughts

```mermaid
graph TB
    QUESTION[Is Consistent Hashing Needed?]
    
    QUESTION --> INFRA{Infrastructure<br/>focused interview?}
    
    INFRA -->|Yes| DEEP[Explain in detail:<br/>- Hash ring<br/>- Virtual nodes<br/>- Rebalancing]
    
    INFRA -->|No| BRIEF{Using distributed<br/>database?}
    
    BRIEF -->|Yes| MENTION[Brief mention:<br/>Cassandra/DynamoDB<br/>uses it internally]
    
    BRIEF -->|No| SKIP[Skip entirely]
    
    style DEEP fill:#FFE4B5
    style MENTION fill:#90EE90
    style SKIP fill:#e1f5ff
```

> **Interview Wisdom**: Most interviews just need you to know that DynamoDB and Cassandra handle this for you. Save the deep dive for infrastructure-focused roles!

---

## 📚 Related Concepts

- [Sharding](./Sharding.md) - Horizontal partitioning strategies
- [Load Balancing](./LoadBalancing.md) - Distributing requests
- [Caching](./Caching.md) - Distributed cache patterns
- [Replication](./Replication.md) - Data redundancy strategies
- [CAP Theorem](./CAPTheorem.md) - Distributed system trade-offs

---

**Last Updated**: December 2024
**Source**: [HelloInterview - Consistent Hashing](https://www.hellointerview.com/learn/system-design/core-concepts/consistent-hashing)

> **💡 Final Tip**: Consistent hashing is elegant and powerful, but in most system design interviews, you just need to know it exists and when it's used. Focus on solving the problem, not memorizing the algorithm!
