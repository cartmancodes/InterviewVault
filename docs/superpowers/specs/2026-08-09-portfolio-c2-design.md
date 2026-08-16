# Portfolio C2 Design

## Goal

Bring the landing page at `/` up to `Portfolio C2.dc.html`, the current iteration of
the construction-paper portfolio in the claude.ai design project
`a05a94cb-f894-49b2-84a4-7c801491fe18` ("Landing page design concepts").

C2 is not a rewrite. The repository already ships the hero, the outlined mountains,
the sun and clouds, the bus road with five stops, and a scroll-driven bus in
`tools/template/portfolio.js`. C2 adds a school to the front of the story, gives the
road a starting gate, and fills the scene with ambient life.

## Source

- Design: `Portfolio C2.dc.html` (read via the DesignSync MCP, project above)
- `assets/staff-photo.png` in that project is the same image already committed at
  `tools/template/cartman.png`. No new asset is needed.
- `ds-base.js` and `support.js` are the **prototype harness**, not production code.
  `support.js` is a 70KB generated React runtime that interprets `<x-dc>`, `ref="{{ }}"`
  bindings and `DCLogic`. `ds-base.js` injects the design system's CSS.
  Neither ships. Two of the harness's conventions must be translated by hand:
  - `style-hover="…"` compiles to a `:hover { … }` rule
  - `style-before="…"` compiles to a `::before { … }` rule

## What Changes

### 1. Education section (new)

A new `<section id="education">` between the hero and Experience, and an
**Education** link at the head of the hero nav.

Left column: a polaroid in the same frame as the staff photo — white card, 2px ink
border, `5px 5px 0` shadow, rotated −2° — containing a hand-drawn SVG of the Mesra
campus (clock-tower building, two ridge lines with snow caps, pines, birds, a sun,
a pennant) on a sky ground, captioned `MESRA CAMPUS, RANCHI — BATCH OF 2017`.

Right column: a "BIT MESRA" pennant SVG (flagpole plus accent triangle), then a
cutout card with the institution, degree line and a serif paragraph, then three
pills — `Est. 1955`, `Ranchi, Jharkhand`, `ACM ICPC regionals`.

All copy is taken verbatim from the design.

### 2. Terminal strip (new)

A full-bleed ink bar directly under the hero: `cartman@mesra:~` in sky, then a line
that types itself out, holds, deletes and moves to the next of three messages:

```
$ ping knowledge.local — 64 bytes received: curiosity alive
$ uptime — 9 years in production, 0 dropped packets
$ whoami — technical lead by day, side-project gremlin by night
```

Typing is 42ms per character, a 2800ms hold, then deletion three characters at a
time. A `▌` block cursor trails the text while it moves.

### 3. Hero ambience (additions)

Added to the existing sun, clouds, mountains and pines:

- Seven snowflakes — ink-outlined white discs falling on staggered 9–13s loops.
- A gondola: a 2.5px cable strung between the second and third peaks, with a car
  that runs the cable and returns, on a 24s cycle.
- A kite: an accent diamond with spars and a tailed string, bobbing.
- The two pine groups bob on 3.6s and 4.2s offsets.
- The polaroid sways −2.6° to −1.1° on a 6s loop, hinged at `top center`.
- Mountain and pine polygons keep the 3px ink stroke already in the repo.

### 4. The road starts at Mesra (changed)

The road SVG's viewBox extends upward from `0 0 1000 1600` to `0 -210 1000 1810`,
and the path gains a leading segment so it now begins at a **MESRA GATE** — two
posts, an accent sign board, and a stop dot — physically connecting the Education
section to the first job. The existing five stops keep their copy but move to the
percentages the taller viewBox implies.

Roadside scenery, all ink-outlined:

| Where | What |
| --- | --- |
| Beside the gate | Swaying pine |
| Upper left | Two pines, a ground line, and a rabbit hopping back and forth on a 7s loop |
| Right, mid | A windmill — tower, base, four accent/white sails spinning once per 9s |
| Left, lower | A pond with a duck crossing and returning, and two reeds swaying |
| Right, lower | A `NEXT →` signpost swinging from a post, a lamp bobbing above it, and a pine |

### 5. Section reveal (new)

