# DSA Methodology and UX Design

## Goal

Turn the eight existing DSA documents from loosely formatted C++ snippets into
accurate, self-contained interview study chapters. Every chapter should teach a
repeatable problem-solving method, provide verified examples, and support both
focused learning and fast review through a DSA-specific site experience.

The primary use case is solving coding interview problems. The pages should
therefore emphasize recognition, constraints, brute-force reasoning,
optimization, invariants, implementation, correctness, complexity, and testing.

## Scope

Rewrite these existing documents:

- `DSA/BFS.md`
- `DSA/DSU.md`
- `DSA/Heap.md`
- `DSA/LinkedLists.md`
- `DSA/LRUCache.md`
- `DSA/SegmentTree.md`
- `DSA/TernarySearch.md`
- `DSA/Trie.md`

Update `tools/build-site.mjs`, `tools/check-site.mjs`, and
`tools/template/site.css` to provide DSA-specific metadata, navigation, visual
treatments, and generated-site validation. Add a source checker for the chapter
and C++ contracts, and wire it into the documented local and CI gates.

Do not add new DSA topics, placeholder documents, browser-based practice,
progress tracking, or a DSA practice sidecar in this pass. Do not hand-edit or
commit generated files under `site/`.

## Chosen Approach

Use a uniform interview playbook tailored to each topic. Every page follows the
same problem-solving sequence, but its recognition signals, invariants,
templates, examples, and tests remain specific to the data structure or
algorithm.

This approach is preferred over a problem-first casebook because it supports
consistent revision across the collection. It is preferred over a conventional
reference manual with an interview appendix because the problem-solving method
should shape each chapter rather than appear as secondary material.

## Chapter Contract

Each DSA document must contain one H1 and the following H2 sections in this
order. H3 subsections may vary when needed by the topic.

1. `At a Glance`
2. `Interview Method`
3. `How It Works`
4. `Reusable C++ Template`
5. `Worked Problems`
6. `Failure Modes`
7. `Recall Drill`
8. `Related Topics`

### At a Glance

Provide a scan-friendly summary of:

- the problems the topic solves;
- recognition signals in prompts and constraints;
- the core invariant;
- time and space complexity for the important operations.

### Interview Method

Apply this shared workflow to the topic:

1. Clarify the input, output, constraints, mutation rules, and edge cases.
2. State a direct or brute-force solution and its bottleneck.
3. Match the bottleneck to the topic's recognition signals.
4. Define the state and invariant before writing code.
5. Walk through a small example and justify correctness.
6. Implement the smallest complete solution.
7. Test normal, boundary, degenerate, and adversarial cases.
8. State time and space complexity precisely.

The section must explain how these steps change for the topic rather than merely
repeat the generic list.

### How It Works

Explain the topic's intuition, state, and operations in plain language. Include
a Mermaid diagram only when it materially clarifies transitions, structure, or
control flow. Diagrams must follow the repository's Mermaid syntax rules.

### Reusable C++ Template

Provide a valid fenced `cpp` example using standard C++ types and explicit
includes when the snippet is intended to stand alone. Do not use unexplained
competitive-programming aliases or macros. Clearly identify any interface types
supplied by a coding platform, such as `ListNode`.

### Worked Problems

Include at least one representative interview problem. Take it through:

- recognition and constraint analysis;
- brute force and its limiting cost;
- optimized design and invariant;
- a small dry run;
- correctness reasoning;
- complete C++ code;
- time and space complexity;
- edge cases and tests.

Existing snippets may be retained only when they are correct and serve this
structure. Incomplete, mislabeled, misleading, or non-compilable examples must
be corrected or replaced.

### Failure Modes

Describe common incorrect approaches, implementation mistakes, complexity
misstatements, and debugging checks that are specific to the topic.

### Recall Drill

End with concise self-test prompts that can be answered without running code.
This is static document content, not an interactive checkpoint system.

### Related Topics

Cross-link only to relevant documents among the eight in-scope DSA pages. Links
must use repository-relative Markdown paths that the site builder can rewrite.

## DSA Site UX

The generated site should present DSA as an ordered interview study track rather
than an alphabetical collection of snippets.

