# Disjoint Set Union

## At a Glance

Disjoint Set Union (DSU), also called Union-Find, maintains a partition of elements into
connected components while connections are added.

| Signal in the prompt | DSU operation |
|---|---|
| Are two items connected? | Compare representatives with `find` |
| Merge groups over time | `unite` their representatives |
| Adding an edge creates a cycle | Endpoints already share a representative |
| Minimum spanning tree with sorted edges | Kruskal plus successful unions |

**Core invariant:** two elements are in the same component if and only if `find` returns
the same representative for both.

With path compression and union by size or rank, a sequence of operations takes
O(alpha(n)) amortized time per operation, effectively constant for practical inputs.
Storage is O(n).

## Interview Method

1. **Clarify update direction.** DSU handles edge additions well, but arbitrary edge
   deletion requires a different or offline technique.
2. **State the traversal baseline.** DFS or BFS can answer one connectivity query, but
   repeating traversal after many unions is wasteful.
3. **Identify component identity.** If the problem needs only whether items belong to the
   same group, full paths are unnecessary.
4. **Define the representative invariant.** Every parent chain ends at a root whose
   parent is itself.
5. **Choose both optimizations.** Path compression flattens searches; union by size keeps
   trees shallow before compression.
6. **Use the return value of union.** `false` means the edge was redundant and often
   signals a cycle.
7. **Test duplicate and self edges.** They should not change component count or size.
8. **Separate DSU cost from surrounding work.** Kruskal is dominated by sorting, not by
   Union-Find operations.

## How It Works

Initially, each element is a one-node tree and its own representative. `unite(a, b)`
finds both roots and attaches the smaller tree beneath the larger. `find(x)` recursively
rewrites every visited parent to point directly to the root.

```mermaid
flowchart LR
    A["a"] --> RA["root A"]
    B["b"] --> RB["root B"]
    RA -->|"attach smaller root"| RB
    A2["later find a"] --> RB
```

Path compression changes the tree shape but not component membership. Union by size
changes which valid representative is selected but not which elements are grouped.

## Reusable C++ Template

The original notebook did not contain a standalone generic template. Its preserved
worked snippets below each define the DSU state they need.

## Worked Problems

### Minimum Cost to Connect All Points

**Problem:** Connect all points with minimum total Manhattan edge cost.

**Recognition:** All pairs define a weighted undirected graph, and the desired connected
subgraph with minimum total weight is a minimum spanning tree. Kruskal's algorithm sorts
edges and uses DSU to reject cycle-forming edges.

**Invariant:** after processing an edge prefix, the selected edges form a minimum-weight
forest that can be extended to a minimum spanning tree. A successful union connects two
different trees; a failed union would create a cycle.

The original notebook snippets are preserved verbatim:

