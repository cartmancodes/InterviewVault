# InterviewVault — Technical Architecture

How the repository turns a folder of markdown into a deployed static site with a
client-side practice layer. This is the reference for changing the *machinery*;
[README.md](README.md) covers the library itself and [DEPLOY.md](DEPLOY.md) covers
publishing.

---

## 1. The shape of the system

One-way data flow, no database, no server-rendered request path:

```
LLD/**.md  DSA/**.md          content/challenges/*.json
     │                                  │
     ├──────────────┐                   │
     ▼              ▼                   │
check-python.py   render-diagrams.mjs   │
  (gate)            │                   │
                    ▼                   │
          site/assets/diagrams/*.svg    │
                    │                   │
                    └────► build-site.mjs ◄──── tools/template/*
                                │
                                ▼
                             site/                 ← gitignored build output
                                │
                                ├──► check-site.mjs   (gate)
                                └──► Cloudflare Worker (static assets)
```

Three properties fall out of this shape and are worth preserving:

- **The markdown is the only source of truth.** `site/` is disposable; it is
  `.gitignore`d and rebuilt from scratch on every CI run.
- **Pages ship without render-time JavaScript.** Mermaid runs at *build* time in
  headless Chrome, so an article is readable with JS disabled. The only client
  scripts are progressive enhancements (search filter, TOC highlighter, practice
  sidecar).
- **There is no registration step.** Dropping a `.md` file into a collection folder
  is the entire act of adding a document — the library, section nav, pager and
  sitemap all derive from a directory walk.

### Scale, as of this writing

| | |
|---|---|
| Documents | 122 across 10 collections |
| Pre-rendered diagrams | 607 unique |
| Authored challenge files | 28 |
| Build + client source | ~2,260 lines (`tools/`) |
| Runtime dependencies | none — 3 build-time (`marked`, `mermaid`, `puppeteer`) |

---

## 2. Repository layout

```
LLD/                          the vault — system design source markdown
  CoreConcepts/               → /notes/
  questions/                  → /answers/   (the only collection with a sidecar)
  SystemDesign/
    InaHurry/  CoreConcepts/  Patterns/  Patterns/QuickReference/
    DeepDives/  ProblemBreakdowns/  IntheWild/
DSA/                          → /dsa/   (C++ notes)

content/challenges/<slug>.json    hand-authored practice checkpoints

tools/
  check-python.py             gate: every ```python block parses
  render-diagrams.mjs         mermaid → SVG, content-hashed
  build-site.mjs              the generator
  gen-challenges.mjs          checkpoint extraction + merge
  check-site.mjs              gate: links, assets, anchors, script syntax
  template/                   design system + client runtime, copied verbatim
    site.css  vault.js  progress.js  home.js  doc.js
    favicon.svg  _headers  _redirects  robots.txt

