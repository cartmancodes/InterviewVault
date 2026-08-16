# InterviewVault — Technical Architecture

How the repository turns a folder of markdown into a deployed static site with a
client-side practice layer. This is the reference for changing the *machinery*;
[README.md](README.md) covers the library itself and [DEPLOY.md](DEPLOY.md) covers
publishing.

---

## 1. The shape of the system

One-way data flow, no database, no server-rendered request path:

```
LLD/**.md  DSA/**.md                content/challenges/*.json
     │         │                              │
     │         ├──► check-dsa.mjs   (gate)    │
     ├─────────┤                              │
     ▼         ▼                              │
check-python.py   render-diagrams.mjs         │
  (gate)            │                         │
                    ▼                         │
          site/assets/diagrams/*.svg          │
                    │                         │
                    └────► build-site.mjs ◄───┴─── tools/template/*  tools/dsa-config.mjs
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
  sidecar, the front-page mini-game).
- **There is no registration step.** Dropping a `.md` file into a collection folder
  is the entire act of adding a document — the library, section nav, pager and
  sitemap all derive from a directory walk.

### Scale, as of this writing

| | |
|---|---|
| Documents | 123 across 10 collections |
| Pre-rendered diagrams | 619 unique |
| Authored challenge files | 33 (28 interview answers + 5 deep dives) |
| Build + client source | ~4,420 lines (`tools/`) |
| Runtime dependencies | none — 3 build-time (`marked`, `mermaid`, `puppeteer`) |

The document and diagram counts are the two the build prints on every run
(`built 123 pages`, `619 unique diagrams`), so they are worth re-reading off a
build rather than trusting this table.

---

## 2. Repository layout

```
LLD/                          the vault — system design source markdown
  CoreConcepts/               → /notes/
  questions/                  → /answers/   (the only collection with a sidecar)
  SystemDesign/
    InaHurry/  CoreConcepts/  Patterns/  Patterns/QuickReference/
    DeepDives/  ProblemBreakdowns/  IntheWild/
DSA/                          → /dsa/   (an ordered C++ interview track)

content/challenges/<slug>.json    hand-authored practice checkpoints

tools/
  check-dsa.mjs               gate: DSA chapter contract, links, C++17 syntax
  check-dsa.test.mjs          unit tests for that gate
  check-python.py             gate: every ```python block parses
  check-motion.mjs            gate: every looping landing-page animation binds
                              --amb, so the motion pause button is not a lie
  dsa-config.mjs              DSA study metadata: order, pattern, difficulty
  render-diagrams.mjs         mermaid → SVG, content-hashed
  build-site.mjs              the generator
  gen-challenges.mjs          checkpoint extraction + merge
  check-site.mjs              gate: links, anchors, script syntax, challenge
                              contract, DSA page assertions
  template/                   design system + client runtime, copied verbatim
    site.css  vault.js  progress.js  home.js  doc.js  game.js
    favicon.svg  cartman.png  _headers  _redirects  robots.txt

site/                         build output — never hand-edit, never committed
.github/workflows/            build → validate → deploy
wrangler.toml                 Cloudflare Worker static-asset config
```

---

## 3. The build pipeline

Six stages. CI runs all six; a non-zero exit at any stage blocks the deploy.

```bash
node tools/check-dsa.mjs
python3 tools/check-python.py
node tools/check-motion.mjs
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
node tools/check-site.mjs
```

### Stage 0a — `check-dsa.mjs`

The DSA collection is a *contract-checked* track, not free-form notes. For every
`DSA/*.md` the gate enforces:

- exactly one H1, and the H2 sequence must equal `REQUIRED_DSA_SECTIONS` from
  `dsa-config.mjs`, in order: At a Glance → Interview Method → How It Works →
  Reusable C++ Template → Worked Problems → Failure Modes → Recall Drill →
  Related Topics;
- a `dsa-config.mjs` entry exists for the slug, and no two chapters claim the
  same study-order position;
- every relative `.md` link resolves, and no code fence is untagged;
- every plain ` ```cpp ` block passes `c++ -std=c++17 -Wall -Wextra -pedantic
  -fsyntax-only`. Blocks tagged ` ```cpp legacy ` are preserved verbatim and
  skipped — they are the original notebook snippets, kept as written.

`node tools/check-dsa.mjs DSA/BFS.md` runs a focused check for one file;
`check-dsa.test.mjs` unit-tests the validator itself.

### Stage 0b — `check-python.py`