```cpp legacy
// https://leetcode.com/problems/min-cost-to-connect-all-points

class Node {
    public: 
        int x;
        int y;
        int cost;
        Node(int x1, int y1, int cost1) {
            x = x1;
            y = y1;
            cost = cost1;
        }
};

class DSU {
    public:
        vector<int> parent;
        DSU(int sz) {
            parent.resize(sz, 0);
            for(int i = 0; i < sz; i++) 
                parent[i] = i;
        }
        int find(int cur) {
            if (parent[cur] == cur)
                return cur;
            return parent[cur] = find(parent[cur]);
        }

        void merge(int x, int y) {
            int parentX = find(x);
            int parentY = find(y);
            if (parentX != parentY)
                parent[parentY] = parentX;
        }
};

class Solution {
public:
    int minCostConnectPoints(vector<vector<int>>& points) {
        int rows = points.size();
        int cols = points[0].size();
        vector<Node> edges;
        for(int i = 0; i < points.size(); i++)  {
            for(int j = 0;j < points.size(); j++) {
                if (i == j)
                    continue;
                int cost = abs(points[i][0] - points[j][0]) + abs(points[i][1] -points[j][1]);
                edges.push_back(Node(i, j, cost));
            }
        }
        // Sort by cost in ascending order
        sort(edges.begin(), edges.end(), [](const Node &a, const Node &b) {
            return a.cost < b.cost;
        });

        DSU dsu(points.size());
        int totalCost = 0;
        for(int i = 0; i < edges.size(); i++)  {
            if (dsu.find(edges[i].x) != dsu.find(edges[i].y)) {
                totalCost += edges[i].cost;
                dsu.merge(edges[i].x, edges[i].y);
            }
        }

        return totalCost;

    }
};


// https://leetcode.com/problems/minimum-cost-walk-in-weighted-graph

class DSU {
public:

    vector<int> parent;
    vector<int> componentAnds;
    void merge(int x, int y, int cost) {
        int parentX = find(x);
        int parentY = find(y);

        // Merge
        if(parentX != parentY) {
            parent[parentY] = parentX;
        }
        if (componentAnds[parentX] == -1 && componentAnds[parentY] == -1) {
            componentAnds[parentX] = cost;
        } else if (componentAnds[parentX] == -1) {
            componentAnds[parentX] = componentAnds[parentY] & cost;
        } else if (componentAnds[parentY] == -1) {
            componentAnds[parentX] = componentAnds[parentX] & cost;
        } else {
            componentAnds[parentX] &= componentAnds[parentY] & cost;
        }
    }

    int find(int x) {
        if (parent[x] == x)
            return x;
        return parent[x] = find(parent[x]);
    }

    int cost(int x) {
        return componentAnds[x];
    }

    DSU(int n) {
        parent.resize(n + 5, 0);
        componentAnds.resize(n + 5, -1);

        for(int i = 0; i <= n; i++) {
            parent[i] = i;
        }
    }
};
class Solution {
public:
    vector<int> minimumCost(int n, vector<vector<int>>& edges, vector<vector<int>>& query) {
        DSU dsu(n);

        // Processand merge all edges
        int rows = edges.size();
        int columns = edges[0].size();

        for(int i = 0; i < rows; i++) {
            dsu.merge(edges[i][0], edges[i][1], edges[i][2]);
        }

        vector<int> result;

        for(int i = 0; i < query.size(); i++) {
            int pX = dsu.find(query[i][0]);
            int pY = dsu.find(query[i][1]);

            int ans;
            if (pX != pY)
                ans = -1;
            else 
                ans = dsu.cost(pX);

            result.push_back(ans);
        }
        return result;
    }
};
```

**Why it is correct:** by the cut property, the cheapest edge connecting two current
components is safe for some minimum spanning tree. Processing edges in sorted order and
accepting only cross-component edges applies that safe choice repeatedly. After `n - 1`
successful unions, the forest is connected and therefore is a minimum spanning tree.

**Complexity:** generating O(n^2) edges uses O(n^2) space. Sorting costs
O(n^2 log(n^2)), which simplifies to O(n^2 log n). DSU work is lower order.

**Edge cases:** zero or one point, duplicate coordinates with zero-cost edges, negative
coordinates, and stopping immediately after `n - 1` accepted edges.

## Failure Modes

- Generate both `(u, v)` and `(v, u)` for an undirected graph and double edge storage.
- Attach arbitrary roots without size or rank and create unnecessarily tall trees.
- Update component metadata on a node that is no longer a root.
- Forget that a failed union is the cycle signal.
- Use DSU when shortest paths or actual route reconstruction is required.
- Keep scanning all edges after the spanning tree already has `n - 1` edges.

## Recall Drill

1. What exact condition means two elements are connected?
2. How do path compression and union by size solve different parts of tree height?
3. Why does `unite` returning `false` identify a cycle edge?
4. Why is Kruskal dominated by sorting rather than DSU operations?
5. Which update type does ordinary online DSU not support well?

## Related Topics

- [Breadth-First Search](BFS.md) recovers traversal distances and paths, while DSU keeps
  only component membership.