site/                         build output — never hand-edit, never committed
.github/workflows/            build → validate → deploy
wrangler.toml                 Cloudflare Worker static-asset config
```

---

## 3. The build pipeline

Four stages. CI runs all four; a non-zero exit at any stage blocks the deploy.

```bash
python3 tools/check-python.py
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
node tools/check-site.mjs
```

### Stage 0 — `check-python.py`

Walks `LLD/**` and `DSA/**`, extracts every ` ```python ` block with a regex, and
runs `ast.parse` on each. Reports `path:line` plus the offending source line on
failure. It is a syntax gate only — nothing is imported or executed.

This exists because the vault's server-side code is Python by convention, and a
code block that does not parse is a doc bug that no other gate would catch.

### Stage 1 — `render-diagrams.mjs`

Extracts every ` ```mermaid ` block from `DOC_ROOTS`, keys each by
`sha1(source).slice(0, 16)`, and renders the ones that have no SVG on disk yet
through a single headless Chrome session.

The **content hash is the cache key**, which gives three useful behaviours:

- Editing prose around a diagram re-renders nothing.
- Editing a diagram renders exactly that one.
- Identical diagrams reused across docs render once and share an SVG.

Each SVG is post-processed to add `preserveAspectRatio` and to rewrite mermaid's
`max-width` into `max-width:Npx;width:100%;height:auto`, so diagrams keep their
intrinsic size but scale down responsively.

Mermaid's theme is pinned to the site's palette (`primaryColor #EEF3FF`,
`primaryBorderColor #2563EB`, `lineColor #5B7BB4`, IBM Plex Sans), so diagrams
match the page rather than looking pasted in.

**A diagram that fails to parse sets a non-zero exit code.** That is deliberate —
mermaid is stricter than it looks, and the two rules that cover nearly every
failure are: no `;` inside label or message text, and quote any label containing
brackets or parentheses.

> Chrome resolution: `CHROME_PATH`, else the macOS system Chrome path, else
> Puppeteer's bundled browser. CI installs the latter with
> `npx puppeteer browsers install chrome`.

### Stage 2 — `build-site.mjs`

The generator. Runs in three phases.

**Discovery.** For each entry in `COLLECTIONS`, `listMarkdown()` does a
*non-recursive* `readdirSync` of that one directory. Non-recursive matters:
`Patterns/` and `Patterns/QuickReference/` are separate collections, and a
recursive walk would double-count the latter. Each file yields a doc record —
`slug`, `title` (from the H1), `words`, `diagrams`, `images`, `col`, `url`, `out`.
A `byRel` map (repo-relative path → doc) is then built to resolve cross-links.

**Render.** `renderDoc()` runs a strictly ordered transform. The order is
load-bearing — several steps depend on an earlier one having already run:

| # | Step | Why it sits here |
|---|---|---|
| 1 | Strip the H1 | It becomes the page header; leaving it duplicates the title |
| 2 | Strip a hand-written "Table of Contents" section, and a stray `---` left behind | The right rail renders a live TOC instead |
| 3 | Extract mermaid blocks → `<div data-diagram=hash>` placeholders | Must happen **before** `marked.parse`, or the diagram source gets mangled as markdown |
| 4 | `marked.parse` (GFM) | |
| 5 | Add heading `id`s, collect the TOC | H2/H3 only; H4 gets an id but is excluded from the TOC. Duplicate slugs get a `-2` suffix |
| 6 | Rewrite `<img>` → copied asset under `/assets/docs/`, wrapped in `<figure>` with the alt text as `<figcaption>` | |
| 7 | Rewrite internal `.md` links → site URLs via `byRel`; fragments re-slugified | An unresolvable target is left as-is, and `check-site.mjs` then fails on it |
| 8 | Wrap `<table>` in `.tbl-wrap` | Gives wide tables their own horizontal scroll container |
| 9 | Inline the pre-rendered SVG at each placeholder | Inlined, not `<img src>`, so diagrams inherit page CSS and need no extra request |

Heading text is emoji-stripped and entity-decoded before slugifying, so
`## 🏗️ High-Level Design` becomes `#high-level-design` and the TOC shows clean
text.

**Emit.** Per-doc pages, the index, the vault map, then the template assets are
copied verbatim and `sitemap.xml` is written from `SITE_ORIGIN`.

### Stage 3 — `check-site.mjs`

Post-build validation over the emitted HTML:

- every root-relative `href`/`src` resolves to a real file on disk;
- every same-page `#anchor` has a matching `id` in that page;
- every `site/assets/*.js` parses (`new Function(src)`).

The script check is there because a syntax error in `vault.js` would silently kill
the practice sidecar on every answer page while the site still looked fine.

---

## 4. Document model and routing

The folder decides everything — URL, section nav, and whether a sidecar is built.

| Source folder | Section key | URL | Sidecar |
|---|---|---|---|
| `LLD/SystemDesign/InaHurry/` | `in-a-hurry` | `/in-a-hurry/<slug>/` | — |
| `LLD/CoreConcepts/` | `notes` | `/notes/<slug>/` | — |
| `LLD/SystemDesign/CoreConcepts/` | `concepts` | `/concepts/<slug>/` | — |
| `LLD/SystemDesign/Patterns/QuickReference/` | `quickref` | `/patterns/quick-reference/<slug>/` | — |
| `LLD/SystemDesign/Patterns/` | `patterns` | `/patterns/<slug>/` | — |
| `LLD/SystemDesign/DeepDives/` | `deep-dives` | `/deep-dives/<slug>/` | — |
| `LLD/SystemDesign/ProblemBreakdowns/` | `breakdowns` | `/breakdowns/<slug>/` | — |
| `LLD/SystemDesign/IntheWild/` | `in-the-wild` | `/in-the-wild/<slug>/` | — |
| **`LLD/questions/`** | `answers` | `/answers/<slug>/` | **yes** |
| `DSA/` | `dsa` | `/dsa/<slug>/` | — |

`quickref` is deliberately excluded from the header nav — it is reachable from the
library and from Patterns, and listing it twice would clutter a nav that is already
nine items wide.

### Slug derivation

`fileSlug()` drops a leading `Design `, splits camelCase, lowercases, and collapses
non-alphanumerics to single hyphens:

```
Design Bitly.md          → bitly              → /answers/bitly/
Design FB News Feed.md   → fb-news-feed       → /answers/fb-news-feed/
Multi-StepProcesses.md   → multi-step-processes
```

**Renaming a file changes its URL and breaks inbound links.** Grep for the old slug
first; `check-site.mjs` catches internal breakage but cannot see external links.

### Heading contracts

The build reads structure out of heading text. A doc that ignores these still
renders — it just silently loses a feature.

| Feature | Requires |
|---|---|
| Right-rail TOC | any `##` / `###` (H4 excluded) |
| Deep-dive level list | `## Deep Dives` with `###` children (first 10) |
| Win-conditions checkpoint | `## Insider Tips…` with H3s, **or** `## Key Takeaways` bullets — needs ≥3 |
| Requirements-triage checkpoint | `### Functional Requirements` with an in-scope and an out-of-scope label — needs ≥2 each side |

> The `onboard-doc` skill also lists `## Expected Depth by Level` as driving the
> tier tabs. It does not: nothing in `tools/` reads that heading. The Mid /
> Senior / Staff+ tabs come from the hardcoded `TIERS` array in `vault.js`, and a
> checkpoint's visibility comes from its own `tier` field. The heading is a useful
> authoring convention, not a build contract.

---

## 5. The challenge system

Every `/answers/` page gets a practice sidecar. Its checkpoints come from two
sources, merged in `gen-challenges.mjs` at build time.

### Source A — extracted from the markdown

Two mechanics are derived from prose the author already wrote, so they cost nothing
to maintain and exist for all 28 answer docs:

- **`triage`** — parses the `### Functional Requirements` section, splits it on
  whatever marks the below-the-line half (`**Out of scope**`, `#### Below the Line`,
  …), and turns each list item into a chip. Items are condensed to ~96 chars with
  leading filler stripped (`A user can submit…` → `Submit…`), then **interleaved**
  core/below so the answer pattern is not a giveaway. Bails out under 2 items a side.
- **`recall`** — pulls H3s from `## Insider Tips and Tricks`, falling back to bullets
  under `## Key Takeaways`. Bails out under 3 items.

Also extracted: `levels`, the first 10 H3s under `## Deep Dives`, shown as the
sidecar's collapsible list.

### Source B — hand-authored JSON

Four mechanics cannot be derived from headings and live in
`content/challenges/<slug>.json` — one file per doc, 28 files, each with all four:

| Type | Shape | Scored on |
|---|---|---|
| `duel` | two options with verdicts, plus a `defend` follow-up | picking the right option, then which costs you can name |
| `ladder` | ordered rungs of multiple-choice capacity estimates | fraction of rungs correct |
| `builder` | `palette` of 9 components, `slots` with an `accept` each | fraction of slots filled correctly |
| `bottleneck` | 4 metric cards with `state`, one `answer`, per-card `wrong` explanations | correct on first pick |

### The merge rule

Checkpoints are keyed by `id`; **authored wins on collision**, then the set is
sorted by tier (`mid` → `senior` → `staff`). So a doc can override its
auto-extracted `requirements` checkpoint by authoring one with the same id.

Malformed JSON throws with the filename — it fails the build rather than silently
dropping a doc's challenges.

---

## 6. The client runtime

Three independent scripts, each guarded so a missing element is a no-op rather than
an error.

| Script | Loaded on | Job |
|---|---|---|
| `doc.js` | every doc page | IntersectionObserver highlights the TOC entry for the section on screen |
| `home.js` | index | text + collection-chip filtering, `/` to focus search, Esc to clear |
| `vault.js` | answer pages with checkpoints | the practice sidecar and all six mechanics |
| `progress.js` | `/progress/` | the vault map, reading the same blob `vault.js` writes |

### Storage

One `localStorage` key, versioned, no network:

```js
'iv.progress.v1' → {
  v: 1,
  xp: 0,
  tier: 'senior',                          // last selected tab
  docs: { '<slug>': { cp: { '<id>': { done: true, score: 0.8 } } } },
  streak: { last: '2026-07-26', n: 3 },
}
```

Scores only — no wrong-answer history. A `v` mismatch or a parse failure falls back
to a fresh object rather than throwing, and writes are wrapped in `try/catch` so
private-browsing mode degrades to a working-but-unsaved session.

**XP is only ever paid on improvement.** `award()` compares against the previous
score for that checkpoint and credits `xp * (new − old)`, so replaying a checkpoint
you already aced grants nothing and cannot be farmed.

Levels widen geometrically — 120 XP for L2, then ×1.35 per level, capped at L20.

### Mechanic contract

Each mechanic is a function `(cp, done) => HTMLElement` that calls
`done(scoreFraction)` exactly once when resolved. They are registered in one map:

```js
var MECHANICS = { triage, recall, duel, ladder, builder, bottleneck };
var WIDTH     = { builder: 'wide', bottleneck: 'wide' };
```

Adding a mechanic means writing that function, adding a key, and styling it — no
change to the sidecar or the scoring path.

### Why mechanics open in an overlay

The sidecar is a HUD: level, tier tabs, checkpoint list, streak. The mechanics
themselves open in a focused modal (`openMechanic`) because a pipeline builder laid
out left-to-right and a 4-card metrics grid cannot be read in a rail. `WIDTH` marks
those two as `wide` (1180px vs 780px). The overlay is a real dialog —
`role="dialog"`, `aria-modal`, focus moved in on open and returned to the triggering
button on close, Esc and backdrop-click to dismiss, `body.mech-open` locking scroll.

Below 1180px the rail is replaced by a bottom sheet driven by a floating **Practice**
button, and the mechanics' own responsive rules take over inside it.

---

## 7. The design system

An engineering-blueprint identity: IBM Plex Sans (UI) / Serif (long-form prose) /
Mono (data, labels, counts), a single blue accent, and a faint drafting grid on hero
surfaces. All of it is one hand-written stylesheet — no framework, no build step for
CSS.

### Tokens

```css
--ink #0E1A2B   --ink-2 #3A4A61   --mut #6B7C96
--blue #2563EB  --blue-deep #1D4ED8  --blue-wash #F0F4FF
--grid #DCE4F7  --rule #E4EAF5  --soft #F2F5FB  --paper #FFFFFF
--amber #F59E0B --good #10B981

--shell 1240px          site frame
--side-w / --rail-w / --doc-gap    doc-page columns
```

### The doc frame

Doc pages run three columns and carry `body.doc`, which widens `--shell` to 1460px.
Because the header, footer and content grid all read the same token, the whole page
stays on one alignment — the home page keeps the narrower 1240px frame.

| Viewport | Layout | Rail |
|---|---|---|
| > 1400px | `228px │ 1fr │ 348px` | full instrument panel |
| ≤ 1400px | `206px │ 1fr │ 306px` | narrowed a step |
| ≤ 1180px | `200px │ 1fr` | folds to a bottom sheet |
| ≤ 800px | single column | sibling nav becomes a wrapped pill row |

The rail is sized as an instrument panel rather than a margin note: it holds a level
meter, three tier tabs, up to six checkpoint rows and a streak footer. At the old
210px every checkpoint title and XP label wrapped to two lines; at 348px they sit on
one, and the START affordance lines up in a consistent column.

`.doc-shell > main, .doc-shell > main > * { min-width: 0 }` is load-bearing — grid
items default to `min-width: auto`, so one wide diagram or code block would
otherwise stretch the column and push the whole page into horizontal scroll.

---

## 8. Deployment

`.github/workflows/` on push, PR, or manual dispatch:

**build job** — checkout → Node 20 with `tools/package-lock.json` npm cache →
`npm ci` → install Chrome for Puppeteer → **restore the diagram cache** →
the four gates → upload `site/` as an artifact.

The diagram cache is keyed on `hashFiles('LLD/**/*.md', 'DSA/**/*.md')` with a
`diagrams-` restore prefix, so an exact hit skips rendering entirely and a partial
hit re-renders only what changed. This is what keeps a 607-diagram build fast.

