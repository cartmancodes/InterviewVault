Question: 3171. Find Subarray With Bitwise OR Closest to K(Leetcode)
Template: https://codeforces.com/blog/entry/126959
```
while (hi - lo > 3) {
    int mid1 = lo + (hi - lo) / 3;
    int mid2 = hi - (hi - lo) / 3;

    int f1 = fx(nums, segTree, left, mid1, k);
    int f2 = fx(nums, segTree, left, mid2, k);

    if (f1 <= f2) {
        hi = mid2 - 1;
    } else {
        lo = mid1 + 1;
    }
}

if (lo == hi) {
    ans = min(ans, fx(nums, segTree, left, lo, k));
} else {
    for (int r = lo; r <= hi; r++) {
        ans = min(ans, fx(nums, segTree, left, r, k));
    }
}
```