Walks `LLD/**` and `DSA/**`, extracts every ` ```python ` block with a regex, and
runs `ast.parse` on each. Reports `path:line` plus the offending source line on
failure. It is a syntax gate only — nothing is imported or executed.

This exists because the vault's server-side code is Python by convention, and a
code block that does not parse is a doc bug that no other gate would catch.

### Stage 0c — `check-motion.mjs`

The landing page animates forever, so WCAG 2.2.2 requires a mechanism to stop it.
That mechanism is a single custom property, `--amb`, which `portfolio.js` flips to
`paused` — and an animation obeys it only if its declaration binds it:

```css
animation: pf-sway 6s ease-in-out infinite var(--amb, running);
```

The gate parses `tools/template/site.css`, walks every style rule from the
`portfolio landing page` marker to EOF (descending into `@media`, skipping
`@keyframes`), and fails if a rule mentions `infinite` without also mentioning
`var(--amb`. No browser, no dependencies — a regex and a brace walk.

It exists because two classes of breakage shipped undetected. Animations that
never carried the binding at all, and — the one no diff makes visible — rules that
set `animation-play-state: var(--amb)` as a lone longhand and were then reset by a
**later `animation:` shorthand at equal specificity**, since the shorthand resets
every `animation-*` longhand it does not name. Binding inside the shorthand is
what makes the rule robust: the binding travels with the declaration.

SMIL `<animateMotion>` (`.pf-rabbit`, `.pf-pond`, `.pf-gondola`) is out of scope.
It is deaf to `animation-play-state` and is paused by `pauseAnimations()` on the
`<svg>` roots in `portfolio.js`; it declares no CSS animation, so the gate never
sees it. Timer-driven motion (the typing terminal) is out of scope too — it
subscribes to the `pf-motion` event that the toggle dispatches on `document`.

### Stage 1 — `render-diagrams.mjs`

Extracts every ` ```mermaid ` block from `DOC_ROOTS`, keys each by
`sha1(source).slice(0, 16)`, and renders the ones that have no SVG on disk yet
through a single headless Chrome session.

The **content hash is the cache key**, which gives three useful behaviours:

- Editing prose around a diagram re-renders nothing.
- Editing a diagram renders exactly that one.
- Identical diagrams reused across docs render once and share an SVG.

…and one sharp edge: **the hash covers the diagram source only, never the theme.**
Changing `themeVariables` or `themeCSS` invalidates nothing, so a re-theme must
`rm -rf site/assets/diagrams` and re-render all of them. The CI cache key in
`deploy.yml` therefore hashes `tools/render-diagrams.mjs` and
`tools/package-lock.json` alongside the markdown, and its `restore-keys` fallback
is scoped to the same renderer hash — otherwise a partial-hit restore would put
the pre-theme SVGs back and silently revert the change on the next deploy.

Each SVG is post-processed to add `preserveAspectRatio` and to rewrite mermaid's
`max-width` into `max-width:Npx;width:100%;height:auto`, so diagrams keep their
intrinsic size but scale down responsively.

Mermaid's theme is pinned to the site's construction-paper palette so diagrams
match the page rather than looking pasted in: `--acc-wash #FFF6C9` node fills,
`--paper` secondary fills, `--sky-wash #EAF5FD` subgraph clusters, `--ink
#0E1A2B` for every border, connector and label, and IBM Plex Sans. Mermaid has no
theme variable for stroke width, so a small `themeCSS` block takes node and
cluster outlines to the 2px cutout weight; mermaid emits it scoped to the
diagram's own `#m<hash>` id, so it cannot leak onto the vault map's `.node rect`.
Diagrams sit on the white article surface, never on a sky band, so labels stay
ink: 16.05:1 on the node fill, 15.80:1 on a cluster, 17.18:1 on the `.diagram`
inset.

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

**Emit.** Per-doc pages, the portfolio landing page, the vault home, the vault map,
then the template assets are copied verbatim and `sitemap.xml` is written from
`SITE_ORIGIN`.

### Stage 3 — `check-site.mjs`

Post-build validation over the emitted HTML. The original three checks:

- every root-relative `href`/`src` resolves to a real file on disk;
- every same-page `#anchor` has a matching `id` in that page;
- every `site/assets/*.js` parses (`new Function(src)`) — a syntax error in
  `vault.js` would otherwise silently kill the sidecar while the site looked fine.

Plus two contract sweeps added with the deep-dive challenges and the DSA track:

- **Authored-challenge contract.** Every `content/challenges/*.json` must contain
  exactly the four standard checkpoints with fixed ids, types, tiers and XP
  (`tradeoff`/duel/senior/80 · `capacity`/ladder/senior/70 ·
  `architecture`/builder/staff/100 · `bottleneck`/bottleneck/staff/90), each
  mechanic's payload is shape-checked (builder slots must accept palette members,
  bottleneck `wrong` keys must equal the non-answer cards, …), the filename must
  equal the inner slug, and the built target page must embed exactly one matching
  `iv-challenges` payload. A deep-dive page carrying a payload with no authored
  source is an error.
