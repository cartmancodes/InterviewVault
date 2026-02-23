## Running median 

```
class Solution {
public:
    double findMedianSortedArrays(vector<int>& nums1, vector<int>& nums2) {
        // Keep a min heap here and find the max value 
        priority_queue<int> leftMaxHeap;
        
        // Keep a max heap here and find the min value 
        priority_queue<int, vector<int>, greater<int>> rightMinHeap;
        
        for(int i = 0; i < nums1.size(); i++) {
            // Add it to the min heap 
            int num = nums1[i];
            leftMaxHeap.push(num);
            
            // Now push the top of leftMax to rightMin 
            rightMinHeap.push(leftMaxHeap.top());
            leftMaxHeap.pop();
            
            // Check bal;ance
            if (leftMaxHeap.size() < rightMinHeap.size()) {
                leftMaxHeap.push(rightMinHeap.top());
                rightMinHeap.pop();
            }
        }
        
        for(int i = 0; i < nums2.size(); i++) {
            // Add it to the min heap 
            int num = nums2[i];
            leftMaxHeap.push(num);
            
            // Now push the top of leftMax to rightMin 
            rightMinHeap.push(leftMaxHeap.top());
            leftMaxHeap.pop();
            
            // Check bal;ance
            if (leftMaxHeap.size() < rightMinHeap.size()) {
                leftMaxHeap.push(rightMinHeap.top());
                rightMinHeap.pop();
            }
        }
        
        // Find medion 
        if (leftMaxHeap.size() > rightMinHeap.size())
            return leftMaxHeap.top();
        else 
            return double(leftMaxHeap.top() + rightMinHeap.top())/2;
    }
};
```
