# Breadth-First Search

## At a Glance

Breadth-first search (BFS) explores states in increasing number of edges from a source.
That layer order makes it the default for shortest paths in unweighted graphs and for
simulations that spread one step per unit of time.

| Signal in the prompt | BFS interpretation |
|---|---|
| Minimum moves in an unweighted graph | First arrival is a shortest path |
| Spread, infection, fire, or simultaneous growth | Multi-source BFS |
| Nodes grouped by distance or level | Process one queue layer at a time |
| Grid movement with uniform step cost | Cells are graph vertices |

**Core invariant:** when a state leaves the queue, its recorded distance is the minimum
number of unweighted edges from the nearest source.

For `V` vertices and `E` edges, BFS takes O(V + E) time and O(V) extra space. A grid with
`rows * columns` cells takes O(rows * columns) time and space.

## Interview Method

1. **Clarify the state graph.** Define one state, its legal neighbors, all starting
   states, and whether every move has equal cost.
2. **State the direct approach.** Enumerating all paths repeats states exponentially;
   BFS avoids that by retaining only the earliest visit.
3. **Check the weight condition.** Uniform edge costs fit BFS. Different nonnegative
   costs require Dijkstra's algorithm instead.
4. **Define queue and visited invariants.** The queue contains discovered but unprocessed
   states. Mark a state when it is enqueued, not when it is later dequeued.
5. **Dry-run complete layers.** For time-based problems, seed all simultaneous sources
   before minute zero and process the current queue size as one layer.
6. **Implement neighbor generation separately.** Check bounds, validity, and visited
   state before enqueueing.
7. **Test unreachable and already-complete inputs.** These reveal incorrect time and
   termination handling.
8. **State complexity over states and transitions.** Count each state and edge at most
   once rather than describing the queue operations alone.

## How It Works

The queue is first-in, first-out. Every state at distance `d` is enqueued before any
state at distance `d + 1` can be processed. Therefore, the first discovery of a state is
through a shortest unweighted path.

```mermaid
flowchart LR
    S["All sources at distance 0"] --> L1["Layer 1"]
    L1 --> L2["Layer 2"]
    L2 --> L3["Layer 3"]
    Q["FIFO queue"] --> S
```

With multiple sources, enqueue every source with distance zero. This is equivalent to
adding a virtual super-source with a zero-cost edge to each real source. Each state then
receives its distance from the nearest source.

## Reusable C++ Template

The original notebook did not contain a separate reusable BFS template. Use the queue,
visited-state, and layer invariants above when adapting its preserved worked snippet.

## Worked Problems

### Rotting Oranges

**Problem:** Each minute, every rotten orange rots its four-directionally adjacent fresh
oranges. Return the minutes until none are fresh, or `-1` when some can never be reached.

**Recognition:** This is simultaneous unit-time spread on a grid. A separate BFS from
each rotten orange repeats work; one multi-source BFS models all spread fronts together.

**Invariant:** before a layer starts, the queue contains exactly the rotten cells that
can spread at the current minute. A fresh cell is changed to rotten when enqueued, so it
can enter the queue only once.

The original notebook snippet is preserved verbatim:

```cpp legacy
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
```

**Why it is correct:** all initially rotten oranges begin in layer zero. Inductively,
processing layer `m` enqueues every fresh orange one edge away and no other cell, so those
cells become rotten at minute `m + 1`. Marking on enqueue prevents duplicate work. If
fresh oranges remain after the queue empties, no path from any source reaches them.

**Complexity:** O(rows * columns) time and O(rows * columns) queue space in the worst
case.

**Edge cases:** no fresh oranges returns `0`; fresh oranges with no source return `-1`;
an isolated fresh region remains unreachable. The preserved snippet assumes the grid is
non-empty before reading `grid[0]`.

## Failure Modes

- Mark visited on dequeue, allowing the same state to be enqueued by several parents.
- Start one BFS per source instead of placing all sources in layer zero.
- Increment time for a queue layer that does not change any fresh cell.
- Use BFS when edge costs differ, invalidating the first-arrival shortest-path argument.
- Forget that a grid is empty before reading `grid.front()`.
- Mutate shared state too late and process a cell more than once.

## Recall Drill

1. Why does first discovery give a shortest path only for equal edge costs?
2. When should a vertex be marked visited?
3. How does multi-source BFS differ from running BFS repeatedly?
4. What does one queue layer represent in a spread simulation?
5. Which input makes Rotting Oranges return `-1`?

## Related Topics

- [Disjoint Set Union](DSU.md) answers connectivity questions when edges are added, but
  it does not recover shortest paths.
- [Heaps](Heap.md) replace the FIFO queue when the next state must be chosen by smallest
  accumulated cost rather than by insertion order.
