# Networking Essentials

> **Practical networking concepts for system design interviews**  
> *Understanding how services communicate in distributed systems*

---

## Table of Contents

1. [Introduction](#introduction)
2. [Communication Protocols](#communication-protocols)
3. [Real-time Communication](#real-time-communication)
4. [Load Balancing](#load-balancing)
5. [Geography and Latency](#geography-and-latency)
6. [Network Layers](#network-layers)
7. [Best Practices](#best-practices)

---

## Introduction

Networking is one of those topics where you can go incredibly deep, but for system design interviews you need to know the **practical bits** that come up when you're designing distributed systems.

At a basic level, you need to understand:
- How services talk to each other
- What happens when those connections fail or get slow
- Which protocol to choose for different scenarios
- How to handle real-time communication requirements

> 💡 **Interview Focus**: The most important decision you'll make is choosing your communication protocol. For most systems, you'll default to HTTP over TCP. It's well-understood, works everywhere, and handles 90% of use cases.

---

## Communication Protocols

For most systems, you'll default to **HTTP over TCP**. It's well-understood, works everywhere, and handles 90% of use cases.

```mermaid
graph TB
    subgraph "Communication Protocols"
        HTTP[HTTP/TCP<br/>Default Choice<br/>90% of use cases]
        WS[WebSockets<br/>Bidirectional<br/>Real-time]
        SSE[Server-Sent Events<br/>Server → Client<br/>Simpler than WS]
        gRPC[gRPC<br/>Internal Services<br/>High Performance]
    end
    
    HTTP -->|When to use| UC1[REST APIs<br/>Standard CRUD<br/>Stateless operations]
    WS -->|When to use| UC2[Chat apps<br/>Live collaboration<br/>Gaming]
    SSE -->|When to use| UC3[Live scores<br/>Notifications<br/>One-way updates]
    gRPC -->|When to use| UC4[Microservices<br/>Internal APIs<br/>Performance critical]
    
    style HTTP fill:#e8f5e9
    style WS fill:#e1f5ff
    style SSE fill:#fff4e1
    style gRPC fill:#f3e5f5
```

### Protocol Comparison

| Protocol | Use Case | Advantages | Disadvantages |
|----------|----------|------------|---------------|
| **HTTP/TCP** | REST APIs, CRUD operations | Well-understood, universal support, stateless | Higher latency for real-time |
| **WebSockets** | Chat, gaming, live collaboration | Bidirectional, low latency, persistent | Complex at scale, stateful |
| **SSE** | Live scores, notifications, feeds | Simpler than WebSockets, auto-reconnect | One-way only (server→client) |
| **gRPC** | Internal microservices | Binary protocol, fast, streaming support | Limited browser support |

### HTTP/TCP (Default)

```mermaid
sequenceDiagram
    participant C as Client
    participant LB as Load Balancer
    participant S as Server
    participant DB as Database
    
    C->>LB: HTTP Request (GET /users/123)
    LB->>S: Forward request
    S->>DB: Query user data
    DB-->>S: Return data
    S-->>LB: HTTP Response (200 OK + JSON)
    LB-->>C: Forward response
    
    Note over C,S: Stateless - each request independent
```

**When to use:**
- REST APIs
- Standard CRUD operations
- Stateless services
- Most web applications

**Key characteristics:**
- Request-response model
- Stateless by default
- Easy to scale horizontally
- Well-supported by all infrastructure

---

## Real-time Communication

### WebSockets vs Server-Sent Events

**WebSockets:**
- **Bidirectional** communication where both sides send messages
- Use cases: chat apps, live collaboration, gaming
- More complex to implement and scale

**Server-Sent Events (SSE):**
- **Server-to-client push only**
- Use cases: live scores, notifications, one-way updates
- Simpler than WebSockets, better with standard HTTP infrastructure

> ⚠️ **Common Mistake**: Proposing WebSockets when HTTP with long polling or Server-Sent Events would work fine. WebSockets add significant complexity for maintaining stateful connections at scale. Only reach for them when you genuinely need bidirectional real-time communication.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    
    rect rgb(225, 245, 255)
    Note over C,S: WebSocket - Bidirectional
    C->>S: Upgrade to WebSocket
    S->>C: Connection Established
    C->>S: Message 1
    S->>C: Message 2
    C->>S: Message 3
    S->>C: Message 4
    Note over C,S: Both can send anytime
    end
    
    rect rgb(255, 244, 225)
    Note over C,S: SSE - Server to Client Only
    C->>S: Request SSE Connection
    S->>C: Event 1
    S->>C: Event 2
    S->>C: Event 3
    Note over C: Client only receives
    end
```

### WebSocket Connection Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Connecting: HTTP Upgrade Request
    Connecting --> Open: Handshake Success
    Connecting --> Failed: Handshake Failed
    Open --> Closing: Close Frame Sent
    Open --> Error: Connection Error
    Closing --> Closed: Close Acknowledged
    Error --> Closed: Cleanup
    Closed --> [*]
    Failed --> [*]
    
    Open --> Open: Send/Receive Messages
```

### Scaling Real-time Connections

```mermaid
graph TB
    subgraph "Clients"
        C1[Client 1]
        C2[Client 2]
        C3[Client 3]
        C4[Client 4]
    end
    
    subgraph "Load Balancer Layer"
        LB[L4 Load Balancer<br/>Sticky Sessions]
    end
    
    subgraph "WebSocket Servers"
        WS1[WS Server 1<br/>1M connections]
        WS2[WS Server 2<br/>1M connections]
    end
    
    subgraph "Message Bus"
        PS[Pub/Sub<br/>Redis/Kafka]
    end
    
    C1 & C2 --> LB
    C3 & C4 --> LB
    
    LB -->|Sticky| WS1
    LB -->|Sticky| WS2
    
    WS1 <--> PS
    WS2 <--> PS
    
    style LB fill:#e1f5ff
    style WS1 fill:#e8f5e9
    style WS2 fill:#e8f5e9
    style PS fill:#fff4e1
```

**Key Challenges with WebSockets:**
- **Stateful connections**: Can't just throw them behind a standard load balancer
- **Connection persistence**: Need sticky sessions or session affinity
- **Server failures**: What happens when a server goes down with thousands of active connections?
- **Scaling**: Limited by concurrent connections per server

---

## Load Balancing

Load balancing is another area interviewers love to probe. Understanding the difference between Layer 4 and Layer 7 load balancers is crucial.

```mermaid
graph TB
    subgraph "Load Balancer Types"
        L7[Layer 7<br/>Application Level<br/>HTTP Content-aware]
        L4[Layer 4<br/>Transport Level<br/>TCP/UDP]
    end
    
    subgraph "Use Cases"
        L7 -->|Route based on| R1[URL Path<br/>HTTP Headers<br/>Request Content<br/>Cookies]
        L4 -->|Route based on| R2[IP Address<br/>Port Number<br/>Connection Hash]
    end
    
    subgraph "Best For"
        L7 -.-> B1[REST APIs<br/>Microservices<br/>Content Routing<br/>SSL Termination]
        L4 -.-> B2[WebSockets<br/>Persistent Connections<br/>Raw Speed<br/>Any TCP/UDP]
    end
    
    style L7 fill:#e1f5ff
    style L4 fill:#fff4e1
```

### Layer 7 (Application Load Balancer)

**Operates at:** HTTP/HTTPS level

**Routing capabilities:**
- URL path-based routing (`/api/*` → API servers, `/web/*` → Web servers)
- Header-based routing (mobile vs desktop)
- Host-based routing (different domains to different services)
- Content-based routing (analyze request body)

**Features:**
- SSL/TLS termination
- Cookie-based session affinity
- Request/response modification
- Advanced health checks

```mermaid
graph LR
    C[Client] -->|HTTPS Request| L7[Layer 7 LB]
    
    L7 -->|/api/*| API[API Servers]
    L7 -->|/web/*| WEB[Web Servers]
    L7 -->|/admin/*| ADMIN[Admin Servers]
    
    style L7 fill:#e1f5ff
```

### Layer 4 (Network Load Balancer)

**Operates at:** TCP/UDP level

**Routing capabilities:**
- IP address and port
- Connection hash (source IP + port)
- Simple round-robin or least connections

**Features:**
- Extremely fast (no packet inspection)
- Lower latency
- Handles any TCP/UDP protocol
- Better for persistent connections

```mermaid
graph LR
    C[Client] -->|TCP Connection| L4[Layer 4 LB]
    
    L4 -->|Hash-based| S1[Server 1]
    L4 -->|Distribution| S2[Server 2]
    L4 -->|Maintains| S3[Server 3]
    
    style L4 fill:#fff4e1
```

### Comparison Table

| Feature | Layer 7 | Layer 4 |
|---------|---------|---------|
| **Speed** | Slower (inspects content) | Faster (no inspection) |
| **Flexibility** | High (content-aware) | Low (connection-based) |
| **Use Case** | HTTP/HTTPS APIs | WebSockets, TCP/UDP |
| **SSL Termination** | Yes | No (pass-through) |
| **Sticky Sessions** | Cookie-based | IP-based |
| **Protocol Support** | HTTP/HTTPS only | Any TCP/UDP |

> 💡 **Interview Tip**: For WebSockets, you typically need Layer 4 balancing because you're maintaining a persistent TCP connection. For standard REST APIs, Layer 7 gives you more flexibility.

---

## Geography and Latency

Geography and latency matter more than most candidates realize. A request from New York to London has a **minimum latency of around 80ms** just from the speed of light through fiber optic cables, before you even process anything.

```mermaid
graph TB
    subgraph "Latency Considerations"
        NY[New York User]
        L[London User]
        T[Tokyo User]
    end
    
    subgraph "US Region"
        US_DC[US Data Center]
        US_CDN[US CDN Edge]
    end
    
    subgraph "EU Region"
        EU_DC[EU Data Center]
        EU_CDN[EU CDN Edge]
    end
    
    subgraph "APAC Region"
        APAC_DC[APAC Data Center]
        APAC_CDN[APAC CDN Edge]
    end
    
    NY -->|~5ms| US_CDN
    NY -->|~20ms| US_DC
    NY -.->|~80ms| EU_DC
    
    L -->|~5ms| EU_CDN
    L -->|~20ms| EU_DC
    L -.->|~80ms| US_DC
    
    T -->|~5ms| APAC_CDN
    T -->|~20ms| APAC_DC
    T -.->|~150ms| US_DC
    
    style US_CDN fill:#e8f5e9
    style EU_CDN fill:#e8f5e9
    style APAC_CDN fill:#e8f5e9
```

### Geographic Latency Facts

| Route | Minimum Latency | Notes |
|-------|----------------|-------|
| **Same City** | 1-5ms | LAN speeds |
| **Same Region** | 5-20ms | Within data center or nearby |
| **Cross-Country (US)** | 40-60ms | NY to SF |
| **Transatlantic** | 80-100ms | NY to London |
| **Transpacific** | 100-150ms | US to Tokyo |
| **Round the World** | 150-200ms | Physical speed of light limit |

### Solutions for Global Low Latency

```mermaid
graph TB
    Start([Global User Base])
    
    Start --> Q1{Content Type?}
    
    Q1 -->|Static Assets| CDN[CDN Distribution<br/>Images, CSS, JS<br/>Cached at Edge]
    Q1 -->|Dynamic Data| Q2{Latency SLA?}
    
    Q2 -->|< 50ms| MULTI[Multi-Region Deployment<br/>Data Replication<br/>Regional Routing]
    Q2 -->|< 200ms| SINGLE[Single Region<br/>+ CDN for static<br/>Acceptable for many apps]
    
    CDN --> SOL1[✓ Cloudflare<br/>✓ AWS CloudFront<br/>✓ Akamai]
    MULTI --> SOL2[✓ Regional databases<br/>✓ Data partitioning<br/>✓ Geo-routing]
    SINGLE --> SOL3[✓ Simpler architecture<br/>✓ Lower cost<br/>✓ Works for many cases]
    
    style CDN fill:#e8f5e9
    style MULTI fill:#e1f5ff
    style SINGLE fill:#fff4e1
```

### Regional Architecture Example

```mermaid
graph TB
    subgraph "US Region"
        US_USER[US Users]
        US_LB[Load Balancer]
        US_APP[App Servers]
        US_DB[(Database<br/>Primary)]
    end
    
    subgraph "EU Region"
        EU_USER[EU Users]
        EU_LB[Load Balancer]
        EU_APP[App Servers]
        EU_DB[(Database<br/>Replica)]
    end
    
    subgraph "APAC Region"
        AP_USER[APAC Users]
        AP_LB[Load Balancer]
        AP_APP[App Servers]
        AP_DB[(Database<br/>Replica)]
    end
    
    US_USER --> US_LB --> US_APP --> US_DB
    EU_USER --> EU_LB --> EU_APP --> EU_DB
    AP_USER --> AP_LB --> AP_APP --> AP_DB
    
    US_DB -.->|Replication| EU_DB
    US_DB -.->|Replication| AP_DB
    
    style US_DB fill:#e8f5e9
    style EU_DB fill:#e1f5ff
    style AP_DB fill:#fff4e1
```

**Solution**: If your system needs low latency globally, you'll need regional deployments with data replicated or partitioned by geography. This is why CDNs exist - to serve static content from edge servers close to users.

---

## Network Layers

Understanding the OSI and TCP/IP models helps contextualize where different technologies operate.

```mermaid
graph TB
    subgraph "OSI Model"
        L7_OSI[Layer 7: Application<br/>HTTP, WebSocket, gRPC]
        L6_OSI[Layer 6: Presentation<br/>SSL/TLS, Encryption]
        L5_OSI[Layer 5: Session<br/>Session Management]
        L4_OSI[Layer 4: Transport<br/>TCP, UDP]
        L3_OSI[Layer 3: Network<br/>IP, Routing]
        L2_OSI[Layer 2: Data Link<br/>Ethernet, MAC]
        L1_OSI[Layer 1: Physical<br/>Cables, Signals]
    end
    
    subgraph "What You Need to Know"
        APP[Application Layer<br/>Your APIs and protocols]
        TRANS[Transport Layer<br/>TCP vs UDP<br/>Load balancing]
        NET[Network Layer<br/>IP addressing<br/>Routing decisions]
    end
    
    L7_OSI -.-> APP
    L4_OSI -.-> TRANS
    L3_OSI -.-> NET
    
    style APP fill:#e8f5e9
    style TRANS fill:#e1f5ff
    style NET fill:#fff4e1
```

### TCP vs UDP

```mermaid
graph LR
    subgraph "TCP (Transmission Control Protocol)"
        TCP1[Reliable delivery<br/>Guaranteed order]
        TCP2[Connection-oriented<br/>3-way handshake]
        TCP3[Error checking<br/>Retransmission]
        TCP4[Flow control<br/>Congestion control]
    end
    
    subgraph "UDP (User Datagram Protocol)"
        UDP1[No delivery guarantee<br/>Fire and forget]
        UDP2[Connectionless<br/>No handshake]
        UDP3[No error recovery<br/>Fast]
        UDP4[No flow control<br/>Low overhead]
    end
    
    TCP1 & TCP2 & TCP3 -->|Use for| TCPU[HTTP/HTTPS<br/>WebSockets<br/>Database connections<br/>File transfers]
    
    UDP1 & UDP2 & UDP3 -->|Use for| UDPU[Video streaming<br/>Gaming<br/>DNS queries<br/>VoIP]
    
    style TCP1 fill:#e1f5ff
    style TCP2 fill:#e1f5ff
    style TCP3 fill:#e1f5ff
    style UDP1 fill:#fff4e1
    style UDP2 fill:#fff4e1
    style UDP3 fill:#fff4e1
```

---

## Best Practices

### Decision Framework

```mermaid
flowchart TD
    Start([Choose Communication Protocol])
    
    Start --> Q1{Real-time<br/>bidirectional?}
    
    Q1 -->|Yes| Q2{Both sides<br/>send messages?}
    Q1 -->|No| REST[HTTP/REST<br/>Standard choice]
    
    Q2 -->|Yes| WS[WebSockets<br/>Chat, Gaming]
    Q2 -->|No| SSE[Server-Sent Events<br/>Notifications, Feeds]
    
    REST --> Q3{Internal service<br/>communication?}
    Q3 -->|Yes, performance critical| GRPC[gRPC<br/>Binary protocol]
    Q3 -->|No| FINAL_REST[REST APIs<br/>JSON over HTTP]
    
    style FINAL_REST fill:#e8f5e9
    style WS fill:#e1f5ff
    style SSE fill:#fff4e1
    style GRPC fill:#f3e5f5
```

### Common Patterns

#### 1. Public API Pattern
```
Clients (Mobile/Web) → CDN → Layer 7 LB → API Servers → Database
```

#### 2. Real-time Chat Pattern
```
Clients → Layer 4 LB → WebSocket Servers → Pub/Sub (Redis/Kafka) → Database
```

#### 3. Microservices Pattern
```
Public: REST (Layer 7 LB) → API Gateway
Internal: gRPC → Service Mesh → Microservices
```

### Interview Tips

```mermaid
mindmap
  root((Networking<br/>Interview Tips))
    Default to HTTP/TCP
      REST for 90% cases
      Well understood
      Easy to scale
    Real-time?
      SSE for one-way
      WebSockets for bidirectional
      Justify complexity
    Load Balancing
      L7 for HTTP
      L4 for WebSockets
      Know trade-offs
    Geography
      Mention latency
      CDN for static
      Regional deployment
    Don't Over-engineer
      Start simple
      Add complexity when needed
      Justify decisions
```

### Key Takeaways

1. **Default to HTTP/TCP**: It handles 90% of use cases and is well-understood
2. **WebSockets = Complexity**: Only use when you need bidirectional real-time communication
3. **SSE is Simpler**: For one-way server push, SSE is easier than WebSockets
4. **Layer 4 vs Layer 7**: Know when to use each (WebSockets = L4, REST APIs = L7)
5. **Geography Matters**: 80ms NY→London is unavoidable physics
6. **gRPC for Internal**: High-performance binary protocol for microservices
7. **CDN for Static**: Always mention CDN for images, CSS, JS
8. **Stateful = Hard**: WebSocket connections are stateful and harder to scale

---

## Summary

```mermaid
graph TB
    subgraph "Protocol Selection"
        P1[HTTP/TCP<br/>Default]
        P2[WebSockets<br/>Bidirectional RT]
        P3[SSE<br/>Server Push]
        P4[gRPC<br/>Internal]
    end
    
    subgraph "Load Balancing"
        L1[Layer 7<br/>HTTP Aware]
        L2[Layer 4<br/>TCP/UDP]
    end
    
    subgraph "Geographic Distribution"
        G1[CDN<br/>Static Assets]
        G2[Multi-Region<br/>Low Latency]
        G3[Single Region<br/>+ CDN]
    end
    
    P1 --> L1
    P2 --> L2
    P3 --> L1
    P4 --> L2
    
    L1 & L2 --> G1 & G2 & G3
    
    style P1 fill:#e8f5e9
    style P2 fill:#e1f5ff
    style P3 fill:#fff4e1
    style P4 fill:#f3e5f5
```

**Remember**: Networking in system design interviews is about making practical choices that you can justify. Start with the simple, well-understood options (HTTP/TCP, REST) and only add complexity (WebSockets, multi-region) when you have a clear reason backed by requirements.

---

## Additional Resources

- [Real-time Updates Pattern](https://www.hellointerview.com/learn/system-design/patterns/realtime-updates)
- [Networking Essentials Deep Dive](https://www.hellointerview.com/learn/system-design/core-concepts/networking-essentials)
- [Load Balancing Strategies](https://www.hellointerview.com/learn/system-design/deep-dives/load-balancing)

---

*Extracted from: System Design Core Concepts - HelloInterview*
