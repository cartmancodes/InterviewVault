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
    'bfs', 'dsu', 'heap', 'linked-lists', 'lrucache',
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
    .replace(
      '## Failure Modes\nPitfalls.\n\n## Recall Drill\nQuestions.',
      '## Recall Drill\nQuestions.\n\n## Failure Modes\nPitfalls.',
    );
  const issues = validateDocument('DSA/Example.md', source, {
    compile: false,
    checkLinks: false,
  });
  assert.ok(issues.some((issue) => issue.includes('required H2 sections')));
});

test('untagged fences and invalid C++ are reported', () => {
  const untagged = validSource.replace('```cpp\n#include <vector>', '```\n#include <vector>');
  assert.ok(validateDocument('DSA/Example.md', untagged, {
    compile: false,
    checkLinks: false,
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