- **DSA page assertions.** Each configured chapter's page must exist, carry the
  `dsa-doc` body class, and render its study order, pattern and difficulty
  metadata.

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
| `LLD/SystemDesign/DeepDives/` | `deep-dives` | `/deep-dives/<slug>/` | if authored |
| `LLD/SystemDesign/ProblemBreakdowns/` | `breakdowns` | `/breakdowns/<slug>/` | — |
| `LLD/SystemDesign/IntheWild/` | `in-the-wild` | `/in-the-wild/<slug>/` | — |
| **`LLD/questions/`** | `answers` | `/answers/<slug>/` | **yes** |
| `DSA/` | `dsa` | `/dsa/<slug>/` | — |

Three pages come from no folder at all:

| URL | Built by | What it is |
|---|---|---|
| `/` | `buildPortfolio()` | The portfolio landing page — `body.portfolio`, its own nav and footer, no vault chrome |
| `/vault/` | `buildIndex()` | The vault home: hero, Packet Runner, architecture map, searchable library |
| `/progress/` | `buildProgressPage()` | The vault map — practice coverage, read from `localStorage` |

`/` is the front door and `/vault/` is the library, so **every "back to the library"
link routes through the `VAULT` constant** in `build-site.mjs` — the header brand,
the header nav, and the architecture-map nodes. Hard-coding `/` in any of them sends
the visitor to the portfolio instead.

`quickref` is deliberately excluded from the header nav — it is reachable from the
library and from Patterns, and listing it twice would clutter a nav that is already
nine items wide.

Sidecar rules differ by collection: an **answers** doc gets one whenever any
checkpoint exists (extracted or authored); a **deep-dives** doc gets one only when
an authored `content/challenges/<slug>.json` exists for it (currently cassandra,
flink, kafka, redis, zookeeper).

### The DSA track

`DSA/` is not an alphabetical folder of notes — it is an ordered study track. The
per-chapter metadata lives in code, in `tools/dsa-config.mjs`:

```js
DSA_TOPICS = { 'linked-lists': { order: 1, pattern: 'Pointer invariants',
                                 difficulty: 'Beginner', reviewMinutes: 12 }, … }
```

The build fails on a `DSA/*.md` whose slug has no entry here, so adding a chapter
is a two-file change (markdown + config). From this metadata the build derives:

- **ordering** — `docsForCollection()` sorts the DSA collection by `order`, which
  drives the section list, the prev/next pager and the numbered "DSA study track"
  side nav (`01`–`08`), instead of the filename order every other collection uses;
- **the meta strip** — order `05 / 08`, pattern, difficulty and review minutes
  render under the article header (`.dsa-meta`);
- **section decoration** — `decorateDsaSections()` wraps four of the contract
  headings in styled `<section>` shells: At a Glance (`dsa-summary`), Interview
  Method (`dsa-method`, with `01`–`08` step counters), Failure Modes
  (`dsa-warning`, amber), Recall Drill (`dsa-recall`, dashed). The wrapper keys on
  the heading's slugified id, so renaming a heading silently drops its styling —
  except the rename would fail `check-dsa.mjs` first, which is the point of
  enforcing the H2 sequence in a gate.

DSA pages carry `body.doc.dsa-doc`; the extra class scopes the track styling.

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

Every `/answers/` page — and the five deep dives with authored files — gets a
practice sidecar. Its checkpoints come from two sources, merged in
`gen-challenges.mjs` at build time.

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
`content/challenges/<slug>.json` — one file per doc, 33 files, each with all four:

| Id | Type | Tier · XP | Shape | Scored on |
|---|---|---|---|---|
| `tradeoff` | `duel` | senior · 80 | two options with verdicts, plus a `defend` follow-up | picking the right option, then which costs you can name |
| `capacity` | `ladder` | senior · 70 | ordered rungs of multiple-choice capacity estimates | fraction of rungs correct |
| `architecture` | `builder` | staff · 100 | `palette` of components, `slots` with an `accept` each | fraction of slots filled correctly |
| `bottleneck` | `bottleneck` | staff · 90 | metric cards with `state`, one `answer`, per-card `wrong` explanations | correct on first pick |

