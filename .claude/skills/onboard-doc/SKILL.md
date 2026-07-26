---
name: onboard-doc
description: Use when adding, moving, renaming or restructuring any document in the InterviewVault markdown vault (LLD/**, DSA/**), or when adding practice challenges. Covers the collection layout, the heading contracts the build extracts from, mermaid and code-block rules, cross-linking, and the verification gates.
---

# Onboarding a document into InterviewVault

The markdown **is** the source of truth. `site/` is generated and gitignored — never
edit it. The build reads structure out of the headings you write, so a doc that ignores
the contracts below still renders, but silently loses its table of contents, its practice
checkpoints, or its place in the library.

## 1. Pick the collection

The folder decides the URL, the section nav, and whether the doc gets a practice sidecar.

| Folder | URL | Sidecar |
|---|---|---|
| `LLD/SystemDesign/InaHurry/` | `/in-a-hurry/<slug>/` | no |
| `LLD/CoreConcepts/` | `/notes/<slug>/` | no |
| `LLD/SystemDesign/CoreConcepts/` | `/concepts/<slug>/` | no |
| `LLD/SystemDesign/Patterns/` | `/patterns/<slug>/` | no |
| `LLD/SystemDesign/Patterns/QuickReference/` | `/patterns/quick-reference/<slug>/` | no |
| `LLD/SystemDesign/DeepDives/` | `/deep-dives/<slug>/` | no |
| `LLD/SystemDesign/ProblemBreakdowns/` | `/breakdowns/<slug>/` | no |
| `LLD/SystemDesign/IntheWild/` | `/in-the-wild/<slug>/` | no |
| **`LLD/questions/`** | `/answers/<slug>/` | **yes** |
| `DSA/` | `/dsa/<slug>/` | no |

Adding a file to one of these is the whole registration step — the library, the section
nav and the sitemap pick it up on rebuild. There is no index to hand-edit.

**Slug** comes from the filename: drop a leading `Design `, split camelCase, lowercase,
non-alphanumerics to hyphens.

```
Design Bitly.md          -> bitly           -> /answers/bitly/
Design FB News Feed.md   -> fb-news-feed    -> /answers/fb-news-feed/
Multi-StepProcesses.md   -> multi-step-processes
```

Renaming a file changes its URL and breaks inbound links. Grep for the old slug first.

## 2. Write the page shell

```markdown
# 🎯 Doc Title

> **Overview**: two or three sentences on what this is and why it matters.

## 🧒 Layman's Explanation

A plain-language analogy, grounded in this doc's own content.

## 🏗️ First real section
...

## 🎓 Key Takeaways
- ...

## 📚 Related Concepts
- [Caching](../CoreConcepts/Caching.md) — why it's relevant here.
```

- The **H1 becomes the page header** and is stripped from the body — don't repeat it.
- **Do not hand-write a "Table of Contents" section.** The build strips it and renders a
  live TOC in the right rail from your H2/H3s.
- Emoji in headings are fine — they are stripped from the TOC, nav and anchors.

## 3. Heading contracts the build depends on

These are load-bearing. Match the wording or the feature silently disappears.

| Feature | Needs | Notes |
|---|---|---|
| Right-rail TOC | any `##` / `###` | `####` is excluded |
| Deep-dive level list | `## Deep Dives` with `###` children | first 10 |
| Win conditions checkpoint | `## Insider Tips…` (H3s) **or** `## Key Takeaways` (bullets) | needs ≥3 |
| Requirements triage checkpoint | see below | needs ≥2 each side |
| Tier tabs | `## Expected Depth by Level` | Mid / Senior / Staff+ |

**Requirements triage** reads the doc's own scope lists. Put them under a
`### Functional Requirements` heading, with an above-the-line label and a below-the-line
label. All three of these forms work:

```markdown
### Functional Requirements

**In scope (core):**          **Core**            #### Core Requirements
1. ...                        - ...               1. ...

**Out of scope:**             **Out of scope (below the line)**   #### Below the Line (Out of Scope)
1. ...                        - ...               1. ...
```

Items are condensed to ~96 chars for the chips, so lead each one with the substance.

## 4. Mermaid

Every ` ```mermaid ` block is pre-rendered to SVG by headless Chrome at build time. A
block that fails to parse **fails the build**.

Two rules prevent nearly every failure:

- **No `;` inside label, message or note text** — use a comma.
- **Quote any label containing brackets, parentheses or other punctuation:**
  `A["Write WAL (log): 1 I/O"]`, `IT["Inbox<br/>clientId -> [msgs]"]`, edge labels too:
  `-->|"a: [x, y]"|`.

Also: `erDiagram` accepts only `PK` / `FK` / `UK` as key types — put anything else
(`SK`) in the quoted comment. Use `<br/>` for line breaks, and the house palette:

| Colour | Means |
|---|---|
| `#90EE90` | solution / chosen path |
| `#FFB6C1` | problem / bottleneck |
| `#FFE4B5` | intermediate / scaling step |
| `#e1f5ff` | datastore / cache |
| `#f3e5f5` | external service |

## 5. Code blocks

**Always tag the language.** Untagged blocks render as plain text and are invisible to
the checker.

- **Under `LLD/`, server-side code is Python.** Every ` ```python ` block must parse under
  `ast.parse` — this is a build gate.
- **Under `DSA/`, code stays C++.**
- Leave these in their real language, tagged honestly: browser code (`javascript` —
  Python cannot run in a browser), Redis scripts (`lua`), SQL/CQL (`sql`), config
  (`json`, `yaml`, `bash`, `http`). Converting them would make the doc wrong.

## 6. Links and images

- Cross-links are **relative markdown paths to the `.md` file**; the build rewrites them
  to site URLs. From `LLD/questions/` → `../CoreConcepts/Caching.md`; from
  `LLD/SystemDesign/DeepDives/` → `../../CoreConcepts/Caching.md`.
- A link to a file that does not exist **fails the build**.
- Images live beside the doc in `assets/` and are referenced relatively:
  `![Caption](assets/thing.svg)`. The build copies them and rewrites the path.

## 7. Practice challenges (`LLD/questions/` only)

Two sources, merged at build time; authored checkpoints override extracted ones with the
same `id`.

- **Extracted free** from the doc: `requirements` (triage) and `recall` (win conditions).
- **Authored** in `content/challenges/<slug>.json`: `duel`, `ladder`, `builder`,
  `bottleneck`. See `content/challenges/bitly.json` for the full reference.

```jsonc
{
  "slug": "bitly",
  "checkpoints": [
    { "id": "tradeoff", "type": "duel", "tier": "senior", "title": "...", "xp": 80,
      "prompt": "...", "options": [ { "label": "...", "correct": true, "verdict": "..." } ],
      "defend": { "prompt": "...", "options": [ { "label": "...", "correct": true } ] } },
    { "id": "capacity", "type": "ladder", "tier": "senior", "xp": 70,
      "rungs": [ { "q": "...", "choices": ["a","b"], "answer": 1, "note": "..." } ] },
    { "id": "architecture", "type": "builder", "tier": "staff", "xp": 100,
      "palette": ["Browser","CDN edge"], "slots": [ { "accept": "Browser" } ] },
    { "id": "bottleneck", "type": "bottleneck", "tier": "staff", "xp": 90,
      "cards": [ { "name": "Redis", "metric": "hit 61%", "delta": "-34pt", "state": "warn" } ],
      "answer": "Redis", "explain": "...", "wrong": { "Postgres": "why not" } }
  ]
}
```

`tier` is one of `mid` / `senior` / `staff` — a tier shows its own checkpoints plus every
lower one. Ground every question in the doc's real content; invented numbers are worse
than no challenge. Keep intensity low: the reward is an honest score, not confetti.

## 8. Build and verify

Run all four before calling it done. CI runs the same set, and any failure blocks deploy.

```bash
python3 tools/check-python.py                    # every ```python block parses
cd tools && node render-diagrams.mjs             # every mermaid block renders
node build-site.mjs && cd ..                     # markdown -> site/
node tools/check-site.mjs                        # links, assets, anchors, client JS
```

Preview: `cd site && python3 -m http.server 8899`.

Only new or changed diagrams re-render; the rest come from the content-hash cache.

## 9. Before finishing

- [ ] File is in the right collection folder; slug reads well
- [ ] No hand-written Table of Contents section
- [ ] Scope lists / Insider Tips present if it is a `questions/` doc
- [ ] Every code fence tagged; Python parses; browser JS and Lua left alone
- [ ] Mermaid: no `;` in text, brackets quoted
- [ ] Cross-links resolve; images in `assets/` beside the doc
- [ ] All four gates green
- [ ] **Commit the new files.** Untracked files have been lost to `git clean` in this
      repo before — `git status --porcelain` should be empty when you are done.
