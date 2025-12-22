// https://leetcode.com/problems/rotting-oranges

#include <vector>
#include <queue>
#include <algorithm>

using namespace std;

struct Node {
    int x, y, time;
};

class Solution {
public:
    int orangesRotting(vector<vector<int>>& grid) {
        int rows = grid.size();
        int cols = grid[0].size();
        queue<Node> q;
        int freshCount = 0;

        // 1. Initial Scan: Find all rotten oranges and count fresh ones
        for (int i = 0; i < rows; i++) {
            for (int j = 0; j < cols; j++) {
                if (grid[i][j] == 2) {
                    q.push({i, j, 0});
                } else if (grid[i][j] == 1) {
                    freshCount++;
                }
            }
        }

        // If there are no fresh oranges, it takes 0 minutes.
        if (freshCount == 0) return 0;

        int minutes = 0;
        int dx[] = {1, -1, 0, 0};
        int dy[] = {0, 0, 1, -1};

        // 2. Multi-source BFS
        while (!q.empty()) {
            Node curr = q.front();
            q.pop();

            minutes = max(minutes, curr.time);

            for (int i = 0; i < 4; i++) {
                int nx = curr.x + dx[i];
                int ny = curr.y + dy[i];

                // Check bounds and if the neighbor is a fresh orange
                if (nx >= 0 && nx < rows && ny >= 0 && ny < cols && grid[nx][ny] == 1) {
                    grid[nx][ny] = 2; // Mark as rotten
                    freshCount--;
                    q.push({nx, ny, curr.time + 1});
                }
            }
        }

        // 3. Final Check: If fresh oranges remain, they are unreachable
        return (freshCount == 0) ? minutes : -1;
    }
};