The ids, types, tiers and XP values are a **fixed contract** — `check-site.mjs`
fails the build on a file with different ids, a fifth checkpoint, a builder slot
accepting something outside its palette, or `wrong` keys that don't match the
non-answer cards. Authoring a challenge file means filling in this exact shape.

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
| `game.js` | index | Packet Runner, the hero's snake-style mini-game |
| `vault.js` | pages with checkpoints | the practice sidecar and all six mechanics |
| `progress.js` | `/progress/` | the vault map, reading the same blob `vault.js` writes |

`game.js` follows the same discipline as the rest: inert until an explicit START
(arrow keys scroll the page as normal), only capturing keys while a run is live,
and still under `prefers-reduced-motion` apart from that explicit opt-in. The
board is fluid below 440px — the script measures the cell size into a `--cell`
custom property rather than assuming the 400px design width.

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

A construction-paper identity: IBM Plex Sans (UI) / Serif (long-form prose) / Mono
(data, labels, counts), a single yellow accent, and a faint drafting grid on sky
bands. All of it is one hand-written stylesheet — no framework, no build step for
CSS.

The vault home opens on a split hero: copy and stats on the left, **Packet Runner**
on the right — a playable board in the same navy as the docs' code blocks, under the
theme "every doc travels as a packet". GitHub and LinkedIn icon buttons sit in the
shared header. DSA chapters add their own layer on top of the doc frame: a numbered
study-track side nav, a metadata strip, and the four decorated contract sections
from §4.

### The portfolio theme

`/` and the vault now run one identity: **construction paper** — a flat-cutout look
of bright sky, snow-capped peaks, 2px ink outlines and hard offset shadows with no
blur, on IBM Plex type and the `--ink` scale. The landing page keeps the mountain
landscape; the vault keeps the drafting grid, drawn inside its own sky band.
Everything specific to the landing page is still prefixed `pf-` and scoped under
`body.portfolio`, so its layout and motion rules collide with nothing — but the
color tokens are the same shared set the vault reads, defined once in `:root`.

Every accent reads `var(--acc)`, defined once in `:root`, so the page re-themes from
a single property (`#FFD808` pom yellow, or the `#4FC3D9` / `#E23D3D` alternates).
The career diagram's arrows draw themselves in on load via `stroke-dashoffset`,
staggered `.12s` apart by a `--i` custom property, and the global reduced-motion
block zeroes both duration *and* delay so the animation lands finished rather than
late.

Design source of truth: `docs/superpowers/InterviewVault Design System.zip` →
`portfolio-reference.html`. Two deliberate departures from it, both because that
prototype has no `box-sizing: border-box` reset and this stylesheet does: the shell
is `calc(1180px + 2 * 32px)` so the *content column* still measures the design's
1180px, and the hero icon buttons are 42px so the 38px inner square plus its 2px
cutout border renders at the reference's size.

A third departure is deliberate, not a size fix: the reference prototype colors its
meta text `#6B7C96`, measured at 4.24:1 on white — under the 4.5:1 AA floor for body
text. Rather than pixel-match that on the landing page alone, the 2026-08-07
re-theme gave the whole site one shared `--mut` / `--rule` pair that clears AA
everywhere it is used, and let the landing page's eight `.pf-*` rules that read
those tokens — the career-diagram year labels and captions, the timeline date column
and row dividers, the stack label, the creds line, and the project meta — darken
along with them. Its focus ring drifts the same way: on sky bands it is `--ink`, not
`--blue` (see rule 4 below). Both drifts were ruled correct by the human partner on
2026-08-07 — a later pass should not "fix" the landing page back toward the
handoff's lower-contrast values.

Four accessibility rules, each pinned by a measured contrast ratio, are why blue
survives only as a focus ring and nowhere else: yellow (`--acc`) on white is
1.39:1, so it is never text, only a fill behind ink; `--mut` on a sky band is
2.20:1, so muted text steps up to `--ink-2` on bands; white on a sky band is 1.93:1,
so the vault headline reads `--ink`, not white; and `--blue` on a sky band is
2.68:1 — under the 3:1 WCAG floor for a non-text indicator — so `:focus-visible`
switches to `--ink` on sky bands (9.05:1) and keeps `--blue` only on `--paper` /
`--sky-wash`, where it clears 3:1.

### Tokens

