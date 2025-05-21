# Linked List.

Detect cycle or loop in a linkedlist:

1. Naive hashing pointer approach in O(n) time and space: 

```
/**
 * Definition for singly-linked list.
 * struct ListNode {
 *     int val;
 *     ListNode *next;
 *     ListNode(int x) : val(x), next(NULL) {}
 * };
 */
class Solution {
public:
    bool hasCycle(ListNode *head) {
        unordered_set<ListNode*> st;
        while(head != nullptr) {
            if (st.find(head) != st.end())
                return true;
            st.insert(head);
            head = head -> next;
        }
        return false;
    }
};
```

2. Fast and slow pointer/ Floyd's Cycle finding method in O(n) time and O(1) space:

```
/**
 * Definition for singly-linked list.
 * struct ListNode {
 *     int val;
 *     ListNode *next;
 *     ListNode(int x) : val(x), next(NULL) {}
 * };
 */
class Solution {
public:
    bool hasCycle(ListNode *head) {

        ListNode *slow_pointer = head, *fast_pointer = head;

        while(slow_pointer != nullptr && fast_pointer != nullptr && fast_pointer-> next != nullptr) {
            slow_pointer = slow_pointer->next;
            fast_pointer = fast_pointer->next->next;

            if (slow_pointer == fast_pointer)
                return true;
        }
        return false;
    }
};
```
