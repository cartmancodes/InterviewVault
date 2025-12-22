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
