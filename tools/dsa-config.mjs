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
  'linked-lists': {
    order: 1,
    pattern: 'Pointer invariants',
    difficulty: 'Beginner',
    reviewMinutes: 12,
  },
  bfs: {
    order: 2,
    pattern: 'Layered traversal',
    difficulty: 'Intermediate',
    reviewMinutes: 14,
  },
  heap: {
    order: 3,
    pattern: 'Top-k and streaming',
    difficulty: 'Intermediate',
    reviewMinutes: 14,
  },
  trie: {
    order: 4,
    pattern: 'Prefix search',
    difficulty: 'Intermediate',
    reviewMinutes: 12,
  },
  dsu: {
    order: 5,
    pattern: 'Dynamic connectivity',
    difficulty: 'Intermediate',
    reviewMinutes: 15,
  },
  'lru-cache': {
    order: 6,
    pattern: 'Map plus linked list',
    difficulty: 'Intermediate',
    reviewMinutes: 15,
  },
  'segment-tree': {
    order: 7,
    pattern: 'Range aggregation',
    difficulty: 'Advanced',
    reviewMinutes: 18,
  },
  'ternary-search': {
    order: 8,
    pattern: 'Unimodal optimization',
    difficulty: 'Advanced',
    reviewMinutes: 12,
  },
});