**deploy job** — gated on `push` to `master`, so pull requests build and validate but
never publish. Downloads the artifact and runs `wrangler deploy`.

### Serving

A Cloudflare Worker with **no script** — `wrangler.toml` points `[assets]` at
`./site` and Cloudflare serves it directly. `html_handling = "auto-trailing-slash"`
maps `/answers/bitly/` to that directory's `index.html`.

`not_found_handling = "404-page"` is configured but **has nothing to serve** — the
build never emits a `site/404.html`, so unmatched paths fall back to Cloudflare's
default response. Emitting one from `build-site.mjs` would close the gap.

`_headers` sets a year-long immutable cache on `/assets/*`, drops the mutable
`site.css` / `home.js` / `doc.js` to one hour, and applies `nosniff`,
`strict-origin-when-cross-origin` and `SAMEORIGIN` site-wide. Both `_headers` and
`_redirects` are carried over from the earlier Cloudflare Pages setup.

`SITE_ORIGIN` is `https://cartmancodes.com` in CI and defaults to the
`pages.dev` host locally; it only affects `sitemap.xml`.

---

## 9. Invariants

Things that will bite if broken:

1. **Never edit `site/`.** `build()` deletes and regenerates every section directory
   on each run. Hand edits are lost without warning.
2. **Commit new files promptly.** `site/` is gitignored and untracked work has been
   lost to `git clean` in this repo before. `git status --porcelain` should be empty
   when a task is finished.
