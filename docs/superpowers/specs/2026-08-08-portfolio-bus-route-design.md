# Portfolio Bus-Route Design

## Goal

Bring the landing page at `/` up to the current design in the "InterviewVault Design
System" project — `templates/portfolio/Portfolio.dc.html`, which supersedes the
`portfolio-reference.html` the page was built from.

Two things change. The hero, today a still scene, gains ambient life: a spinning sun,
drifting clouds, bobbing pines, a swaying polaroid, ink strokes on the mountains, and
a dashed road stub curving off the right mountain toward the bottom edge. And the
Experience section stops being a diagram plus a timeline and becomes a single
object — a bus route descending the page, with each job a stop along the road and a
bus that tracks the reader's scroll position.

Everything else on the page — projects, notes, hobbies, footer, stack pills, creds —
is unchanged.

## What the design replaces

The current section renders two things stacked: a horizontal 5-node system diagram
(`PF_CAREER` / `careerDiagram()`) and an `<ol>` timeline of the same five jobs
(`PF_EXPERIENCE` / `.pf-timeline`). The road replaces **both**. The five stop cards
carry the role titles and body copy the timeline carried; the road carries the
sequence the diagram carried.

The diagram's two extras are dropped, deliberately: the dashed "regulated scale"
bracket over the middle three nodes, and the per-node mono captions (`OpenGL ES ·
60fps`, `MiFID · EMIR`, `TICB · TIC SLT`, `MiFID · MAS`, `LiteLLM · Claude Agent
SDK`). Every technology named in those captions already appears either in the stop
card body next to it or in the stack pill row below, so nothing leaves the page that
was not already said in prose.

Order flips. The timeline ran newest-first; the road runs oldest-first, because a
road is read in the direction it is travelled.

## Where the design and the repo disagree

The design file was authored against the site as it stood before the vault moved to
`/vault/`, and against a props panel this site does not have. Five deviations, all
resolved in the repo's favour:

| Design file says | This build does | Why |
| --- | --- | --- |
| Notes card → `https://cartmancodes.com` | → `/vault/` | The portfolio *is* the root now; the design's target is a self-link |
| `cartmancodes.com ↗` | `cartmancodes.com/vault →` | Matches the corrected target |
| `122 documents · 615 diagrams` | build-derived counts | Hardcoded counts drift from what the vault holds |
| `animation-play-state: var(--amb, running)` | omitted | `--amb` drives the design tool's motion toggle; a static page has no toggle, and the global `prefers-reduced-motion` rule in `site.css` already stops every animation |
| `uploads/pasted-1786055514414-0.png` | `/assets/cartman.png` | Same 728×563 asset, already in `tools/template/` |

Two things are taken **from** the design against the repo: the 2019–21 role gains its
fuller title, "Arcesium — Software Engineer, Regulatory ETL", and the responsive
breakpoint for the Experience section moves from 680px to 720px.

Everything else — path `d` strings, polygon points, stop percentages, animation
durations and delays, the `· first stop` and `· you are here` pill text, all copy —
is taken from the design file verbatim.

## Hero

The existing `landscape` SVG gains `stroke="#0E1A2B" stroke-width="3"` on every
mountain and snow-cap polygon, and the four pines split into two `<g>` groups running
a `bob` keyframe (3.6s, and 4.2s with a −1.6s delay) so they sway out of phase.

Three new pieces sit in the hero:

- **Sun** — an 86px SVG at `top: 78px; right: 44px`, a yellow disc with eight ink rays,
  rotating once every 40s.
- **Clouds** — three white pills with ink outlines, each with a `::before` half-disc
  puff whose `border-bottom` is removed so the two shapes merge into one silhouette.
  They drift left to right across `112vw` over 46s, 60s and 52s, staggered with
  negative delays so they are already mid-crossing on load.
- **Road stub** — a dashed path curving from the base of the right mountain down to
  the hero's bottom edge, drawn as a 22px ink underlay at 12% opacity with a 3px
  dashed centreline over it. It is the visual hand-off into the Experience road.

The polaroid's static `rotate(-2deg)` becomes a `sway` keyframe rocking between
−2.6° and −1.1° over 6s, with `transform-origin: top center` so it hangs.

## Experience road

A `1000 × 1600` SVG in a wrapper with `aspect-ratio: 1000/1600` and `max-width: 960px`,
so the stop cards can be placed in percentages and track the SVG at any width.

The road is one S-curve descending centre → right → left → right → left → centre,
drawn twice: a 26px ink stroke at 12% opacity for the asphalt, and a 3px dashed
stroke over it for the centreline. Four accent circles mark stops along it; a
double circle marks the terminus.

Five stop cards are pinned along the road, alternating sides — `left: 59%` for stops
1, 3 and 5, `right: 59%` for 2 and 4, each at a fixed percentage down the wrapper.
The last card is the exception: centred, wider, and filled accent rather than white,
because it is the current job. Each card carries a mono date pill, the role title,
a `founding engineer` pill where it applies, and the body copy.

The section label pill is absolutely positioned into the top-left corner rather than
sitting in the flow, so the road starts at the top of the section.

Below the road, the stack pill row and the creds line are unchanged.

### The bus

A bus `<g>` follows the road as the reader scrolls. Progress is the wrapper's
position in the viewport, clamped to 0–1; the road path's `getTotalLength()` and
`getPointAtLength()` give the position, and a second sample two units further along
gives the tangent, so the bus banks into the curves.

This is the page's only JavaScript. Under `prefers-reduced-motion: reduce` the scroll
and resize listeners are never attached and the bus is placed once at the terminus —
a scroll-linked follower is the kind of motion that setting exists to suppress, and
the road, the stops and the dashes all still render without it.

## Responsive

At or below 720px the road SVG is hidden, the wrapper drops its aspect ratio, and the
stop cards unpin into a plain stacked column in road order. The section label pill
returns to the flow. The stops carry the whole story on their own — they are ordinary
DOM text, so nothing is lost to screen readers or to narrow viewports.

The page must hold together to 320px, as it does today.

## Files

| File | Change |
| --- | --- |
| `tools/build-site.mjs` | `PF_EXPERIENCE` + `PF_CAREER` → `PF_STOPS`; `careerDiagram()` → `busRoute()`; hero ambience markup; load `portfolio.js` |
| `tools/template/portfolio.js` | New. The bus driver, ~30 lines, the page's only script |
| `tools/template/site.css` | Delete `.pf-diagram`, `.pf-arrow`, `.pf-bracket*`, `.pf-node*`, `.pf-timeline`, `.pf-entry*`, `.pf-when`; add hero ambience, road frame and `.pf-stop` |

Per-card placement is passed as a `--top` custom property on the element, the same
idiom the deleted `.pf-arrow { --i }` used, so the geometry stays with the data in
`build-site.mjs` and the styling stays in `site.css`.

## Verification

The five CI gates from `CLAUDE.md`, all of which must pass:

```bash
node tools/check-dsa.mjs
python3 tools/check-python.py
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
node tools/check-site.mjs
```

Then the built `site/index.html` opened in a browser, to confirm three things the
gates cannot see: the bus tracks the road through every curve, the stacked fallback
holds at 320px, and the ambient animations stop under reduced motion.
