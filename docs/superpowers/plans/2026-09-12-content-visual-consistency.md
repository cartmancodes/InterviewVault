# Content Visual Consistency Implementation Plan

> **For agentic workers:** Use Superpowers subagent-driven-development for bounded
> independent tasks; the primary agent integrates and verifies the whole change.

**Goal:** Consistent, comprehensible content figures with selective isometric views
and accessible, opt-in explanatory animation.

**Architecture:** Shared theme and figure presentation in the static generator.
Source assets retain meaning and geometry. Authored walkthroughs attach to selected
figures, with static fallbacks. An inventory records coverage and review findings.

**Tech Stack:** Markdown, Mermaid, SVG, Node, browser JavaScript, Puppeteer.

## Tasks

- [x] Audit all source references using `tools/audit-visuals.mjs`; record document,
  section, format, captions, file existence, SVG labels and palette. Render contact
  sheets for visual review, distinguish diagrams from screenshots, and record
  explicit dispositions in `docs/visual-audit.md`.
- [x] Add `tools/diagram-theme.mjs` for shared colours and Mermaid configuration.
  Normalize known legacy colour families without collapsing success/failure
  distinctions. Add tests in `tools/visuals.test.mjs` for theme-dependent hashes,
  preservation of labels and colour-role distinctions. Run `node --test
  tools/visuals.test.mjs` before and after implementation.
- [x] Update `tools/render-diagrams.mjs` to include theme configuration in cache
  keys, use the shared theme, wait for fonts and support all current diagram types.
  Add accessible descriptions using source section context during page generation.
- [x] Review and normalize imported diagram SVGs with a reproducible source tool;
  retain geometry and captions, use legible typography with measured bounds, and
  preserve screenshots/logos. Verify XML, labels and all reference targets.
- [x] Add common figure markup in `tools/build-site.mjs`, consistent figure styles
  in `tools/template/figures.css`, and keyboard-accessible enlargement in
  `tools/template/figures.js`. Ensure fallback links work without JavaScript.
- [x] Author selective isometric SVGs and explanatory walkthrough metadata in
  `content/visuals/`. Cover sharding/replicas, cache flow, queue delivery and BFS
  with explicit states and descriptions grounded in their source chapters.
  Expose play/pause, previous/next/reset, reduced-motion behavior and complete
  static fallbacks. Never animate an inferred execution sequence.
- [x] Run browser checks for figure loading, layout, keyboard dialog operation,
  step controls, pause, reduced motion and no-JavaScript at 1440, 700 and 320px.
  Review source changes for technical meaning and inspect rendered contact sheets.
- [x] Run `node tools/check-dsa.mjs`, `python3 tools/check-python.py`,
  `node tools/check-motion.mjs`, `node tools/render-diagrams.mjs`,
  `node tools/build-site.mjs`, and `node tools/check-site.mjs`.
- [x] Record verified coverage, commit source changes and report remaining limits.
