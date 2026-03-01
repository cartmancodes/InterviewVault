```
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