Every section after the hero starts at `opacity: 0` and `translateY(18px)` and
settles when it crosses 10% into the viewport, via one `IntersectionObserver` that
unobserves each element once revealed.

## Motion Control

C2's ambience is perpetual: sun, three clouds, seven flakes, two pine groups,
gondola, kite, polaroid, rabbit, windmill, duck, reeds, signpost and lamp all loop
forever. The design gates this behind an `ambient` prop that only exists inside the
design tool.

**WCAG 2.2.2 (Pause, Stop, Hide)** requires a mechanism to pause motion that starts
automatically, lasts more than five seconds, and is presented alongside other
content. This qualifies, so the prop becomes a real control rather than being
dropped:

- Every ambient animation reads `animation-play-state: var(--amb, running)`.
- A small cutout button sits in the hero nav — `⏸ motion` / `▶ motion` — toggling
  `--amb` between `running` and `paused` on `body.portfolio`.
- The choice persists in `localStorage` under `pf-motion`.
- `prefers-reduced-motion: reduce` forces `paused` and is never overridden by the
  stored value. The existing global reduced-motion block already zeroes durations
  and delays; the play-state makes the intent explicit for infinite loops.

The scroll-driven bus is separate and already correct: `portfolio.js` parks it at
the terminus and attaches no listeners under reduced motion.

The design's `accent` prop (three colours) does **not** ship. `--acc` is already a
`:root` token, so the page re-themes from one declaration without any UI.

## Content Accuracy

The design's Notes card reads "122 worked system-design documents · 615 diagrams".
The build knows the real numbers and already interpolates them. Live counts win —
shipping a figure the build can prove wrong is a defect, not fidelity.

## Tokens Beat Literals

The design is a standalone prototype, so it inlines hex values that this codebase
has since replaced with tokens. **Use the token every time.** The trap worth naming:
the design writes `#6B7C96` for the stack label and the creds line, which is
**4.24:1 on white and fails AA**. The repository darkened `--mut` to `#4F5F79`
(6.47:1) precisely to fix that, and `ARCHITECTURE.md` records the ruling. Copying
the design's literal would silently undo it.

Every new pair in C2 was measured and passes: sky prompt on ink 9.05:1, white on
ink 17.48:1, ink on accent 12.55:1, the degree line 9.01:1, the serif paragraph
15.72:1.

## Responsive

The existing `@media (max-width: 900px)` block already drops `.pf-roadsvg`, releases
the road's aspect ratio and stacks `.pf-stop` in road order. It must be extended so
that:

- the Mesra gate and all roadside scenery disappear with the road SVG — they live
  inside it, so this is automatic, but the stop percentages must not leave a gap;
- the Education polaroid and its card stack into one column;
- the terminal strip stays on one line and truncates rather than wrapping;
- the motion toggle stays reachable in the wrapped nav.

Targets: 320px, 375px, 414px, plus the existing desktop widths.

## Verification

1. The five CI gates pass.
2. No horizontal overflow at 320 / 375 / 414 / 1440.
3. Every new foreground/background pair is measured, including sky-on-ink in the
   terminal strip and ink-on-accent on the gate sign. Nothing regresses.
4. The motion toggle actually pauses every ambient animation, persists across a
   reload, and is overridden by `prefers-reduced-motion`.
5. The bus still tracks scroll, and still parks under reduced motion.
6. The typing loop does not leak a timer on unload and does not run under reduced
   motion.
7. Screenshots of `/` at desktop and mobile are read, not just captured.

## Files

- `tools/build-site.mjs` — Education section, terminal strip, hero ambience, road
  geometry and scenery, nav link, motion toggle markup
- `tools/template/site.css` — keyframes, ambient play-state wiring, Education
  layout, terminal strip, motion toggle, responsive rules
- `tools/template/portfolio.js` — typing loop, section reveal, motion toggle
  persistence, alongside the existing bus driver

## Out Of Scope

- The accent colour picker.
- Any change to the vault (`/vault/`, doc pages, progress) — this is the landing
  page only.
- `ds-base.js`, `support.js` and the `_ds/` design-system tree.
- The other concepts in the design project (Portfolio A, B, C, C1, C3).
