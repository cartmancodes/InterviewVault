# LRU Cache

## At a Glance

A Least Recently Used (LRU) cache evicts the key whose most recent access is oldest when
capacity is full.

| Requirement | Data structure |
|---|---|
| Find a key in average O(1) | Hash map |
| Move an accessed key in O(1) | Doubly linked list |
| Identify the least recent key in O(1) | List back |
| Identify the most recent key | List front |

**Core invariant:** every key in the map points to exactly one node in the list; the list
front is most recent and the list back is least recent.

`get` and `put` are O(1) average time. A cache of capacity `C` uses O(C) space.

## Interview Method

1. **Clarify observable behavior.** Ask whether `get` updates recency, whether updating
   an existing key counts as use, and what capacity zero means.
2. **State the direct approach.** A map finds values quickly but cannot identify the
   oldest access. A list orders accesses but needs O(n) to find a key.
3. **Combine structures by responsibility.** The map supplies identity; the list
   supplies recency order.
4. **Define one synchronization invariant.** Every mutation must update both structures
   or deliberately leave both unchanged.
5. **Choose stable handles.** Store list iterators in the map so an arbitrary node can be
   moved without searching.
6. **Implement touch before eviction.** Moving an existing node to the front should not
   allocate a replacement node.
7. **Test recency, not only values.** Use operations where a successful `get` changes
   which key is evicted next.
8. **State average-case hashing explicitly.** O(1) assumes ordinary hash-table behavior.

## How It Works

The doubly linked list is the recency timeline. Access moves an existing node to the
front. Insertion creates a front node. Eviction removes the back node and its map entry.

```mermaid
flowchart LR
    M["Hash map key to iterator"] --> N["List node"]
    F["Front most recent"] --> N
    N --> B["Back least recent"]
    A["get or update"] --> F
    B --> E["Evict at capacity"]
```

`std::list::splice` moves a node between positions without copying it and without
invalidating iterators to that node. This is the operation that joins map lookup with
constant-time recency maintenance.

## Reusable C++ Template

The original notebook did not contain a separate reusable helper. Its worked snippet
implements the map and doubly linked list directly.

## Worked Problems

### Design an LRU cache

**Problem:** Implement `get(key)` and `put(key, value)` with average O(1) time. Evict the
least recently used key when a new key exceeds capacity.

**Recognition:** This is simultaneous key lookup and mutable ordering. Neither a hash map
nor a list alone satisfies both requirements.

**Invariant:** `entries_[key]` points to the unique list pair for `key`; list order from
front to back is newest to oldest; list size never exceeds capacity.

The original notebook snippet is preserved verbatim:

```cpp legacy
class LRUCache {
public:

    // Create a doubly linked list 

    class Node {
        public:
        Node *next;
        Node *prev;
        int key;
        int val;

        Node(int _key, int _val) {
            key = _key;
            val = _val;
        }
    };

    Node* head = new Node(-1, -1);
    Node* tail = new Node(-1, -1); 

    int cap;

    unordered_map<int,Node*> nodeMap;

    LRUCache(int capacity) {
        cap = capacity;
        head -> next = tail;
        tail -> prev = head;
    }

    // Function to add a node right after head
    void addNode(Node* newNode) {
        Node* tempNode;
        tempNode = head -> next;
        newNode -> next = tempNode;
        newNode -> prev = head;
        head -> next = newNode;
        tempNode -> prev = newNode;

    }

    // Function to remove a given node from list
    void deleteNode(Node* delNode) {
        Node* delPrev = delNode -> prev;
        Node* delNext = delNode -> next;
        delPrev -> next = delNext;
        delNext -> prev = delPrev;
    }
    
    int get(int _key) {
        // Check if key is availabel in map
        if (nodeMap.find(_key) != nodeMap.end()) {
            Node* resNode = nodeMap[_key];
            int res = resNode -> val;

            nodeMap.erase(_key);
            deleteNode(resNode);
            addNode(resNode);

            nodeMap[_key] = head -> next;

            return res;

        }
        return -1;
    }
    
    void put(int _key, int value) {
        if (nodeMap.find(_key) != nodeMap.end()) {
            Node* curNode = nodeMap[_key];
            nodeMap.erase(_key);
            deleteNode(curNode);
        }
        // If capacity brached
        if (nodeMap.size() == cap) {
            nodeMap.erase(tail->prev->key);
            deleteNode(tail->prev);
        }
        addNode(new Node(_key, value));
        nodeMap[_key] = head->next;
    }
};

/**
 * Your LRUCache object will be instantiated and called as such:
 * LRUCache* obj = new LRUCache(capacity);
 * int param_1 = obj->get(key);
 * obj->put(key,value);
 */
```

**Dry run with capacity two:**

1. `put(1, 10)` gives order `[1]`.
2. `put(2, 20)` gives `[2, 1]`.
3. `get(1)` returns `10` and gives `[1, 2]`.
4. `put(3, 30)` evicts `2` and gives `[3, 1]`.

**Why it is correct:** every successful read and update moves the corresponding node to
the front, so the front is newest. New keys also enter at the front. If full, removing
the back removes exactly the oldest key. Every insertion and removal updates the map and
list together, preserving one-to-one correspondence.

**Complexity:** hash lookup is O(1) average, and list splice, front insertion, and back
removal are O(1). Storage is O(capacity).

**Edge cases:** capacity zero, capacity one, updating an existing key while full, reading
a missing key, and repeated reads that reorder eviction priority.

## Failure Modes

- Update the list but not the map, leaving a stale iterator or duplicate key.
- Allocate a new node for every hit instead of moving the existing node.
- Evict before checking whether `put` updates an existing key.
- Remove the list node before reading its key to erase the map entry.
- Forget that `get` changes recency even though it does not change the value.
- Use raw `new` nodes without deleting evicted nodes and leak memory.
- Treat O(1) hash-table operations as a worst-case guarantee.

## Recall Drill

1. What responsibility belongs to the map, and what belongs to the list?
2. Why must the list be doubly linked for arbitrary O(1) movement?
3. Does `std::list::splice` invalidate the stored iterator?
4. Which key is evicted after `put(1)`, `put(2)`, `get(1)`, `put(3)` at capacity two?
5. Why should capacity zero be handled before inserting a node?

## Related Topics

- [Linked Lists](LinkedLists.md) explains the pointer and reachability invariants behind
  constant-time list updates.
