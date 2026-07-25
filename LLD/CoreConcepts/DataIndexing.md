# 🗂️ Database Indexing

> **Core Concept**: Database indexes are separate data structures optimized for searching that allow databases to quickly locate records without examining every row. They're essential for making queries fast and efficient.

## 📋 Table of Contents
- [Overview](#overview)
- [How Database Indexes Work](#how-database-indexes-work)
- [Types of Indexes](#types-of-indexes)
- [Index Optimization Patterns](#index-optimization-patterns)
- [Best Practices](#best-practices)

---

## 🎯 Overview

### The Problem

Imagine searching for a user's profile by email in a table with millions of records:

```mermaid
graph TB
    subgraph "Without Index - Sequential Scan"
        Q1[Query: Find email='john@example.com']
        R1[Row 1: alice@...]
        R2[Row 2: bob@...]
        R3[Row 3: ...]
        RN[Row N: john@...]
        
        Q1 --> R1
        R1 --> R2
        R2 --> R3
        R3 --> RN
        
        NOTE1[❌ Must scan ALL rows<br/>❌ Millions of disk reads<br/>❌ Painfully slow]
    end
    
    style Q1 fill:#FFB6C1
    style NOTE1 fill:#FFE4B5
```

**Without indexes**: Database checks each row sequentially - like searching through every book in a library one by one.

### The Solution

```mermaid
graph TB
    subgraph "With Index - Direct Lookup"
        Q2[Query: Find email='john@example.com']
        IDX[Email Index<br/>B-Tree Structure]
        TARGET[Row 1,337,420: john@...]
        
        Q2 --> IDX
        IDX --> TARGET
        
        NOTE2[✅ Jump directly to target<br/>✅ 2-3 disk reads only<br/>✅ Lightning fast]
    end
    
    style Q2 fill:#90EE90
    style IDX fill:#e1f5ff
    style NOTE2 fill:#90EE90
```

**With indexes**: Database uses optimized data structures to jump directly to the target - like using a book's index.

---

## 🧒 Layman's Explanation

Database indexes are easier to grasp once you realize you've used them your whole life — just on paper.

**The textbook index.** Imagine you're studying biology and want to find every mention of "photosynthesis." Without an index, you'd flip through every page from cover to cover, scanning each line. That's a sequential scan, and on a 1,000-page book it's miserable. Instead, you flip to the back of the book, find "photosynthesis: pp. 234, 567," and jump straight to those pages. The index is a separate, sorted list pointing into the main content — exactly what a database index does for rows.

**The library card catalog.** Old libraries had wooden drawers full of index cards organized by author, title, and subject. Each card pointed to a shelf number. Without it, you'd walk every aisle hoping to stumble onto the book you wanted. Modern library search computers do the same job digitally. Notice that the library maintains *multiple* catalogs — one sorted by author, one by title, one by subject — because different visitors search in different ways. Databases do the same: one index per access pattern.

**The phonebook.** A phonebook is sorted alphabetically by last name. To find "Smith," you flip to the S section and binary-search your way down — seconds. But try finding someone by their *phone number* in that same book. You'd have to read every single entry, because the book wasn't organized for that question. Same data, wrong index. This is why databases need different indexes for different access patterns: the structure must match the question.

Now, what if you wanted to find all "Smiths in zip code 94110"? A phonebook sorted only by last name still helps — you find the Smiths quickly — but then you have to scan every Smith for the right zip. A *composite* phonebook sorted first by last name, *then* by zip within each name group, lets you jump directly to "Smith, 94110" with no scanning. That's a composite index: column order matters because it defines the sort hierarchy.

### When the analogy breaks down

Real books don't update — but database tables do. Every time a row is inserted, deleted, or modified, **every index on that table must also be updated**. It's as if every time you added a sentence to your textbook, you also had to rewrite the index at the back. Indexes cost storage (sometimes nearly as much as the data itself) and slow down writes proportionally to how many you have. Too few indexes and reads crawl; too many and writes choke. The art is matching indexes precisely to the queries your application actually runs — no more, no less.

---

## ⚙️ How Database Indexes Work

### Physical Storage Overview

```mermaid
graph TB
    subgraph "Database Storage"
        DISK[Disk Storage<br/>SSD/HDD]
        TABLE[Table Data<br/>Heap File]
        INDEX[Index Files<br/>B-Tree/Hash/etc]
        
        DISK --> TABLE
        DISK --> INDEX
    end
    
    subgraph "Query Execution"
        QUERY[Query Request]
        MEM[Memory/RAM]
        RESULT[Query Result]
        
        QUERY --> INDEX
        INDEX -->|Locate pages| TABLE
        TABLE -->|Load into| MEM
        MEM --> RESULT
    end
    
    style DISK fill:#e1f5ff
    style INDEX fill:#90EE90
    style MEM fill:#FFE4B5
```

### Access Pattern Comparison

```mermaid
sequenceDiagram
    participant Query
    participant Index
    participant Disk
    participant Memory
    
    Note over Query,Memory: Without Index (Sequential Scan)
    Query->>Disk: Read page 1
    Disk->>Memory: Load page 1
    Memory-->>Query: Not found
    Query->>Disk: Read page 2
    Disk->>Memory: Load page 2
    Memory-->>Query: Not found
    Query->>Disk: Read page 3...
    Note over Query,Memory: Continue for ALL pages...
    
    Note over Query,Memory: With Index (Direct Access)
    Query->>Index: Lookup key
    Index->>Index: Traverse B-Tree (2-3 nodes)
    Index-->>Query: Found at page 1,337,420
    Query->>Disk: Read page 1,337,420
    Disk->>Memory: Load page 1,337,420
    Memory-->>Query: ✅ Found!
```

### Key Concepts

**Data Storage**:
- Tables stored as **heap files** on disk
- Data written as collection of rows in no particular order
- Like a notebook where you write entries as they come

**Memory vs Disk**:
- Data lives on disk (SSD/HDD)
- Can only process data when loaded into RAM
- Every query requires disk → memory transfer

**Index Benefit**:
- Provides structured path directly to target data
- Minimizes number of pages read from storage
- Transforms random access into guided navigation

> **⚠️ Important**: Even with SSDs, random access is significantly slower than sequential. Proper indexing is critical for performance.

---

### Cost of Indexes

```mermaid
graph TB
    IDX[Database Index]
    
    IDX --> COST1[💾 Additional Disk Space<br/>Nearly as much as original data]
    IDX --> COST2[✍️ Write Performance Hit<br/>Every write updates ALL indexes]
    IDX --> COST3[🔧 Maintenance Overhead<br/>Rebalancing, compaction]
    
    subgraph "When Indexes Hurt"
        CASE1[Frequent writes, rare reads<br/>Example: Logging tables]
        CASE2[Small tables<br/>Example: Few hundred rows]
        CASE3[Too many indexes<br/>Example: 10+ indexes per table]
    end
    
    IDX --> CASE1
    IDX --> CASE2
    IDX --> CASE3
    
    style IDX fill:#FFE4B5
    style COST1 fill:#FFB6C1
    style COST2 fill:#FFB6C1
    style COST3 fill:#FFB6C1
```

#### Trade-offs

**Costs**:
- 💾 **Disk Space**: Each index requires additional storage
- ✍️ **Write Performance**: Single write operation triggers updates to all indexes
- 🔧 **Maintenance**: Database must keep indexes balanced and optimized

**When to Avoid Indexes**:
- Logging tables (frequent inserts, rare queries)
- Small tables (few hundred rows - sequential scan is faster)
- Rarely queried columns

> **💡 Pro Tip**: Modern databases have smart buffer pool management. Monitor index usage and remove unnecessary indexes.

---

## 📊 Types of Indexes

```mermaid
mindmap
    root((Index Types))
        B-Tree
            Default choice
            Range queries
            Sorted order
            PostgreSQL, MySQL
        LSM Tree
            Write-heavy workloads
            Log-structured
            Cassandra, RocksDB
        Hash
            Exact matches only
            O 1 lookups
            In-memory caches
        Geospatial
            Location data
            Quadtree, R-Tree
            Geohash
        Inverted
            Full-text search
            Elasticsearch
            Word to documents
```

---

### 1️⃣ B-Tree Indexes

> **Most Common**: Default choice for almost all database indexes. If unsure in an interview, choose B-Tree.

#### Structure

```mermaid
graph TB
    subgraph "B-Tree Index on User ID"
        ROOT[Root Node<br/>Keys: 100, 200, 300]
        
        L1A[Node<br/>10, 50, 90]
        L1B[Node<br/>150, 180]
        L1C[Node<br/>250, 280]
        L1D[Node<br/>350, 400, 450]
        
        ROOT -->|< 100| L1A
        ROOT -->|100-200| L1B
        ROOT -->|200-300| L1C
        ROOT -->|> 300| L1D
        
        LEAF1[Leaf: 5, 10, 15...]
        LEAF2[Leaf: 50, 55, 60...]
        LEAF3[Leaf: 90, 95...]
        LEAF4[Leaf: 150, 155...]
        LEAF5[Leaf: 180, 185...]
        LEAF6[Leaf: 250, 255...]
        LEAF7[Leaf: 280, 285...]
        LEAF8[Leaf: 350, 355...]
        LEAF9[Leaf: 400, 405...]
        LEAF10[Leaf: 450, 455...]
        
        L1A --> LEAF1
        L1A --> LEAF2
        L1A --> LEAF3
        L1B --> LEAF4
        L1B --> LEAF5
        L1C --> LEAF6
        L1C --> LEAF7
        L1D --> LEAF8
        L1D --> LEAF9
        L1D --> LEAF10
    end
    
    style ROOT fill:#e1f5ff
    style L1A fill:#fff4e1
    style L1B fill:#fff4e1
    style L1C fill:#fff4e1
    style L1D fill:#fff4e1
    style LEAF1 fill:#90EE90
    style LEAF2 fill:#90EE90
    style LEAF3 fill:#90EE90
    style LEAF4 fill:#90EE90
    style LEAF5 fill:#90EE90
    style LEAF6 fill:#90EE90
    style LEAF7 fill:#90EE90
    style LEAF8 fill:#90EE90
    style LEAF9 fill:#90EE90
    style LEAF10 fill:#90EE90
```

#### Search Example: Finding ID = 350

```mermaid
sequenceDiagram
    participant Q as Query
    participant R as Root Node
    participant I as Internal Node
    participant L as Leaf Node
    
    Q->>R: Find ID = 350
    Note over R: Keys: 100, 200, 300<br/>350 > 300
    R->>I: Follow pointer for > 300
    Note over I: Keys: 350, 400, 450<br/>350 = 350
    I->>L: Follow pointer for 350
    Note over L: Found ID 350!
    L-->>Q: Return row pointer
    
    Note over Q,L: Only 2-3 disk reads!
```

#### B-Tree Properties

```mermaid
graph LR
    PROPS[B-Tree Properties]
    
    PROPS --> P1[🔄 Self-Balancing<br/>All leaves at same depth]
    PROPS --> P2[📊 Sorted Order<br/>Keys kept in order]
    PROPS --> P3[🌳 Multiple Children<br/>100s per node typical]
    PROPS --> P4[💾 Disk-Optimized<br/>Node = 1 disk page 8KB]
    PROPS --> P5[⚖️ Min/Max Keys<br/>m/2 to m keys per node]
    
    style PROPS fill:#e1f5ff
    style P1 fill:#90EE90
    style P2 fill:#90EE90
    style P3 fill:#90EE90
    style P4 fill:#90EE90
    style P5 fill:#90EE90
```

**Rules**:
1. All leaf nodes at same depth
2. Each node contains m/2 to m keys (m = order)
3. Node with k keys has exactly k+1 children
4. Keys within node kept in sorted order
5. Each node sized to fit one disk page (typically 8KB)

#### Real-World Examples

```sql
-- PostgreSQL automatically creates B-Tree indexes
CREATE TABLE users (
    id SERIAL PRIMARY KEY,        -- B-Tree index created
    email VARCHAR(255) UNIQUE     -- B-Tree index created
);

-- MongoDB
db.users.createIndex({ "email": 1 });  // B-Tree created
```

**Databases Using B-Trees**:
- PostgreSQL: Almost everything (primary keys, unique constraints, regular indexes)
- MySQL: InnoDB storage engine
- MongoDB: All indexes (B+ tree variant)
- SQLite: Primary index structure

#### Why B-Trees Are Default

```mermaid
flowchart TB
    WHY[Why B-Trees?]
    
    WHY --> R1[✅ Sorted Order<br/>Efficient ORDER BY]
    WHY --> R2[✅ Range Queries<br/>age > 25 AND age < 50]
    WHY --> R3[✅ Equality Searches<br/>email = 'x']
    WHY --> R4[✅ Self-Balancing<br/>Predictable performance]
    WHY --> R5[✅ Disk-Optimized<br/>Minimizes I/O]
    
    style WHY fill:#e1f5ff
    style R1 fill:#90EE90
    style R2 fill:#90EE90
    style R3 fill:#90EE90
    style R4 fill:#90EE90
    style R5 fill:#90EE90
```

✅ **Perfect For**:
- Range queries: `age BETWEEN 25 AND 50`
- Sorted results: `ORDER BY created_at DESC`
- Equality searches: `email = 'john@example.com'`
- Prefix searches: `name LIKE 'John%'`

---

### 2️⃣ LSM Trees (Log-Structured Merge Trees)

> **Write-Optimized**: Ideal for write-heavy workloads like metrics ingestion, logging systems.

#### How LSM Trees Work

```mermaid
graph TB
    subgraph "LSM Tree Architecture"
        WRITE[Write Operation]
        MEM[MemTable<br/>In-Memory<br/>Red-Black Tree]
        
        WRITE --> MEM
        
        MEM -->|Full| FLUSH[Flush to Disk]
        
        FLUSH --> L0[Level 0<br/>SSTable 1, 2, 3...]
        
        L0 -->|Compaction| L1[Level 1<br/>Merged SSTables]
        L1 -->|Compaction| L2[Level 2<br/>Merged SSTables]
        L2 -->|Compaction| L3[Level 3<br/>Merged SSTables]
    end
    
    subgraph "Read Operation"
        READ[Read Query]
        READ --> MEM
        MEM -->|Not found| L0
        L0 -->|Not found| L1
        L1 -->|Not found| L2
        L2 --> FOUND[Found!]
    end
    
    style WRITE fill:#90EE90
    style MEM fill:#e1f5ff
    style READ fill:#FFE4B5
    style FOUND fill:#90EE90
```

#### Write Path (Fast)

```mermaid
sequenceDiagram
    participant App
    participant WAL as Write-Ahead Log
    participant Mem as MemTable
    participant Disk
    
    App->>WAL: Write data
    Note over WAL: Append-only log<br/>For crash recovery
    App->>Mem: Insert into MemTable
    Note over Mem: In-memory<br/>Sorted structure
    App-->>App: ✅ Write complete
    
    Note over Mem,Disk: Background Process
    Mem->>Disk: Flush when full
    Note over Disk: Create SSTable<br/>(Sorted String Table)
```

#### Read Path (Slower)

```mermaid
sequenceDiagram
    participant Query
    participant Mem as MemTable
    participant L0 as Level 0
    participant L1 as Level 1
    participant L2 as Level 2
    
    Query->>Mem: Search key
    Mem-->>Query: Not found
    Query->>L0: Search SSTable 1
    L0-->>Query: Not found
    Query->>L0: Search SSTable 2
    L0-->>Query: Not found
    Query->>L0: Search SSTable 3
    L0-->>Query: Not found
    Query->>L1: Search merged SSTables
    L1-->>Query: Not found
    Query->>L2: Search merged SSTables
    L2-->>Query: ✅ Found!
    
    Note over Query,L2: Multiple disk reads<br/>Read amplification
```

#### Compaction Process

```mermaid
graph LR
    subgraph "Before Compaction"
        T1[SSTable 1<br/>Keys: 1,5,9]
        T2[SSTable 2<br/>Keys: 3,7,11]
        T3[SSTable 3<br/>Keys: 2,6,10]
    end
    
    COMPACT[Compaction<br/>Merge & Sort]
    
    subgraph "After Compaction"
        T4[Merged SSTable<br/>Keys: 1,2,3,5,6,7,9,10,11]
    end
    
    T1 --> COMPACT
    T2 --> COMPACT
    T3 --> COMPACT
    COMPACT --> T4
    
    style COMPACT fill:#e1f5ff
    style T4 fill:#90EE90
```

#### LSM Tree Trade-offs

| Aspect | B-Tree | LSM Tree |
|--------|---------|----------|
| **Writes** | ❌ Slower (in-place updates) | ✅ Faster (append-only) |
| **Reads** | ✅ Faster (direct lookup) | ❌ Slower (check multiple levels) |
| **Space** | ✅ Efficient | ❌ Write amplification |
| **Use Case** | Balanced workloads | Write-heavy systems |

✅ **Best For**:
- Metrics/telemetry ingestion (DataDog, Prometheus)
- Time-series data
- Event logging
- Write-heavy workloads

❌ **Avoid For**:
- Read-heavy applications
- Low-latency read requirements
- Range scans (slower than B-Tree)

**Technologies**: Cassandra, RocksDB, LevelDB, HBase

---

### 3️⃣ Hash Indexes

> **Exact Match Only**: Lightning-fast equality lookups, but can't handle ranges.

#### How Hash Indexes Work

```mermaid
graph TB
    subgraph "Hash Index Structure"
        KEY1[Key: 'user@email.com']
        KEY2[Key: 'john@example.com']
        KEY3[Key: 'jane@example.com']
        
        HASH[Hash Function<br/>MD5/SHA/etc]
        
        KEY1 --> HASH
        KEY2 --> HASH
        KEY3 --> HASH
        
        HASH --> BUCKET1[Bucket 0<br/>→ Row pointer]
        HASH --> BUCKET2[Bucket 7<br/>→ Row pointer]
        HASH --> BUCKET3[Bucket 3<br/>→ Row pointer]
    end
    
    NOTE[⚡ O 1 lookup time<br/>❌ No range queries<br/>❌ No sorting]
    
    style HASH fill:#e1f5ff
    style BUCKET1 fill:#90EE90
    style BUCKET2 fill:#90EE90
    style BUCKET3 fill:#90EE90
    style NOTE fill:#FFE4B5
```

#### Query Support

```mermaid
flowchart TB
    START[Hash Index]
    
    START --> Q1[Query: email = 'john@example.com']
    START --> Q2[Query: age > 25]
    START --> Q3[Query: name LIKE 'John%']
    START --> Q4[Query: ORDER BY created_at]
    
    Q1 --> R1[✅ Supported<br/>O 1 lookup]
    Q2 --> R2[❌ Not Supported<br/>Can't do ranges]
    Q3 --> R3[❌ Not Supported<br/>Exact match only]
    Q4 --> R4[❌ Not Supported<br/>No ordering]
    
    style Q1 fill:#90EE90
    style Q2 fill:#FFB6C1
    style Q3 fill:#FFB6C1
    style Q4 fill:#FFB6C1
    style R1 fill:#90EE90
    style R2 fill:#FFB6C1
    style R3 fill:#FFB6C1
    style R4 fill:#FFB6C1
```

#### Real-World Usage

**In-Memory Caches**:
```mermaid
graph LR
    APP[Application]
    REDIS[Redis<br/>Hash-based lookup]
    DB[Database]
    
    APP -->|1. Check cache| REDIS
    REDIS -->|Cache miss| DB
    DB -->|2. Query| DB
    DB -->|3. Return & cache| REDIS
    REDIS -->|4. Return| APP
    
    style REDIS fill:#e1f5ff
    style DB fill:#FFE4B5
```

**Session Storage**:
```
session:abc123 → Session data
user:1001 → User object
cart:xyz789 → Shopping cart
```

✅ **Use When**:
- Exact match lookups only
- In-memory data structures
- Primary key lookups
- Key-value stores

❌ **Don't Use When**:
- Need range queries
- Need sorting
- Need prefix matching

**Technologies**: Redis (primary index), Memcached, PostgreSQL (hash indexes available but rarely used)

---

### 4️⃣ Geospatial Indexes

> **Location-Based**: Optimized for queries involving geographic coordinates and proximity searches.

#### The Challenge

```mermaid
graph TB
    PROB[Find restaurants within 5km]
    
    PROB --> BAD[❌ Without Geo Index<br/>Check distance to EVERY restaurant<br/>Millions of calculations]
    
    PROB --> GOOD[✅ With Geo Index<br/>Query only nearby grid cells<br/>Few hundred candidates]
    
    style PROB fill:#e1f5ff
    style BAD fill:#FFB6C1
    style GOOD fill:#90EE90
```

Traditional indexes don't work well for 2D spatial queries:
- B-Tree on latitude doesn't help with longitude
- Distance calculations expensive: `sqrt((x2-x1)² + (y2-y1)²)`

#### Approach 1: Geohash

```mermaid
graph TB
    subgraph "Geohash Encoding"
        WORLD[World Map]
        
        WORLD --> D1[Divide vertically<br/>0=West, 1=East]
        D1 --> D2[Divide horizontally<br/>0=South, 1=North]
        D2 --> D3[Repeat recursively<br/>More precision]
        
        D3 --> GH1[Geohash: 1<br/>East hemisphere]
        D3 --> GH2[Geohash: 10<br/>East, South quadrant]
        D3 --> GH3[Geohash: 101<br/>More precise...]
    end
    
    subgraph "Nearby Search"
        LOC[Location: lat=37.7749, lon=-122.4194]
        LOC --> HASH[Geohash: 9q8yy]
        HASH --> SEARCH[Search prefix: 9q8*]
        SEARCH --> RESULTS[All nearby locations<br/>starting with 9q8]
    end
    
    style WORLD fill:#e1f5ff
    style HASH fill:#90EE90
    style RESULTS fill:#90EE90
```

**Geohash Example**:
```
San Francisco: 9q8yy
  9    → Large region
  9q   → California
  9q8  → Bay Area
  9q8y → San Francisco area
  9q8yy → Specific neighborhood
```

#### Approach 2: Quadtree

```mermaid
graph TB
    ROOT[Root<br/>Entire map]
    
    ROOT --> NW[NorthWest<br/>Quadrant]
    ROOT --> NE[NorthEast<br/>Quadrant]
    ROOT --> SW[SouthWest<br/>Quadrant]
    ROOT --> SE[SouthEast<br/>Quadrant]
    
    NW --> NW_NW[NW-NW]
    NW --> NW_NE[NW-NE]
    NW --> NW_SW[NW-SW]
    NW --> NW_SE[NW-SE]
    
    NE --> NE_NODES[...]
    SW --> SW_NODES[...]
    SE --> SE_NODES[...]
    
    NW_NW --> POINTS1[Points<br/>Restaurants here]
    
    style ROOT fill:#e1f5ff
    style NW fill:#fff4e1
    style NE fill:#fff4e1
    style SW fill:#fff4e1
    style SE fill:#fff4e1
    style POINTS1 fill:#90EE90
```

**How Quadtree Works**:
1. Divide map into 4 quadrants
2. Recursively subdivide quadrants with many points
3. Stop when quadrant has few points or max depth reached
4. Query: Only check quadrants intersecting search area

#### Approach 3: R-Tree

```mermaid
graph TB
    subgraph "R-Tree Structure"
        ROOT_R[Root Node<br/>Bounding boxes of children]
        
        ROOT_R --> BB1[Bounding Box 1<br/>Downtown area]
        ROOT_R --> BB2[Bounding Box 2<br/>Suburbs]
        ROOT_R --> BB3[Bounding Box 3<br/>Airport area]
        
        BB1 --> LEAF1[Leaf Node<br/>Restaurant A, B, C]
        BB2 --> LEAF2[Leaf Node<br/>Restaurant D, E, F]
        BB3 --> LEAF3[Leaf Node<br/>Restaurant G, H]
    end
    
    NOTE_R[Similar to B-Tree but<br/>groups by geographic proximity]
    
    style ROOT_R fill:#e1f5ff
    style BB1 fill:#fff4e1
    style BB2 fill:#fff4e1
    style BB3 fill:#fff4e1
    style LEAF1 fill:#90EE90
    style LEAF2 fill:#90EE90
    style LEAF3 fill:#90EE90
```

#### Comparison

| Approach | Best For | Trade-offs |
|----------|----------|------------|
| **Geohash** | Simple proximity searches | Edge cases at boundaries |
| **Quadtree** | Dynamic data, uneven distribution | Memory overhead |
| **R-Tree** | Complex shapes, polygons | More complex implementation |

✅ **Use Cases**:
- Find nearby restaurants/stores
- Ride-sharing driver matching
- Real estate search by location
- Delivery zone calculations

**Technologies**: 
- PostgreSQL: PostGIS extension (R-Tree)
- MongoDB: Geospatial indexes (2d, 2dsphere)
- Elasticsearch: Geo-point, geo-shape queries

---

### 5️⃣ Inverted Indexes

> **Full-Text Search**: Maps words to documents containing them, essential for search engines.

#### How Inverted Indexes Work

```mermaid
graph TB
    subgraph "Documents"
        DOC1[Doc 1: 'The quick brown fox']
        DOC2[Doc 2: 'The lazy dog sleeps']
        DOC3[Doc 3: 'Quick brown dogs run']
    end
    
    subgraph "Inverted Index"
        WORD1[the → Doc 1, Doc 2]
        WORD2[quick → Doc 1, Doc 3]
        WORD3[brown → Doc 1, Doc 3]
        WORD4[fox → Doc 1]
        WORD5[lazy → Doc 2]
        WORD6[dog/dogs → Doc 2, Doc 3]
    end
    
    DOC1 --> WORD1
    DOC1 --> WORD2
    DOC1 --> WORD3
    DOC1 --> WORD4
    
    DOC2 --> WORD1
    DOC2 --> WORD5
    DOC2 --> WORD6
    
    DOC3 --> WORD2
    DOC3 --> WORD3
    DOC3 --> WORD6
    
    style WORD1 fill:#90EE90
    style WORD2 fill:#90EE90
    style WORD3 fill:#90EE90
    style WORD4 fill:#90EE90
    style WORD5 fill:#90EE90
    style WORD6 fill:#90EE90
```

#### Search Query Example

```mermaid
sequenceDiagram
    participant User
    participant Index as Inverted Index
    participant Results
    
    User->>Index: Search "quick brown"
    Note over Index: 1. Tokenize: ["quick", "brown"]
    Index->>Index: Lookup "quick" → Doc 1, Doc 3
    Index->>Index: Lookup "brown" → Doc 1, Doc 3
    Index->>Index: Intersect results: Doc 1, Doc 3
    Index->>Results: Rank by relevance
    Results-->>User: Doc 1, Doc 3 (sorted)
```

#### Index Structure with Positions

```mermaid
graph LR
    subgraph "Term: 'database'"
        TERM[database]
        TERM --> POST1[Doc 5, positions: 1, 15, 23]
        TERM --> POST2[Doc 7, positions: 3, 9]
        TERM --> POST3[Doc 12, positions: 2]
    end
    
    subgraph "Term: 'indexing'"
        TERM2[indexing]
        TERM2 --> POST4[Doc 5, positions: 2, 16]
        TERM2 --> POST5[Doc 7, positions: 4]
        TERM2 --> POST6[Doc 9, positions: 1, 8, 14]
    end
    
    style TERM fill:#e1f5ff
    style TERM2 fill:#e1f5ff
    style POST1 fill:#90EE90
    style POST2 fill:#90EE90
    style POST3 fill:#90EE90
    style POST4 fill:#90EE90
    style POST5 fill:#90EE90
    style POST6 fill:#90EE90
```

**Positions enable**:
- Phrase searches: "database indexing" (words must be adjacent)
- Proximity searches: "database" within 5 words of "indexing"
- Highlighting matching terms in results

#### Advanced Features

```mermaid
graph TB
    FEATURES[Inverted Index Features]
    
    FEATURES --> F1[🔤 Stemming<br/>running → run<br/>databases → database]
    FEATURES --> F2[🚫 Stop Words<br/>Remove: the, a, is, of]
    FEATURES --> F3[📊 TF-IDF Scoring<br/>Term frequency ×<br/>Inverse doc frequency]
    FEATURES --> F4[🔍 Fuzzy Matching<br/>databse → database]
    FEATURES --> F5[🌍 Language Analysis<br/>Multi-language support]
    
    style FEATURES fill:#e1f5ff
    style F1 fill:#90EE90
    style F2 fill:#90EE90
    style F3 fill:#90EE90
    style F4 fill:#90EE90
    style F5 fill:#90EE90
```

✅ **Use Cases**:
- Search engines (Google, Bing)
- E-commerce product search
- Document management systems
- Log analysis and searching
- Code search

**Technologies**: 
- Elasticsearch: Built entirely on inverted indexes
- Solr: Apache Lucene-based search
- PostgreSQL: Full-text search with GIN indexes
- MongoDB: Text indexes

---

## 🎯 Index Optimization Patterns

### Composite Indexes

```mermaid
graph TB
    subgraph "Single-Column Indexes"
        I1[Index on user_id]
        I2[Index on created_at]
        
        QUERY1[Query: WHERE user_id = 123<br/>AND created_at > '2024-01-01']
        
        QUERY1 --> CHOICE[Database picks ONE index<br/>Other condition filtered after]
    end
    
    subgraph "Composite Index"
        CI[Index on user_id, created_at]
        
        QUERY2[Query: WHERE user_id = 123<br/>AND created_at > '2024-01-01']
        
        QUERY2 --> FAST[✅ Both conditions use index<br/>Much faster!]
    end
    
    style I1 fill:#FFE4B5
    style I2 fill:#FFE4B5
    style CI fill:#90EE90
    style FAST fill:#90EE90
```

#### Column Order Matters

```mermaid
flowchart TB
    IDX1[Index: user_id, created_at]
    IDX2[Index: created_at, user_id]
    
    Q1[WHERE user_id = 123<br/>AND created_at > '2024-01-01']
    Q2[WHERE user_id = 123]
    Q3[WHERE created_at > '2024-01-01']
    
    IDX1 --> R1[✅ Uses full index]
    IDX1 --> R2[✅ Uses user_id part]
    IDX1 --> R3[❌ Can't use index]
    
    IDX2 --> R4[✅ Uses full index]
    IDX2 --> R5[❌ Can't use index]
    IDX2 --> R6[✅ Uses created_at part]
    
    Q1 --> IDX1
    Q2 --> IDX1
    Q3 --> IDX1
    
    Q1 --> IDX2
    Q2 --> IDX2
    Q3 --> IDX2
    
    style R1 fill:#90EE90
    style R2 fill:#90EE90
    style R3 fill:#FFB6C1
    style R4 fill:#90EE90
    style R5 fill:#FFB6C1
    style R6 fill:#90EE90
```

**Rule**: Composite index `(A, B, C)` can be used for queries on:
- ✅ `A`
- ✅ `A, B`
- ✅ `A, B, C`
- ❌ `B`
- ❌ `C`
- ❌ `B, C`

**Best Practice**: Most selective columns first (columns with highest cardinality)

---

### Covering Indexes

> **Zero Disk Reads**: Index contains ALL columns needed by query, no need to access table.

```mermaid
sequenceDiagram
    participant Query
    participant Index as Index user_id, email, name
    participant Table
    
    Note over Query: SELECT email, name<br/>WHERE user_id = 123
    
    Query->>Index: Search for user_id = 123
    Index->>Index: Found! email & name in index
    Index-->>Query: Return email, name
    
    Note over Query,Table: ✅ Never touched table!<br/>Called "index-only scan"
```

**Regular Index**:
```sql
CREATE INDEX idx_user ON users(user_id);

SELECT email, name FROM users WHERE user_id = 123;
-- 1. Search index for user_id = 123
-- 2. Get row pointer
-- 3. Fetch full row from table (disk read)
```

**Covering Index**:
```sql
CREATE INDEX idx_user_covering ON users(user_id, email, name);

SELECT email, name FROM users WHERE user_id = 123;
-- 1. Search index for user_id = 123
-- 2. All needed columns in index!
-- 3. No table access needed ✅
```

```mermaid
graph LR
    subgraph "Performance Comparison"
        REG[Regular Index<br/>2 disk reads]
        COV[Covering Index<br/>1 disk read]
    end
    
    REG -->|Slower| RESULT[Query Result]
    COV -->|Faster| RESULT
    
    style REG fill:#FFE4B5
    style COV fill:#90EE90
```

✅ **Use When**:
- Query frequently accesses same columns
- Read-heavy workloads
- Can afford extra storage

⚠️ **Trade-off**:
- Larger index size
- Slower writes (more data to update)

---

## ✅ Best Practices

### Index Selection Strategy

```mermaid
flowchart TB
    START[Need an Index?]
    
    START --> Q1{Query<br/>frequency?}
    Q1 -->|Rare| SKIP[❌ Skip Index]
    Q1 -->|Frequent| Q2{Query<br/>type?}
    
    Q2 -->|Exact match| Q3{Data<br/>type?}
    Q2 -->|Range/Sort| BTREE[✅ B-Tree]
    Q2 -->|Full-text| INVERTED[✅ Inverted Index]
    Q2 -->|Location| GEO[✅ Geospatial]
    
    Q3 -->|Small dataset| HASH[✅ Hash Index]
    Q3 -->|Large dataset| BTREE2[✅ B-Tree]
    
    style START fill:#e1f5ff
    style SKIP fill:#FFB6C1
    style BTREE fill:#90EE90
    style BTREE2 fill:#90EE90
    style INVERTED fill:#90EE90
    style GEO fill:#90EE90
    style HASH fill:#90EE90
```

### Interview Checklist

```mermaid
mindmap
    root((Index Design))
        Identify Access Patterns
            API endpoints
            Query frequency
            Read vs write ratio
        Choose Index Type
            Default: B-Tree
            Write-heavy: LSM
            Exact match: Hash
            Full-text: Inverted
            Location: Geospatial
        Optimize
            Composite indexes
            Column order
            Covering indexes
        Monitor
            Query performance
            Index usage stats
            Remove unused indexes
```

### Common Mistakes

```mermaid
graph TB
    MISTAKES[❌ Common Mistakes]
    
    MISTAKES --> M1[Too Many Indexes<br/>Kills write performance]
    MISTAKES --> M2[Wrong Column Order<br/>In composite indexes]
    MISTAKES --> M3[Indexing Low Cardinality<br/>gender, boolean fields]
    MISTAKES --> M4[Forgetting Covering Indexes<br/>For frequent queries]
    MISTAKES --> M5[Not Monitoring Usage<br/>Unused indexes waste space]
    
    style MISTAKES fill:#FFB6C1
    style M1 fill:#FFE4B5
    style M2 fill:#FFE4B5
    style M3 fill:#FFE4B5
    style M4 fill:#FFE4B5
    style M5 fill:#FFE4B5
```

### Decision Matrix

| Use Case | Index Type | Reasoning |
|----------|------------|-----------|
| User lookup by email | B-Tree | Equality + sorting support |
| Feed timeline (recent posts) | B-Tree composite | Range query on timestamp |
| Session management | Hash | Exact match lookups |
| Metrics ingestion | LSM Tree | Write-heavy workload |
| Restaurant finder | Geospatial | Location-based queries |
| Product search | Inverted | Full-text search |
| Analytics (write-once) | Columnstore/LSM | Append-only workload |

---

## 🎓 Key Takeaways

### The Essentials

```mermaid
graph TB
    CORE[Database Indexing Essentials]
    
    CORE --> K1[🎯 Purpose<br/>Fast lookups without scanning<br/>every row]
    
    CORE --> K2[🌳 B-Tree Default<br/>Works for 90% of cases<br/>Range + equality + sorting]
    
    CORE --> K3[⚖️ Trade-offs<br/>Faster reads<br/>Slower writes + more space]
    
    CORE --> K4[🔧 Optimization<br/>Composite indexes<br/>Covering indexes<br/>Match access patterns]
    
    style CORE fill:#e1f5ff
    style K1 fill:#90EE90
    style K2 fill:#90EE90
    style K3 fill:#FFE4B5
    style K4 fill:#90EE90
```

### Interview Strategy

**When Discussing Indexes**:
1. ✅ Start with access patterns from API design
2. ✅ Default to B-Tree unless special requirements
3. ✅ Mention composite indexes for multi-column queries
4. ✅ Consider covering indexes for hot queries
5. ✅ Acknowledge write trade-offs
6. ✅ Tie back to functional requirements

**Example Script**:
> "For the feed timeline query, I'll create a composite B-Tree index on `(user_id, created_at)`. This supports both filtering by user and sorting by time. For frequently accessed posts, we could use a covering index that includes `content` and `like_count` to avoid table lookups entirely."

---

## 🏭 Production Indexing Tricks

### Partial Indexes — Index Only What You Query

A partial index is smaller, faster, and cheaper than a full-column index when your queries target a subset:

```sql
-- ❌ Full index: indexes ALL orders (millions of rows)
CREATE INDEX idx_orders_status ON orders(status);

-- ✅ Partial index: only indexes pending orders (thousands of rows)
-- Queries like "WHERE status = 'pending'" use this tiny index
CREATE INDEX idx_orders_pending ON orders(user_id)
WHERE status = 'pending';

-- ✅ Partial index for soft-deleted records
CREATE INDEX idx_users_active ON users(email)
WHERE deleted_at IS NULL;
-- Result: 10x smaller, 10x faster for active user lookups
```

**Real example**: Shopify's order processing indexes only `status = 'processing'` orders since completed orders represent 99% of rows but are rarely queried.

---

### Functional (Expression) Indexes

Index the result of a function, not the raw column:

```sql
-- ❌ This won't use an index on email
SELECT * FROM users WHERE LOWER(email) = 'alice@example.com';

-- ✅ Create a functional index on the expression
CREATE INDEX idx_users_email_lower ON users(LOWER(email));

-- Now this query uses the index
SELECT * FROM users WHERE LOWER(email) = 'alice@example.com';

-- ✅ Index on date truncation for date-range queries
CREATE INDEX idx_events_day ON events(DATE_TRUNC('day', created_at));

-- ✅ Index on JSON field (PostgreSQL)
CREATE INDEX idx_orders_metadata_type
ON orders ((metadata->>'order_type'));
```

---

### CONCURRENTLY — Build Indexes Without Downtime

```sql
-- ❌ Blocks all writes while building (minutes on large tables!)
CREATE INDEX idx_orders_user ON orders(user_id);

-- ✅ Build in background — table stays fully writable
CREATE INDEX CONCURRENTLY idx_orders_user ON orders(user_id);
-- Takes longer, but zero downtime
```

**Important caveats**:
- Can't run inside a transaction
- Leaves an invalid index if it fails (must `DROP INDEX` and retry)
- Use `pg_stat_progress_create_index` to monitor progress

```sql
-- Monitor index build progress (PostgreSQL 12+)
SELECT phase, blocks_done, blocks_total,
       ROUND(100.0 * blocks_done / blocks_total, 1) AS pct_done
FROM pg_stat_progress_create_index;
```

---

### Covering Indexes with INCLUDE (PostgreSQL 11+)

Avoid heap fetches by including all needed columns in the index leaf:

```sql
-- Standard index — needs heap fetch for email + name
CREATE INDEX idx_users_id ON users(id);

-- SELECT email, name needs to fetch table row after finding id in index

-- Covering index — all columns available in the index itself
CREATE INDEX idx_users_id_covering ON users(id) INCLUDE (email, name);

-- SELECT email, name FROM users WHERE id = 123
-- → Index-only scan: NEVER touches the table heap!
```

**When to use**: Hot read paths where the same few columns are always fetched together. The tradeoff is larger index size and slower writes.

---

### Find and Kill Unused Indexes

Every index slows down writes. Remove indexes nobody uses:

```sql
-- Find unused indexes (reset stats after each deployment)
SELECT
    schemaname,
    tablename,
    indexname,
    idx_scan AS times_used,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- Bloated indexes (fragmentation from many updates/deletes)
SELECT
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan < 100   -- Rarely used
ORDER BY pg_relation_size(indexrelid) DESC;
```

**Production practice**: Run this monthly. Teams at GitHub and GitLab have found 30-40% of their indexes were unused, removing them improved write throughput by 15-20%.

---

### EXPLAIN ANALYZE — Debug Slow Queries

```sql
-- See what the query planner actually does
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders WHERE user_id = 123 AND status = 'pending';

-- Key things to look for:
-- "Seq Scan" → missing index
-- "Index Scan" → good, using index
-- "Index Only Scan" → best, no heap fetch needed
-- "Bitmap Heap Scan" → acceptable for range queries
-- rows=XXX (actual) vs rows=YYY (estimated) → stale stats if far off
-- Buffers: shared hit=X read=Y → high read means cold cache

-- Fix stale statistics causing bad query plans
ANALYZE orders;
-- Or full vacuum + analyze
VACUUM ANALYZE orders;
```

---

### Index Fill Factor for Write-Heavy Tables

PostgreSQL reserves space on each B-tree page for future updates. Reducing fill factor avoids costly page splits:

```sql
-- Default fill factor = 100% (no room for updates)
-- Every update on an indexed column may cause a page split

-- For frequently-updated tables, use 70-80% fill factor
CREATE INDEX idx_orders_status ON orders(status)
WITH (fillfactor = 70);

-- Reduces page splits by leaving 30% free for in-place updates
-- Slightly larger index, but faster writes on hot rows
```

**Use when**: The indexed column is updated frequently (e.g., status columns that change from `pending` → `processing` → `complete`).

---

### Write Amplification — Indexes Have Real Cost

Every index on a table multiplies write cost:

```mermaid
graph TB
    WRITE[One INSERT into orders]

    WRITE --> T1[Write to table heap: 1 I/O]
    WRITE --> I1[Update index: user_id: 1 I/O]
    WRITE --> I2[Update index: status: 1 I/O]
    WRITE --> I3[Update index: created_at: 1 I/O]
    WRITE --> I4[Update index: email: 1 I/O]
    WRITE --> WAL["Write WAL (transaction log): 1 I/O"]

    TOTAL[Total: 6 I/Os for 1 logical write]

    style WRITE fill:#e1f5ff
    style TOTAL fill:#FFB6C1
```

**Production rule**: Don't index columns you don't query. A write-heavy table with 10 indexes can be 5x slower than the same table with 2 indexes.

**Monitoring**: Watch `pg_stat_user_tables.n_tup_upd` (updates/sec) vs index count to identify over-indexed hot tables.

---

### Real-World Indexing Failures

**GitHub (2014)**: A missing index on `pull_requests.head_sha` caused a 30-minute outage. Every PR status check triggered a full table scan on 50M rows.

**Shopify**: Periodic "why is checkout slow?" incidents traced to missing composite indexes. The fix: `(shop_id, status, created_at)` composite index dropped checkout query time from 500ms to 3ms.

**Common pattern**: Systems work fine at 1M rows, break at 10M rows when indexes weren't designed for scale.

---

## 📚 Related Concepts

- [Data Modeling](./DataModelling.md) - Schema design and relationships
- [Database Sharding](./Sharding.md) - Horizontal partitioning strategies
- [Caching](./Caching.md) - Reduce database load
- [PostgreSQL](./PostgreSQL.md) - B-Tree implementation details
- [Query Optimization](./QueryOptimization.md) - Using indexes effectively

---

**Last Updated**: December 2024
**Source**: [HelloInterview - Database Indexing](https://www.hellointerview.com/learn/system-design/core-concepts/db-indexing)

> **💡 Remember**: In interviews, if unsure which index to use, B-Tree is always a safe choice. Focus on identifying access patterns from your API design, then match the right index type to those patterns.