### Metadata

Maintain an explicit DSA registry in the source build tooling. Each topic has:

- a stable study position;
- a short pattern label;
- a difficulty label;
- an estimated review time.

The registry is intentionally small and build-owned because there are only eight
fixed pages and the Markdown format currently has no front matter. A missing or
duplicate DSA registry entry must fail validation rather than silently falling
back to alphabetical behavior.

### Navigation

For DSA pages, replace the generic sibling presentation with a numbered track
that shows the current topic and position. Previous and next links must follow
this study order. Non-DSA collections retain their current behavior.

On narrow screens, the track should remain compact and horizontally navigable
without making the header or article excessively tall.

### Page Presentation

Show the topic metadata in the article header. Render the `Interview Method`
section as a prominent, scan-friendly workflow. Give recognition signals,
invariants, complexity summaries, failure modes, and recall drills consistent
visual emphasis using ordinary semantic Markdown and DSA-scoped rendering or
styles.

Do not introduce custom Markdown directives. The authored files should remain
readable on GitHub and in text editors. The build may recognize the required DSA
heading names to add classes or wrappers to generated HTML.

Preserve the existing IBM Plex typography and engineering-blueprint design
language. Code blocks and wide complexity tables must remain horizontally
scrollable. Core article content and navigation must work without JavaScript;
the existing table-of-contents behavior remains progressive enhancement.

## Build Flow

1. The build discovers the eight Markdown files through the existing DSA
   collection.
2. DSA validation checks the filename registry and required chapter headings.
3. The renderer uses registry metadata to order pages, populate the article
   header, build the study track, and select DSA-scoped presentation hooks.
4. Markdown is rendered through the existing pipeline, including Mermaid,
   asset copying, table wrapping, heading IDs, and internal-link rewriting.
5. The static site checker verifies generated links, anchors, metadata, and DSA
   ordering.

The Markdown remains the source of truth. DSA rendering must not create a second
content store.

## Validation and Errors

Validation failures must identify the source document and the missing,
duplicate, or invalid field. The build must reject:

- an in-scope DSA file without exactly one H1;
- missing, duplicate, or out-of-order required H2 sections;
- an absent or duplicate DSA metadata entry;
- duplicate study positions;
- broken related-topic links;
- dead generated anchors;
- code fences for C++ examples that omit the `cpp` language identifier.

Add a C++ validation gate using the local compiler where practical. The check
must distinguish complete translation units from coding-platform class snippets
through an explicit documented convention. It must not report illustrative
pseudocode as compiler-verified C++.

## Verification

Implementation is complete when:

1. All eight DSA pages satisfy the chapter contract and contain accurate,
   topic-specific interview methodology.
2. Each page includes at least one worked problem with recognition, invariant,
   correctness, complete C++, complexity, and edge cases.
3. C++ examples pass the new validation contract.
4. DSA pages render in the configured study order with metadata, track
   navigation, DSA-specific section treatments, and correct previous/next links.
5. Generated pages remain usable at desktop and mobile widths, without
   page-level horizontal overflow.
6. All internal DSA cross-links and table-of-contents anchors resolve.
7. The repository's required gates pass:

   ```bash
   python3 tools/check-python.py
   cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
   node tools/check-site.mjs
   ```

8. Any new DSA validation command also passes and is included in the documented
   local and CI verification flow.
9. `git status --porcelain` is empty after the completed implementation is
   committed, and no generated `site/` files are tracked.

## Non-Goals

- Expanding the DSA collection beyond the existing eight topics.
- Building interactive exercises, XP, streaks, saved progress, or account sync.
- Reusing the system-design challenge sidecar for coding problems.
- Replacing the site's shared visual identity with a separate DSA theme.
- Supporting arbitrary author-defined DSA metadata or front matter.
- Preserving incorrect snippets for backward compatibility.

## User-Requested Amendment

After implementation, the user requested that the rewritten C++ be removed while the
methodology prose and DSA-specific site UX remain. The original notebook snippets are
therefore preserved verbatim in `cpp legacy` fences. The DSA checker validates their
placement but does not compile them; ordinary `cpp` fences remain compiler-checked.
