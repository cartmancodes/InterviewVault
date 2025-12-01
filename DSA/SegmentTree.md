```
class SegmentTree {
public:
    vector<int> tree;
    int n;
    SegTree(vector<int>& arr) {
        n = arr.size();
        tree.resize(4*n, 0);
        build(0, 0, n - 1, arr);
    }

    int getOR(int left, int right) {
        return query(0, 0, n - 1, left, right);
    }

private:
    int combine(int a, int b) {
        return a | b;
    }
    void build(int index, int left, int right, vector<int> &arr) {
        if (left == right) {
            tree[index] = arr[left];
            return;
        }
        int mid = (left + right) / 2;
        build(2*index + 1, left, mid, arr);
        build(2*index + 2, mid + 1, right, arr);
        tree[index] = combine(tree[2*index + 1], tree[2*index + 2]);
    }

    int query(int index, int left, int right, int queryLeft, int queryRight) {
        if (queryRight < left || right < queryLeft)
            return 0;
        if (queryLeft <= left && right <= queryRight)
            return tree[index];
        int mid = (left + right) / 2;
        int leftResult = query(2*index + 1, left, mid, queryLeft, queryRight);
        int rightResult = query(2*index + 2, mid + 1, right, queryLeft, queryRight);
        return combine(leftResult, rightResult);
        
    }

    void update(int index, int left, int right, int pos, int val) {
        if (left == right) {
            tree[index] = val;
            return;
        }
        int mid = (left + right)/2;
        if (pos <= mid) 
            update(2*index + 1, left, mid, pos, val);
        else 
            update(2*index + 2, mid + 1, right, pos, val);
        tree[index] = combine(tree[2*index + 1], tree[2*index + 2]);
    }

}

class Solution {
public:
    int minimumDifference(vector<int>& nums, int k) {
        
    }
};
```
