# DSA Methodology and UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the eight DSA notes as verified interview-study chapters and present them as an ordered, DSA-specific learning track on the static site.

**Architecture:** Put the fixed DSA chapter contract and topic metadata in one ES module shared by the source checker and site builder. Add a compiler-backed source gate, rewrite each Markdown chapter independently against that gate, then add DSA-scoped generated markup and CSS while preserving the existing static rendering pipeline.

**Tech Stack:** Markdown, C++17, Node.js 20 ES modules, `node:test`, Marked, Mermaid, HTML/CSS, GitHub Actions, and the existing InterviewVault build checks.

---

## File Map

- Create `tools/dsa-config.mjs`: one source of truth for required H2 headings, study order, labels, difficulty, and review time.
- Create `tools/check-dsa.mjs`: validate DSA structure, links, code-fence tags, and C++ syntax.
- Create `tools/check-dsa.test.mjs`: unit tests for structure and compiler failures.
- Modify `tools/package.json`: expose focused DSA test and check commands.
- Rewrite `DSA/LinkedLists.md`: pointer invariants, Floyd cycle detection, reversal template.
- Rewrite `DSA/BFS.md`: queue/visited invariants and multi-source BFS through Rotting Oranges.
- Rewrite `DSA/Heap.md`: heap selection rules and two-heap streaming median.
- Rewrite `DSA/Trie.md`: prefix invariants and Replace Words.
- Rewrite `DSA/DSU.md`: component invariants, union by size, path compression, and Kruskal MST.
- Rewrite `DSA/LRUCache.md`: hash-map/list synchronization and a safe ownership-aware cache implementation.
- Rewrite `DSA/SegmentTree.md`: range decomposition and Range Sum Query Mutable.
- Rewrite `DSA/TernarySearch.md`: unimodality precondition and continuous convex minimization.
- Modify `tools/build-site.mjs`: order DSA pages, emit metadata and track markup, and decorate semantic DSA sections.
- Modify `tools/template/site.css`: add DSA-scoped metadata, track, workflow, warning, and recall styles with mobile behavior.
- Modify `tools/check-site.mjs`: assert DSA metadata, study order, semantic section wrappers, and pager order in generated HTML.
- Modify `.github/workflows/deploy.yml`: run the DSA source checker before rendering and building.
- Modify `README.md`: document the five local gates and the DSA chapter contract.
- Modify `CLAUDE.md`: keep repository instructions synchronized with the new mandatory gate.

Do not edit `site/`; every generated assertion is exercised by rebuilding it.

### Task 1: Shared DSA Contract

**Files:**
- Create: `tools/dsa-config.mjs`
- Create: `tools/check-dsa.test.mjs`
- Create: `tools/check-dsa.mjs`
- Modify: `tools/package.json`

- [ ] **Step 1: Write tests for the chapter and metadata contract**

Create `tools/check-dsa.test.mjs` with tests that import `validateDocument` and verify:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_DSA_SECTIONS, DSA_TOPICS } from './dsa-config.mjs';
import { validateDocument } from './check-dsa.mjs';

const validSource = `# Example

## At a Glance
Summary.

## Interview Method
Method.

## How It Works
Explanation.

## Reusable C++ Template
\`\`\`cpp
#include <vector>
int sizeOf(const std::vector<int>& values) { return static_cast<int>(values.size()); }
\`\`\`

## Worked Problems
\`\`\`cpp
#include <iostream>
int main() { std::cout << 1 << "\\n"; }
\`\`\`

## Failure Modes
Pitfalls.

## Recall Drill
Questions.

## Related Topics
[BFS](BFS.md)
`;

