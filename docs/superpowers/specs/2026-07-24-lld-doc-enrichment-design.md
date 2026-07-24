# LLD Documentation Enrichment — Design Spec

**Date:** 2026-07-24
**Scope:** `LLD/questions/` (28 docs) + `LLD/SystemDesign/` (70 docs) = 98 docs
**Goal:** Raise both collections to the visual + structural quality of the gold-standard `LLD/CoreConcepts/` docs.
**Non-goal:** Do NOT edit `LLD/CoreConcepts/` (it is the reference standard). Do NOT invent facts.

---

## 1. The Gold Standard (reference)

`LLD/CoreConcepts/*.md` establish the bar. Their DNA:

- Emoji-prefixed H2 section headers.
- A `> **Core Concept**: …` callout directly under the title.
- A `## 🧒 Layman's Explanation` section (plain-language analogy).
- Heavy use of **mermaid** diagrams (13–47 per doc): `graph TB`, `graph LR`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`.
- `## 🎓 Key Takeaways`, `## 📝 Conclusion`, `## 📚 Related Concepts` at the end.
- `⚠️` / `💡` / `📖` callouts (blockquotes) for gotchas, tips, definitions.

---

## 2. Emoji Legend (use consistently)

| Emoji | Meaning |
|---|---|
| 📋 | Table of Contents |
| 🎯 | Overview / core goal |
| 🧒 | Layman's Explanation |
| 🏗️ | Architecture / high-level design |
| 🔑 | Core entities / keys |
| 🔌 | API design |
| 🔬 / 🔎 | Deep dives |
| 📈 | Scaling |
| ⚠️ | Pitfall / gotcha (callout) |
| 💡 | Insider tip (callout) |
| 📖 | Definition (callout) |
| 🏭 | Production / real-world |
| 🎤 | Interview strategy |
| 🎓 | Key takeaways |
| 📝 | Conclusion |
| 📚 | Related concepts |

---

## 3. Mermaid Style Guide

Match the gold standard exactly.

**Diagram types by purpose:**
- System architecture / components → `graph TB` (with `subgraph "Group"` blocks).
- Request/data flow, left-to-right pipelines → `graph LR`.
- Client/server/service interactions over time → `sequenceDiagram`.
- Entity lifecycle (orders, rides, jobs) → `stateDiagram-v2`.
- Data model / relationships → `erDiagram`.

**Conventions:**
- Multi-line node labels use `<br/>`: `R[(Redis<br/>In-Memory<br/>Single-Threaded)]`.
- Group related nodes with `subgraph "Name" … end`.
- Semantic color palette via `style NODE fill:#HEX`:
  - `#90EE90` green = solution / good / chosen path
  - `#FFB6C1` pink = problem / bottleneck / failure
  - `#FFE4B5` orange = intermediate / caution / scaling step
  - `#e1f5ff` blue = data store / table / cache
  - `#f3e5f5` purple = external / third-party service
  - `#e8f5e9` light-green tint, `#fff4e1` light-yellow = neutral groupings
- Every diagram MUST be valid mermaid that renders (verified in §6).

---

## 4. Profile A — `LLD/questions/` (28 docs)

**Text is already strong. Add the visual + callout layer; preserve all existing content and section order.**

Required additions:
1. `> **Summary**: …` callout under the H1 (one-paragraph problem essence), keeping the existing Pattern/Difficulty/Source blockquote.
2. Add emoji to existing H2 headers per the legend (e.g. `## High-Level Design` → `## 🏗️ High-Level Design`). Do not rename sections.
3. Insert mermaid diagrams grounded ONLY in the existing text:
   - **High-Level Design**: one `graph TB` architecture diagram of the components already described.
   - **1–3 key Deep Dives**: a `sequenceDiagram` or `stateDiagram-v2` for the flows/state machines the text already explains (e.g. Uber dispatch, ride state machine).
   - **Scaling Journey**: optional `graph LR` showing the evolution stages already listed.
   - Target **4–8 diagrams total**. Quality over quantity — only diagram what the text supports.
4. Convert existing inline gotchas/insider tips into `⚠️` / `💡` blockquote callouts where natural (do not remove the prose).
5. Ensure a `## 📚 Related Concepts` section exists at the end, cross-linking to relevant `../CoreConcepts/*.md` and `../SystemDesign/**/*.md` docs.
6. Fix TOC anchors to match the (now emoji-prefixed) headers. GitHub anchors: lowercase, strip emoji, spaces→hyphens.

**Preserve:** every existing sentence of substance, the Deep Dives, Scaling Journey, Insider Tips, Expected Depth by Level.

---

## 5. Profile B — `LLD/SystemDesign/` (70 docs)

**Plain scraped conversions. Restructure to the gold scaffolding; keep existing SVG diagrams.**

Required additions:
1. `## 📋 Table of Contents` after the title, linking every H2.
2. `> **Overview**: …` callout under the title (2–3 sentences from the intro).
3. `## 🧒 Layman's Explanation` — plain-language analogy for the page's topic, grounded in its content.
4. Add emoji to section headers per the legend.
5. **Keep every existing `![...](assets/*.svg)` image** — these are HelloInterview's original diagrams and are high value. Do not delete or replace them with mermaid. Optionally add a 1-line italic caption if missing.
6. Where the text describes a flow/architecture the SVGs don't cover, a mermaid diagram MAY be added — but SVGs take priority; do not duplicate what an SVG already shows.
7. `## 🎓 Key Takeaways` (3–6 bullets) + `## 📚 Related Concepts` (cross-links) before the existing source footer.
8. Keep the existing `--- *Source: …*` footer at the very bottom.

**Preserve:** all existing prose, tables, code blocks, and SVG image references.

---

## 6. Quality Guardrails (all docs)

- **Accuracy:** every added diagram/explanation derives ONLY from the target doc's existing content. No new numbers, components, or claims. When unsure, add less.
- **Render check:** every mermaid block must parse. Verification pass runs `@mermaid-js/mermaid-cli` (mmdc) or the mermaid parser over each block; any that fail are fixed before the doc is considered done.
- **Idempotent structure:** if a section (e.g. Layman's, Related Concepts) already exists, enhance it — don't duplicate.
- **Consistency:** identical emoji legend, section naming, and mermaid palette across all 98 docs.
- **Links valid:** cross-links in Related Concepts must point to files that exist.

---

## 7. Execution Plan

1. **Pilot (main session):** hand-build 1 Profile-A doc (`Design Uber.md`) and 1 Profile-B doc (a SystemDesign page). Present diffs for approval.
2. **Batch (ultracode Workflow):** after approval, pipeline over the remaining 96 docs — `enrich(doc)` → `verify-render + verify-accuracy(doc)` — parallel, grounded per-doc.
3. **Final verification:** repo-wide mermaid render check + broken-link check; report counts.

---

## 8. Success Criteria

- All 98 docs carry the emoji scaffolding, a Layman's/Summary callout, Key Takeaways, and Related Concepts.
- `questions/` docs each gain 4–8 valid, content-grounded mermaid diagrams.
- `SystemDesign/` docs each gain a TOC + scaffolding while retaining all SVGs.
- Zero mermaid render failures; zero broken cross-links.
- `LLD/CoreConcepts/` untouched.