```css
--ink #0E1A2B       --ink-2 #3A4A61      --mut #4F5F79       --paper #FFFFFF
--soft #F2F5FB      --prose #16233A      --rule #CFE0EE
--acc #FFD808       --acc-wash #FFF6C9   --sky #79C3F0       --sky-wash #EAF5FD
--sky-grid #5AAFE0  --blue #2563EB       (focus ring only)
--cut 2px solid var(--ink)     --lift 4px 4px 0 var(--ink)
--lift-hi 6px 6px 0 var(--ink) (hover)
--amber #F59E0B     --good #10B981

--shell 1240px          site frame
--side-w / --rail-w / --doc-gap    doc-page columns
```

The portfolio adds its own structural tokens, scoped to `body.portfolio` and used
nowhere else — every color is shared with the vault; only these layout constants
are page-specific:

```css
--pf-shell 1180px    content column      --pf-pad 32px   side padding
```

Two token notes from the 2026-08-07 re-theme:

- `--rule` darkened `#E4EAF5` → `#CFE0EE`. The old hairline was tuned against a
  white page; on the new `--sky-wash` background it measured 1.09:1 and every
  divider, table rule and inset border would have all but disappeared. The
  darker value reaches 1.22:1 on `--sky-wash` and 1.35:1 on `--paper` — still a
  hairline on white, but visible on the band, so one token serves both surfaces.
- `--prose` (`#16233A`, 15.72:1 on `--paper`) moved out of `body.portfolio` and
  into `:root`. The vault's `.prose` had been hard-coding the same hex; both
  long-form serif surfaces now read the one token.

`--soft` (`#F2F5FB`) is the inset-surface fill — inline code, metadata pills,
table zebra. It is the one neutral that is *not* a sky tint, which is why it
survived the re-theme unchanged.

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
the six gates → upload `site/` as an artifact.

The diagram cache is keyed on `hashFiles('LLD/**/*.md', 'DSA/**/*.md')` with a
`diagrams-` restore prefix, so an exact hit skips rendering entirely and a partial
hit re-renders only what changed. This is what keeps a 615-diagram build fast.

**deploy job** — gated on `push` to `master`, so pull requests build and validate but
never publish. Downloads the artifact and runs `wrangler deploy`.

### Serving

A Cloudflare Worker with **no script** — `wrangler.toml` points `[assets]` at
`./site` and Cloudflare serves it directly. `html_handling = "auto-trailing-slash"`
maps `/answers/bitly/` to that directory's `index.html`.

`not_found_handling = "404-page"` is configured but **has nothing to serve** — the
build never emits a `site/404.html`, so unmatched paths fall back to Cloudflare's
default response. Emitting one from `build-site.mjs` would close the gap.

`_headers` asks for a year-long immutable cache on `/assets/*` and one hour on the
mutable scripts — but `_headers` / `_redirects` are a **Pages convention that
Workers Static Assets ignores**. Verified against production: `/assets/site.css`
comes back `cache-control: public, max-age=0, must-revalidate`, not the configured
value. The files are carried over from the earlier Pages setup and are currently
inert; honouring them would take a small Worker script that sets `Cache-Control`
around the asset fetch.

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
7. **DSA chapters keep the exact H2 sequence** from `dsa-config.mjs`, and every
   plain ` ```cpp ` block must compile as C++17 — `check-dsa.mjs` fails the build
   otherwise. Notebook-era snippets that should not be modernised are tagged
   ` ```cpp legacy `.
8. **Authored challenge files match the fixed contract** — four checkpoints with
   the standard ids, types, tiers and XP; `check-site.mjs` enforces it.

### Known rough edges

- `site/assets/` is **not** cleaned between builds, only the section directories.
  Orphaned diagram SVGs accumulate — there is currently one on disk with no
  referencing doc (616 files, 615 live). Harmless, but the count drifts.
- `collectionFor()` in `build-site.mjs` and `authoredSlugs()` in
  `gen-challenges.mjs` are both dead — nothing calls them.
- `buildIndex()` contains a no-op `map.replace(…, (m) => m)` left from an earlier
  approach to injecting doc counts.
- `check-site.mjs` validates root-relative URLs only; external links are unchecked.

---

## 10. Extension points

**Add a document** — drop a `.md` into a collection folder, write the H1 and the
heading contracts from §4, rebuild. Nothing to register.

**Add practice challenges** — create `content/challenges/<slug>.json` with the
four standard checkpoints from §5 (the contract is enforced, so copy an existing
file as the template). The filename must match the doc's derived slug. Works for
answer docs and deep dives alike; rebuild and the sidecar picks it up.

**Add a DSA chapter** — two files: the markdown in `DSA/` following the exact H2
sequence, and an entry in `tools/dsa-config.mjs` with a free `order` slot. The
gate tells you precisely what is missing; ` ```cpp ` blocks must compile as C++17.

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