test('the registry covers all eight fixed DSA slugs in study order', () => {
  assert.deepEqual(Object.keys(DSA_TOPICS).sort(), [
    'bfs', 'dsu', 'heap', 'linked-lists', 'lru-cache',
    'segment-tree', 'ternary-search', 'trie',
  ]);
  assert.deepEqual(
    Object.values(DSA_TOPICS).map((topic) => topic.order).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('a complete chapter passes structure and C++ checks', () => {
  assert.deepEqual(validateDocument('DSA/Example.md', validSource, { checkLinks: false }), []);
});

test('missing and out-of-order sections are reported', () => {
  const source = validSource
    .replace('## At a Glance\nSummary.\n\n', '')
    .replace('## Failure Modes\nPitfalls.\n\n## Recall Drill\nQuestions.',
      '## Recall Drill\nQuestions.\n\n## Failure Modes\nPitfalls.');
  const issues = validateDocument('DSA/Example.md', source, { compile: false, checkLinks: false });
  assert.ok(issues.some((issue) => issue.includes('required H2 sections')));
});

test('untagged fences and invalid C++ are reported', () => {
  const untagged = validSource.replace('```cpp\n#include <vector>', '```\n#include <vector>');
  assert.ok(validateDocument('DSA/Example.md', untagged, {
    compile: false, checkLinks: false,
  }).some((issue) => issue.includes('untagged code fence')));

  const broken = validSource.replace('int main() {', 'int main( {');
  assert.ok(validateDocument('DSA/Example.md', broken, {
    checkLinks: false,
  }).some((issue) => issue.includes('C++ block 2')));
});

test('the exported section list is the approved contract', () => {
  assert.deepEqual(REQUIRED_DSA_SECTIONS, [
    'At a Glance', 'Interview Method', 'How It Works',
    'Reusable C++ Template', 'Worked Problems', 'Failure Modes',
    'Recall Drill', 'Related Topics',
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tools/check-dsa.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/dsa-config.mjs`.

- [ ] **Step 3: Add the shared registry**

Create `tools/dsa-config.mjs`:

```javascript
export const REQUIRED_DSA_SECTIONS = Object.freeze([
  'At a Glance',
  'Interview Method',
  'How It Works',
  'Reusable C++ Template',
  'Worked Problems',
  'Failure Modes',
  'Recall Drill',
  'Related Topics',
]);

export const DSA_TOPICS = Object.freeze({
  'linked-lists': { order: 1, pattern: 'Pointer invariants', difficulty: 'Beginner', reviewMinutes: 12 },
  bfs: { order: 2, pattern: 'Layered traversal', difficulty: 'Intermediate', reviewMinutes: 14 },
  heap: { order: 3, pattern: 'Top-k and streaming', difficulty: 'Intermediate', reviewMinutes: 14 },
  trie: { order: 4, pattern: 'Prefix search', difficulty: 'Intermediate', reviewMinutes: 12 },
  dsu: { order: 5, pattern: 'Dynamic connectivity', difficulty: 'Intermediate', reviewMinutes: 15 },
  'lru-cache': { order: 6, pattern: 'Map plus linked list', difficulty: 'Intermediate', reviewMinutes: 15 },
  'segment-tree': { order: 7, pattern: 'Range aggregation', difficulty: 'Advanced', reviewMinutes: 18 },
  'ternary-search': { order: 8, pattern: 'Unimodal optimization', difficulty: 'Advanced', reviewMinutes: 12 },
});
```

- [ ] **Step 4: Implement the validator and CLI**

Create `tools/check-dsa.mjs` with these exported boundaries:

```javascript
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DSA_TOPICS, REQUIRED_DSA_SECTIONS } from './dsa-config.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS, '..');
const DSA = path.join(REPO, 'DSA');

function slugOf(rel) {
  return path.basename(rel, '.md')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function compileBlocks(rel, source) {
  const issues = [];
  const blocks = [...source.matchAll(/```cpp\n([\s\S]*?)```/g)];
  const dir = mkdtempSync(path.join(tmpdir(), 'interview-vault-dsa-'));
  try {
    blocks.forEach((match, index) => {
      const file = path.join(dir, `block-${index + 1}.cpp`);
      writeFileSync(file, match[1]);
      const result = spawnSync(process.env.CXX || 'c++', [
        '-std=c++17', '-Wall', '-Wextra', '-pedantic', '-fsyntax-only', file,
      ], { encoding: 'utf8' });
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' | ');
        issues.push(`${rel}: C++ block ${index + 1} does not compile: ${detail}`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return issues;
}

function linkIssues(rel, source) {
  const issues = [];
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
    const target = path.resolve(REPO, path.dirname(rel), decodeURIComponent(match[1]));
    if (!existsSync(target)) issues.push(`${rel}: broken Markdown link ${match[1]}`);
  }
  return issues;
}

export function validateDocument(rel, source, options = {}) {
  const issues = [];
  const h1s = [...source.matchAll(/^#\s+.+$/gm)];
  if (h1s.length !== 1) issues.push(`${rel}: expected exactly one H1, found ${h1s.length}`);

  const h2s = [...source.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(h2s) !== JSON.stringify(REQUIRED_DSA_SECTIONS)) {
    issues.push(`${rel}: required H2 sections must be ${REQUIRED_DSA_SECTIONS.join(' -> ')}`);
  }

  if (/^```\s*$/m.test(source)) issues.push(`${rel}: untagged code fence`);
  for (const section of ['Reusable C++ Template', 'Worked Problems']) {
    const start = source.indexOf(`## ${section}`);
    const end = source.indexOf('\n## ', start + 3);
    const body = start < 0 ? '' : source.slice(start, end < 0 ? source.length : end);
    if (!/```cpp\n/.test(body)) issues.push(`${rel}: ${section} must contain a cpp block`);
  }

  if (options.checkLinks !== false) issues.push(...linkIssues(rel, source));
  if (options.compile !== false) issues.push(...compileBlocks(rel, source));
  return issues;
}

function selectedFiles(args) {
  if (args.length) return args.map((arg) => path.relative(REPO, path.resolve(REPO, arg)));
  return readdirSync(DSA).filter((name) => name.endsWith('.md')).map((name) => `DSA/${name}`);
}

export function run(args = process.argv.slice(2)) {
  const files = selectedFiles(args);
  const issues = [];
  const positions = new Map();
  for (const rel of files) {
    const slug = slugOf(rel);
    const topic = DSA_TOPICS[slug];
    if (!topic) issues.push(`${rel}: missing DSA metadata for slug ${slug}`);
    else if (positions.has(topic.order)) issues.push(`${rel}: duplicate study position ${topic.order}`);
    else positions.set(topic.order, rel);
    issues.push(...validateDocument(rel, readFileSync(path.join(REPO, rel), 'utf8')));
  }
  if (!args.length) {
    for (const slug of Object.keys(DSA_TOPICS)) {
      const found = files.some((rel) => slugOf(rel) === slug);
      if (!found) issues.push(`DSA metadata ${slug}: no matching Markdown file`);
    }
  }
  if (issues.length) {
    console.error(`${issues.length} DSA problem(s):\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    return 1;
  }
  console.log(`DSA OK - ${files.length} document(s), C++17 syntax checked`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
```

- [ ] **Step 5: Expose the commands and run the tests**

Add these scripts to `tools/package.json`:

```json
"scripts": {
  "build": "node build-site.mjs",
  "check:dsa": "node check-dsa.mjs",
  "test:dsa": "node --test check-dsa.test.mjs"
}
```

Run: `node --test tools/check-dsa.test.mjs`

Expected: PASS, 5 tests.

Run: `node tools/check-dsa.mjs DSA/BFS.md`

Expected: FAIL and report the missing H1, required H2 sequence, untagged C++, and current syntax context. This proves the source gate catches the pre-rewrite document.

- [ ] **Step 6: Commit the contract and checker**

```bash
git add tools/dsa-config.mjs tools/check-dsa.mjs tools/check-dsa.test.mjs tools/package.json
git commit -m "Add DSA chapter validation"
```

### Task 2: Linked Lists Chapter

**Files:**
- Rewrite: `DSA/LinkedLists.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Rewrite the chapter using the exact H2 contract**

Use cycle detection as the worked problem. The reusable template must show iterative reversal, define `ListNode`, and compile independently:

```cpp
#include <cstddef>

struct ListNode {
    int value;
    ListNode* next;
};

ListNode* reverseList(ListNode* head) {
    ListNode* previous = nullptr;
    ListNode* current = head;
    while (current != nullptr) {
        ListNode* next = current->next;
        current->next = previous;
        previous = current;
        current = next;
    }
    return previous;
}
```

The worked solution must use Floyd's algorithm, explain the distance-gain invariant, and include this complete function in a separately compilable block:

```cpp
#include <cstddef>

struct ListNode {
    int value;
    ListNode* next;
};

bool hasCycle(ListNode* head) {
    ListNode* slow = head;
    ListNode* fast = head;
    while (fast != nullptr && fast->next != nullptr) {
        slow = slow->next;
        fast = fast->next->next;
        if (slow == fast) return true;
    }
    return false;
}
```

Cover empty and one-node lists, preserving `next` before rewiring, checking `fast->next`, and the O(n) time/O(1) space tradeoff against pointer hashing. Link to `LRUCache.md`.

- [ ] **Step 2: Validate the focused chapter**

Run: `node tools/check-dsa.mjs DSA/LinkedLists.md`

Expected: `DSA OK - 1 document(s), C++17 syntax checked`.

- [ ] **Step 3: Commit the chapter**

```bash
git add DSA/LinkedLists.md
git commit -m "Rewrite linked-list interview guide"
```

### Task 3: BFS Chapter

**Files:**
- Rewrite: `DSA/BFS.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Rewrite BFS around queue and visited-state invariants**

The template must be a compilable adjacency-list BFS returning distances, with `-1` for unreachable vertices. The worked problem is multi-source Rotting Oranges using `queue<pair<int,int>>`, marking a fresh orange when enqueued, processing one queue layer per minute, and returning `-1` when `fresh != 0`.

Include complete C++17 blocks with all required headers. Explain why marking on dequeue permits duplicates, why all initial rotten cells must be seeded before traversal, and why elapsed time increments only after a layer that rots at least one fresh orange. Cover empty grids defensively, no-fresh input, isolated fresh cells, and O(rows * columns) time and space. Link to `DSU.md` and `Heap.md`.

- [ ] **Step 2: Run the focused source gate**

Run: `node tools/check-dsa.mjs DSA/BFS.md`

Expected: PASS for one document.

- [ ] **Step 3: Commit the chapter**

```bash
git add DSA/BFS.md
git commit -m "Rewrite BFS interview guide"
```

### Task 4: Heap Chapter

**Files:**
- Rewrite: `DSA/Heap.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Replace the mislabeled median example**

Explain heap recognition through repeated min/max access, top-k, scheduling, and streaming order statistics. The reusable template must show bounded top-k with a min-heap. The worked problem must be `MedianFinder` with a max-heap `lower` and min-heap `upper`, maintaining:

```text
lower.size() == upper.size() or lower.size() == upper.size() + 1
max(lower) <= min(upper)
```

Use safe averaging to avoid integer overflow:

```cpp
return (static_cast<double>(lower.top()) + static_cast<double>(upper.top())) / 2.0;
```

Both C++ blocks must include `<functional>`, `<queue>`, and `<vector>` as required and compile independently. Explain insertion O(log n), median O(1), total space O(n), duplicate and negative values, and why the old `findMedianSortedArrays` name was incorrect for a streaming-heap solution. Link to `BFS.md` and `SegmentTree.md`.

- [ ] **Step 2: Validate and commit**

Run: `node tools/check-dsa.mjs DSA/Heap.md`

Expected: PASS for one document.

```bash
git add DSA/Heap.md
git commit -m "Rewrite heap interview guide"
```

### Task 5: Trie Chapter

**Files:**
- Rewrite: `DSA/Trie.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Rewrite the trie implementation without contest macros**

Use `std::array<std::unique_ptr<Node>, 26>` so ownership is explicit and memory is reclaimed. The reusable template must support `insert`, `contains`, and `startsWith`; every character-to-index conversion must validate lowercase `a` through `z` or state that precondition explicitly.

Use Replace Words as the worked problem. Preserve the invariant that the first terminal node encountered is the shortest root, and return the original word when traversal cannot continue. Include independent compilable C++17 blocks with `<array>`, `<memory>`, `<sstream>`, `<string>`, and `<vector>` where used. State O(total input characters) construction and replacement time. Cover duplicate roots, an empty dictionary, no matching root, and shortest-prefix selection. Link to `BFS.md`.

- [ ] **Step 2: Validate and commit**

Run: `node tools/check-dsa.mjs DSA/Trie.md`

Expected: PASS for one document.

```bash
git add DSA/Trie.md
git commit -m "Rewrite trie interview guide"
```

### Task 6: DSU Chapter

**Files:**
- Rewrite: `DSA/DSU.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Rewrite DSU around representative invariants**

The reusable `DisjointSet` must initialize each node as its own parent, use path compression in `find`, union by size, and return whether a union merged two components:

```cpp
bool unite(int a, int b) {
    a = find(a);
    b = find(b);
    if (a == b) return false;
    if (size_[a] < size_[b]) std::swap(a, b);
    parent_[b] = a;
    size_[a] += size_[b];
    return true;
}
```

Use Min Cost to Connect All Points as the Kruskal worked problem. Generate each undirected edge once with `j = i + 1`, sort by Manhattan weight, add only successful unions, and stop after `n - 1` edges. Include standalone C++17 blocks and explain O(n^2 log n) time/O(n^2) edge storage for this teaching implementation, near-constant amortized DSU operations, and why the previous double edge generation was wasteful. Cover zero/one points, duplicate coordinates, and stopping early. Link to `BFS.md`.

- [ ] **Step 2: Validate and commit**

Run: `node tools/check-dsa.mjs DSA/DSU.md`

Expected: PASS for one document.

```bash
git add DSA/DSU.md
git commit -m "Rewrite DSU interview guide"
```

### Task 7: LRU Cache Chapter

**Files:**
- Rewrite: `DSA/LRUCache.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Replace the leaking raw-node implementation**

Teach the synchronization invariant: every key in the map points to exactly one list node, list front is most recent, and list back is least recent. Use `std::list<std::pair<int,int>>` plus an iterator map so ownership stays in the list:

```cpp
#include <list>
#include <unordered_map>
#include <utility>

class LRUCache {
public:
    explicit LRUCache(std::size_t capacity) : capacity_(capacity) {}

    int get(int key) {
        auto found = entries_.find(key);
        if (found == entries_.end()) return -1;
        items_.splice(items_.begin(), items_, found->second);
        return found->second->second;
    }

    void put(int key, int value) {
        auto found = entries_.find(key);
        if (found != entries_.end()) {
            found->second->second = value;
            items_.splice(items_.begin(), items_, found->second);
            return;
        }
        if (capacity_ == 0) return;
        if (items_.size() == capacity_) {
            entries_.erase(items_.back().first);
            items_.pop_back();
        }
        items_.emplace_front(key, value);
        entries_[key] = items_.begin();
    }

private:
    using Iterator = std::list<std::pair<int, int>>::iterator;
    std::size_t capacity_;
    std::list<std::pair<int, int>> items_;
    std::unordered_map<int, Iterator> entries_;
};
```

Use the cache design itself as the worked problem, with a dry run for `put(1)`, `put(2)`, `get(1)`, `put(3)`. Explain average O(1) operations, capacity zero, existing-key updates, iterator validity under `splice`, and erasing the map entry before removing the list node. The reusable section may extract a generic `touch` helper but must remain independently compilable. Link to `LinkedLists.md`.

- [ ] **Step 2: Validate and commit**

Run: `node tools/check-dsa.mjs DSA/LRUCache.md`

Expected: PASS for one document.

```bash
git add DSA/LRUCache.md
git commit -m "Rewrite LRU cache interview guide"
```

### Task 8: Segment Tree Chapter

**Files:**
- Rewrite: `DSA/SegmentTree.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Replace the incomplete class and empty solution**

Use an iterative 2n segment tree for range sums so the template is compact and avoids recursive boundary mistakes. Define `update(index, value)` and inclusive `query(left, right)`, and state the invariant that each internal node stores the sum of its two children.

Use Range Sum Query Mutable as the worked problem, wrapping the tree in a `NumArray` interface. Include complete C++17 blocks with `<stdexcept>` and `<vector>`, explicit empty-input behavior, O(n) build, O(log n) update/query, and O(n) storage. Explain disjoint/partial/full overlap conceptually even though the selected template is iterative. Cover one element, full range, repeated updates, invalid ranges, and why `4 * n` is used only by recursive layouts. Link to `Heap.md`.

- [ ] **Step 2: Validate and commit**

Run: `node tools/check-dsa.mjs DSA/SegmentTree.md`

Expected: PASS for one document.

```bash
git add DSA/SegmentTree.md
git commit -m "Rewrite segment-tree interview guide"
```

### Task 9: Ternary Search Chapter

**Files:**
- Rewrite: `DSA/TernarySearch.md`
- Test: `tools/check-dsa.mjs`

- [ ] **Step 1: Correct the algorithm's applicability and template bug**

State that ternary search requires a unimodal objective and is not a general solution for LeetCode 3171. Remove the old loop typo that incremented `r` instead of `i`.

The reusable section must provide both a discrete minimization template with a final scan and a continuous minimization template with a fixed 200 iterations. Use the worked problem: choose an x-coordinate on the x-axis minimizing the sum of Euclidean distances to input points. The objective is convex, so compare `cost(mid1)` and `cost(mid2)` and discard the worse outer third. Include complete C++17 blocks using `<algorithm>`, `<cmath>`, `<limits>`, `<utility>`, and `<vector>` where needed.

Explain O(iterations * n) time, O(1) auxiliary space, precision versus iteration count, flat minima, integer overflow in midpoint arithmetic, and why binary search is preferable when a monotone predicate exists. Link to `SegmentTree.md`.

- [ ] **Step 2: Validate and commit**

Run: `node tools/check-dsa.mjs DSA/TernarySearch.md`

Expected: PASS for one document.

```bash
git add DSA/TernarySearch.md
git commit -m "Rewrite ternary-search interview guide"
```

### Task 10: Full DSA Source Gate

**Files:**
- Verify: all `DSA/*.md`
- Modify if required: the chapter that fails

- [ ] **Step 1: Run the complete checker**

Run: `node tools/check-dsa.mjs`

Expected: `DSA OK - 8 document(s), C++17 syntax checked`.

- [ ] **Step 2: Run validator unit tests**

Run: `node --test tools/check-dsa.test.mjs`

Expected: PASS, 5 tests.

- [ ] **Step 3: Audit the authored chapter contract**

Run:

```bash
for file in DSA/*.md; do
  printf '%s: ' "$file"
  rg -c '^## (At a Glance|Interview Method|How It Works|Reusable C\+\+ Template|Worked Problems|Failure Modes|Recall Drill|Related Topics)$' "$file"
done
```

Expected: every file prints `8`.

No commit is needed if the focused chapter commits already pass unchanged. If this audit finds a correction, commit only the affected DSA files with `git commit -m "Fix DSA chapter contract"`.

### Task 11: DSA Site Rendering

**Files:**
- Modify: `tools/check-site.mjs`
- Modify: `tools/build-site.mjs`
- Modify: `tools/template/site.css`
- Test: generated `site/dsa/*/index.html`

- [ ] **Step 1: Add failing generated-site assertions**

In `tools/check-site.mjs`, add DSA checks after the general page loop. Import `DSA_TOPICS`, then assert each generated DSA page has the expected metadata, track position, section wrappers, and previous/next order:

```javascript
import { DSA_TOPICS } from './dsa-config.mjs';

const orderedDsa = Object.entries(DSA_TOPICS)
  .sort(([, a], [, b]) => a.order - b.order);

for (const [index, [slug, topic]] of orderedDsa.entries()) {
  const rel = `dsa/${slug}/index.html`;
  const file = path.join(SITE, rel);
  if (!existsSync(file)) {
    problems.push(`${rel}: missing ordered DSA page`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  if (!html.includes('class="doc dsa-doc"')) problems.push(`${rel}: missing dsa-doc body class`);
  if (!html.includes(`data-dsa-order="${topic.order}"`)) problems.push(`${rel}: missing study order ${topic.order}`);
  if (!html.includes(`>${topic.pattern}<`)) problems.push(`${rel}: missing pattern metadata`);
  if (!html.includes(`>${topic.difficulty}<`)) problems.push(`${rel}: missing difficulty metadata`);
  if (!html.includes(`>${topic.reviewMinutes} min review<`)) problems.push(`${rel}: missing review-time metadata`);
  for (const className of ['dsa-summary', 'dsa-method', 'dsa-warning', 'dsa-recall']) {
    if (!html.includes(` ${className}"`)) problems.push(`${rel}: missing ${className} section`);
  }
  const previous = orderedDsa[index - 1]?.[0];
  const next = orderedDsa[index + 1]?.[0];
  if (previous && !html.includes(`href="/dsa/${previous}/"`)) problems.push(`${rel}: missing previous topic ${previous}`);
  if (next && !html.includes(`href="/dsa/${next}/"`)) problems.push(`${rel}: missing next topic ${next}`);
}
```

Run the existing build followed by `node tools/check-site.mjs`.

Expected: FAIL with missing `dsa-doc`, metadata, and DSA section wrapper messages.

- [ ] **Step 2: Attach metadata and stable ordering in the builder**

Import `DSA_TOPICS` in `tools/build-site.mjs`. When constructing each doc, attach `dsa: DSA_TOPICS[slug] || null`. Add one collection helper and use it both for home-page rows and document builds:

```javascript
function docsForCollection(collection) {
  const list = docs.filter((doc) => doc.col.key === collection.key);
  if (collection.key !== 'dsa') return list;
  return list.sort((a, b) => a.dsa.order - b.dsa.order);
}
```

Fail during discovery if a DSA slug has no metadata. This makes ordering deterministic and prevents a new unregistered file from silently appearing.

- [ ] **Step 3: Decorate semantic DSA sections**

After heading IDs are assigned in `renderDoc`, wrap only these DSA H2 sections:

```javascript
function decorateDsaSections(html) {
  const classes = {
    'at-a-glance': 'dsa-summary',
    'interview-method': 'dsa-method',
    'failure-modes': 'dsa-warning',
    'recall-drill': 'dsa-recall',
  };
  return html.replace(
    /<h2 id="([^"]+)">([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2 id="|$)/g,
    (full, id, title, content) => classes[id]
      ? `<section class="dsa-section ${classes[id]}"><h2 id="${id}">${title}</h2>${content}</section>`
      : full,
  );
}
```

Call it only when `doc.col.key === 'dsa'`. This preserves plain semantic Markdown while making the generated treatments explicit.

- [ ] **Step 4: Emit DSA metadata and track navigation**

For DSA pages, emit:

```html
<div class="dsa-meta" data-dsa-order="3">
  <span>03 / 08</span><span>Top-k and streaming</span><span>Intermediate</span><span>14 min review</span>
</div>
```

Generate the left navigation as `<nav class="side dsa-track" aria-label="DSA study track">`, prefix each title with a zero-padded order, and set `aria-current="page"` on the active item. Set the body class to `doc dsa-doc`; non-DSA pages remain `doc`.

- [ ] **Step 5: Add DSA-scoped responsive styles**

Add styles to `tools/template/site.css` for:

```css
.dsa-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.dsa-meta span { padding: 4px 8px; border: 1px solid var(--rule); border-radius: 100px; font: 11px var(--mono); color: var(--mut); background: var(--soft); }
.dsa-track a { display: grid; grid-template-columns: 2.2em 1fr; gap: 5px; }
.dsa-track .track-n { font-family: var(--mono); color: var(--mut); }
.dsa-section { margin: 1.8em -18px 0; padding: 18px; border: 1px solid var(--rule); border-radius: 8px; }
.dsa-section > h2:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.dsa-summary { background: #F7F9FE; }
.dsa-method { border-color: color-mix(in srgb, var(--blue) 35%, var(--rule)); background: var(--blue-wash); }
.dsa-method ol { list-style: none; padding: 0; counter-reset: dsa-step; display: grid; gap: 9px; }
.dsa-method ol > li { counter-increment: dsa-step; display: grid; grid-template-columns: 2em 1fr; gap: 9px; align-items: start; }
.dsa-method ol > li::before { content: counter(dsa-step, decimal-leading-zero); font: 600 11px var(--mono); color: var(--blue-deep); padding-top: 3px; }
.dsa-warning { border-left: 4px solid var(--amber); background: #FFFBEB; }
.dsa-recall { border-style: dashed; background: var(--paper); }

@media (max-width: 800px) {
  .dsa-track ol { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 6px; }
  .dsa-track li { flex: 0 0 auto; }
  .dsa-section { margin-left: 0; margin-right: 0; padding: 15px; }
}
```

Keep all selectors under `.dsa-*` or `.dsa-doc` so system-design pages do not change.

- [ ] **Step 6: Rebuild and verify generated UX**

Run:

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
node tools/check-site.mjs
```

Expected: the build reports 8 Data Structures pages and `site OK` with no DSA assertion failures.

Inspect `site/dsa/linked-lists/index.html` and `site/dsa/ternary-search/index.html` in a local browser at desktop and mobile widths. Confirm no page-level horizontal overflow, the ordered track is usable, code blocks scroll internally, and content remains usable with JavaScript disabled.

- [ ] **Step 7: Commit the site UX**

```bash
git add tools/build-site.mjs tools/check-site.mjs tools/template/site.css
git commit -m "Add ordered DSA study experience"
```

### Task 12: CI and Contributor Documentation

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the source gate to CI**

Insert this step before the Python check in `.github/workflows/deploy.yml`:

```yaml
      - name: Check DSA chapters and C++ samples
        run: node tools/check-dsa.mjs
```

Ubuntu's hosted runner includes `g++`; the checker uses `CXX` when explicitly configured and otherwise invokes `c++`.

- [ ] **Step 2: Document the chapter contract and five gates**

In `README.md`, update the CI section to list `node tools/check-dsa.mjs` before the four existing commands. Add a short DSA subsection naming the eight required H2 sections, explaining that all `cpp` fences are compiler-checked, and pointing to `tools/dsa-config.mjs` for study metadata.

In `CLAUDE.md`, add `node tools/check-dsa.mjs` to the non-negotiable gate block before `check-python.py`, and state that DSA documents must follow the heading order exported by `tools/dsa-config.mjs`.

- [ ] **Step 3: Run focused checks**

Run:

```bash
node --test tools/check-dsa.test.mjs
node tools/check-dsa.mjs
```

Expected: 5 unit tests pass and all 8 DSA documents pass C++17 syntax checking.

- [ ] **Step 4: Commit CI and documentation**

```bash
git add .github/workflows/deploy.yml README.md CLAUDE.md
git commit -m "Enforce DSA quality gate in CI"
```

### Task 13: Final Verification and Review

**Files:**
- Verify: all modified source files
- Never stage: `site/`

- [ ] **Step 1: Run every source and unit gate**

```bash
node --test tools/check-dsa.test.mjs
node tools/check-dsa.mjs
python3 tools/check-python.py
```

Expected: all commands exit 0; DSA reports 8 documents.

- [ ] **Step 2: Run the complete build gates**

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
node tools/check-site.mjs
```

Expected: all Mermaid blocks render, the site builds, and the site checker reports no broken links, missing assets, dead anchors, malformed scripts, or DSA UX failures.

- [ ] **Step 3: Verify repository hygiene**

Run:

```bash
git status --short
git diff --check
git ls-files site
```

Expected: no uncommitted files, no whitespace errors, and no tracked paths under `site/`.

- [ ] **Step 4: Request code and content review**

Use the `superpowers:requesting-code-review` skill. Ask the reviewer to compare the implementation against `docs/superpowers/specs/2026-07-28-dsa-methodology-ux-design.md`, with particular attention to algorithm correctness, C++ ownership and boundary behavior, mobile overflow, build isolation for non-DSA pages, and test coverage.

- [ ] **Step 5: Apply review findings and re-run all gates**

For any valid finding, use the relevant debugging or review skill, add a regression test when behavior changed, make the smallest correction, and rerun Steps 1 through 3 before committing the fix as a new commit.
