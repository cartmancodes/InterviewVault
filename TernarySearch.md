Question: 3171. Find Subarray With Bitwise OR Closest to K(Leetcode)
References: https://codeforces.com/blog/entry/126959

Template:
```
while (hi - lo > 3) {
    int mid1 = lo + (hi - lo) / 3;
    int mid2 = hi - (hi - lo) / 3;

    int f1 = fx(mid1);
    int f2 = fx(mid2);

    if (f1 <= f2) {
        hi = mid2 - 1;
    } else {
        lo = mid1 + 1;
    }
}

// Iterate over lo to hi and return the max/min as per use case
if (lo == hi) {
    ans = min(ans, fx(lo));
} else {
    for (int r = lo; r <= hi; r++) {
        ans = min(ans, fx(r));
    }
}
```
