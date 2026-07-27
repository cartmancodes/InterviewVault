# Heaps

## At a Glance

A heap maintains one extreme value while supporting incremental updates. A max-heap
exposes the largest item; a min-heap exposes the smallest.

| Signal in the prompt | Heap shape |
|---|---|
| K largest items | Min-heap capped at size k |
| K smallest items | Max-heap capped at size k |
| Repeatedly take the next smallest or largest | Heap of current candidates |
| Running median | Max-heap for lower half, min-heap for upper half |
| Merge sorted streams | Min-heap containing one head per stream |

**Core invariant:** the heap root is the only globally ordered element; do not assume the
remaining array representation is sorted.

| Operation | Time |
|---|---:|
| Read root | O(1) |
| Insert | O(log n) |
| Remove root | O(log n) |
| Build from n values | O(n) |

## Interview Method

1. **Clarify which extreme matters.** Ask whether the output needs all values sorted or
   only the next minimum, maximum, or kth boundary.
2. **State the sorting baseline.** Sorting often costs O(n log n) and stores more order
   than the problem needs.
3. **Choose the opposite root for bounded top-k.** Keep the k largest values in a
   min-heap so the weakest retained candidate is easy to evict.
4. **Define heap membership.** Say exactly which values belong in each heap and what the
   root represents.
5. **State balance invariants before coding.** For a median, heap sizes differ by at most
   one and every lower-half value is at most every upper-half value.
6. **Insert, repair order, then rebalance.** Keeping these as distinct steps prevents
   subtle size and ordering errors.
7. **Test duplicates, negatives, and small k.** Include `k = 0`, one value, and even and
   odd stream lengths.
8. **State complexity using heap size.** A bounded heap gives O(n log k), not O(n log n).

## How It Works

A binary heap is a complete binary tree stored in an array. For zero-based index `i`, its
children are `2i + 1` and `2i + 2`. In a min-heap, every parent is no larger than its
children. That local property is sufficient to make index zero the global minimum.

For a running median, split values around the middle:

```mermaid
flowchart LR
    L["Max-heap lower half"] --> M["Median boundary"]
    M --> U["Min-heap upper half"]
    I["New value"] --> L
    L --> U
    U --> L
```

The max-heap root is the largest lower-half value. The min-heap root is the smallest
upper-half value. Those two roots are exactly the values needed to answer the median.

## Reusable C++ Template

Keep the k largest values seen so far. The min-heap root is the smallest retained value,
so a better candidate can replace it in O(log k).

```cpp
#include <algorithm>
#include <functional>
#include <queue>
#include <vector>

std::vector<int> kLargest(const std::vector<int>& values, int k) {
    if (k <= 0) return {};

    std::priority_queue<int, std::vector<int>, std::greater<int>> best;
    for (int value : values) {
        best.push(value);
        if (static_cast<int>(best.size()) > k) best.pop();
    }

    std::vector<int> result;
    while (!best.empty()) {
        result.push_back(best.top());
        best.pop();
    }
    std::reverse(result.begin(), result.end());
    return result;
}
```

The scan is O(n log k), extraction is O(k log k), and the heap uses O(k) space.

## Worked Problems

### Find the median from a data stream

**Problem:** Support `addNum(value)` and return the median of all values seen so far.

**Recognition:** Re-sorting after every insertion costs O(n log n) per update. The answer
depends only on the middle boundary, which two heaps maintain incrementally.

**Invariants:**

1. `lower.size()` equals `upper.size()` or exceeds it by one.
2. Every value in `lower` is less than or equal to every value in `upper`.

```cpp
#include <functional>
#include <queue>
#include <stdexcept>
#include <vector>

class MedianFinder {
public:
    void addNum(int value) {
        lower_.push(value);
        upper_.push(lower_.top());
        lower_.pop();

        if (upper_.size() > lower_.size()) {
            lower_.push(upper_.top());
            upper_.pop();
        }
    }

    double findMedian() const {
        if (lower_.empty()) throw std::logic_error("median of an empty stream");
        if (lower_.size() > upper_.size()) {
            return static_cast<double>(lower_.top());
        }
        return (static_cast<double>(lower_.top()) +
                static_cast<double>(upper_.top())) / 2.0;
    }

private:
    std::priority_queue<int> lower_;
    std::priority_queue<int, std::vector<int>, std::greater<int>> upper_;
};
```

**Why it is correct:** every insertion first enters `lower`. Moving its maximum to
`upper` restores the ordering invariant because the transferred value becomes an
upper-half candidate. If `upper` becomes larger, moving its minimum back to `lower`
restores the size invariant. The one or two roots therefore delimit the middle.

**Dry run:** inserting `5, 2, 10, 4` produces medians `5, 3.5, 5, 4.5`.

**Complexity:** insertion is O(log n), median lookup is O(1), and total storage is O(n).
Converting each root to `double` before addition avoids signed integer overflow.

**Edge cases:** one value, duplicate values, all negative values, alternating extremes,
and an empty stream when the interface permits a query before insertion.

## Failure Modes

- Use a max-heap for the k largest values and lose O(1) access to the eviction boundary.
- Assume iteration over a priority queue yields sorted order.
- Rebalance sizes without first restoring the lower-versus-upper ordering invariant.
- Let the upper heap exceed the lower heap and read the wrong odd-length median.
- Add two integer roots before converting to `double`, causing overflow.
- Call `top()` on an empty heap.

## Recall Drill

1. Why does a min-heap retain the k largest values?
2. Which two invariants make the running median correct?
3. Why is heap construction O(n), even though n separate insertions are O(n log n)?
4. When should a FIFO queue be used instead of a heap?
5. What does the root represent in a k-largest bounded heap?

## Related Topics

- [Breadth-First Search](BFS.md) uses a FIFO queue when all transitions have equal cost.
- [Segment Trees](SegmentTree.md) support repeated range queries and point updates when
  retaining only one global extreme is insufficient.