3. **Language conventions are semantic, not cosmetic.** Server-side code under
   `LLD/` is Python and `DSA/` is C++; browser code stays `javascript`, Redis scripts
   `lua`, SQL `sql`. Converting them makes the docs wrong.
4. **Mermaid must parse** — a failing block fails the build (see Stage 1).
5. **Mechanics must call `done()` exactly once**, or the checkpoint never scores.
6. **`marked` runs after mermaid extraction**, never before.

### Known rough edges

- `site/assets/` is **not** cleaned between builds, only the section directories.
  Orphaned diagram SVGs accumulate — there is currently one on disk with no
  referencing doc (608 files, 607 live). Harmless, but the count drifts.
- `collectionFor()` in `build-site.mjs` and `authoredSlugs()` in
  `gen-challenges.mjs` are both dead — nothing calls them.
- `buildIndex()` contains a no-op `map.replace(…, (m) => m)` left from an earlier
  approach to injecting doc counts.
- `check-site.mjs` validates root-relative URLs only; external links are unchecked.

---

## 10. Extension points

**Add a document** — drop a `.md` into a collection folder, write the H1 and the
heading contracts from §4, rebuild. Nothing to register.

**Add practice challenges** — create `content/challenges/<slug>.json` with a
`checkpoints` array. The slug must match the doc's derived slug. Rebuild; the
sidecar picks it up.

**Add a mechanic** — write `(cp, done) => node` in `vault.js`, register it in
`MECHANICS`, add it to `WIDTH` if it needs the wide overlay, and style it in
`site.css`. Nothing else changes.

**Add a collection** — append to the `COLLECTIONS` array in `build-site.mjs` (place
more specific paths before their parents) and add the section directory to the
cleanup list in `build()`. The header nav, library, section pager and sitemap all
follow automatically.

**Change the design** — everything visual is `tools/template/site.css`. It is copied
verbatim into `site/assets/`, so a CSS-only change needs `build-site.mjs` but not a
re-render of diagrams.
