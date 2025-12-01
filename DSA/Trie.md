```
class TrieNode {
public:
    TrieNode* next[26];
    ll cnt;
 
    TrieNode() {
        for (ll i = 0; i < 26; i++) {
            next[i] = NULL;
        }
        cnt = 0;
    }
};
 
class Trie {
private:
    TrieNode* root;
 
public:
    Trie() {
        root = new TrieNode();
    }
 
    void insert(const string& str) {
        TrieNode* node = root;
        for (char ch : str) {
            ll temp = ch - 'a';
            if (node->next[temp] == NULL) {
                node->next[temp] = new TrieNode();
            }
            node = node->next[temp];
            node->cnt++;
        }
    }
 
    ll find(const string& str) {
        TrieNode* node = root;
        for (char ch : str) {
            ll temp = ch - 'a';
            if (node->next[temp] != NULL) {
                node = node->next[temp];
            } else {
                return 0;
            }
        }
        return node->cnt;
    }
};
 
int main() {
    ll n, m;
    slli(n);
    slli(m);
 
    Trie trie;
    string str;
    
    for (ll i = 0; i < n; i++) {
        cin >> str;
        trie.insert(str);
    }
    
    for (ll i = 0; i < m; i++) {
        cin >> str;
        cout << trie.find(str) << endl;
    }
 
    return 0;
}
```
