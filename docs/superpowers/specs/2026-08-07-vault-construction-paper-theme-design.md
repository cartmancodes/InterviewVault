# Vault Construction-Paper Theme Design

## Goal

Re-theme the InterviewVault vault pages so they read as a sibling of the portfolio
landing page at `/`, which already runs the "construction paper" theme — flat cutout
shapes, 2px ink outlines, hard offset shadows with no blur, sky bands, and a single
yellow fill accent.

Today the two halves of the site look unrelated: `/` is construction paper, and
everything under `/vault/`, `/answers/`, `/dsa/` and the rest is the original
engineering-blueprint identity built on a blue accent. The two share IBM Plex type
and the `--ink` scale, and nothing else.

The vault is a long-form reading environment — 123 documents, some over 6,000 words,
on a three-column frame. The theme must not cost it readability.

## Scope Decision

The theme reaches the **chrome and the index surfaces**, not the reading surfaces.

| Surface | Treatment |
| --- | --- |
| Shared header, shared footer | Construction paper |
| Vault home (`/vault/`) | Construction paper |
| Progress page (`/progress/`) | Construction paper |
| Practice sidecar on doc pages | Construction paper — it is a game panel |
| Doc article frame, side nav, TOC | Calm — hairlines kept, accent recoloured |
| Library row list (123 rows) | Calm — hairlines kept, yellow hover wash |

Personality where the reader is browsing; quiet where they are reading. Applying 2px
outlines and hard shadows around dense body copy fights sustained reading, and a
123-row list where every row is a cutout card is unreadable.

## Palette

The portfolio's accents move from `body.portfolio` up to `:root` so both halves of
the site draw from one vocabulary.

```css
--acc      #FFD808   the fill accent — never text, only a fill behind ink
--sky      #79C3F0   hero + footer bands
--sky-wash #EAF5FD   page background (replaces --blue-wash)
--sky-grid #5AAFE0   gridlines drawn inside sky bands
--ink      #0E1A2B   unchanged — text, borders, shadows
--ink-2    #3A4A61   unchanged — secondary text
--mut      #4F5F79   darkened from #6B7C96 (see Accessibility)
--blue     #2563EB   retained ONLY as the focus ring on light surfaces
```

`--amber`, `--good` and `--danger` are unchanged. They are semantic rather than
brand, and they appear as fills and left-borders rather than as body text.

Blue is retired as a brand colour because the landing page uses no blue at all.
Yellow cannot inherit blue's text-level jobs — `#FFD808` on white is 1.39:1 — so
those jobs go to ink instead, and yellow does fill work only.

### Link treatment

Links inside prose become ink text with a 3px yellow underline; hover paints a
yellow highlighter fill behind the ink. This keeps prose links at 17.48:1 while
reading unmistakably as the theme.

Active states in the side nav, the TOC and the header nav become yellow fill pills
behind ink text, replacing today's blue text.

## Component Specification

Cutout means: `2px solid var(--ink)` border, `4px 4px 0 var(--ink)` shadow growing
to `6px 6px 0` on hover, pill radius on controls and `10px` on cards. These already
exist on the portfolio as `--cut`, `--lift` and `--lift-hi`; the declarations move to
`:root` alongside the colour tokens.

**Header.** 2px ink bottom rule. The brand mark becomes the ink `IV` square used on
the landing page's Notes banner. The nine nav links stay borderless — nine outlined
pills reads as a picket fence — but hover and the active page paint a yellow fill
pill behind ink text.

**Footer.** Sky band with a 2px ink top rule, matching the landing page footer
exactly.

**Vault hero.** Becomes a sky band, closed by a 2px ink bottom rule, with the
blueprint grid drawn *inside* it in `--sky-grid`. The mountain landscape stays unique
to `/` so the front door remains distinguishable from the library; the grid stays the
vault's own signature. The headline is ink, not white (see Accessibility).

**Architecture map.** Nodes become white fills with a 2px ink stroke at `rx 8` — the
same node spec as the landing page's career diagram — with ink edges and a yellow
fill on hover. The hardcoded `#C6D3EC` divider in `build-site.mjs:371` becomes ink at
reduced opacity.

**Chips and search.** White, 2px ink border, pill radius. A selected chip is a yellow
fill.

**Library rows.** Hairline rows retained. Hover gets a yellow wash rather than a
border or shadow.

**Packet Runner.** The board stays navy — it is the docs' code-block colour and reads
as a terminal. The snake becomes yellow. No JavaScript change is needed; the game
already reads its colours from CSS custom properties.

**Progress page.** Coverage cards, the streak strip and the storage tiers all take
the cutout treatment.

## Accessibility

Every foreground/background pair was measured rather than judged by eye. Three came
back as genuine failures and drive rules below.

### Rule 1 — muted text darkens site-wide

`--mut` moves `#6B7C96` → `#4F5F79`. The binding surface was muted text on a selected
yellow chip, the worst pair on the site at 3.05:1.

| Surface | `#6B7C96` today | `#4F5F79` new |
| --- | --- | --- |
| White | 4.24:1 | 6.47:1 |
| Sky-wash `#EAF5FD` | 3.83:1 | 5.85:1 |
| Soft `#F2F5FB` | 3.89:1 | 5.93:1 |
| Table head `#F7F9FE` | 4.03:1 | 6.14:1 |
| Yellow `#FFD808` | 3.05:1 | 4.65:1 |

Yellow is the binding surface at 4.65:1; every other surface clears 5.8:1.

The new value clears 4.5:1 everywhere while staying clearly lighter than `--ink-2`
(9.01:1 on white), so the type hierarchy survives. The accepted cost: meta text on
all 123 doc pages — eyebrows, captions, TOC entries, row meta — reads slightly
darker and less airy than today.

### Rule 2 — on sky bands, muted text steps up to `--ink-2`

Sky is too light to carry small grey text at any tuning. Even the darkened `--mut` is
only 3.35:1 against `--sky`, so muted text on a sky band uses `--ink-2` (4.66:1)
instead. This affects the vault hero's eyebrow, its stat labels, the
`$ ping knowledge.local` story line, and the footer.

### Rule 3 — the hero headline is ink, not white

White on sky is 1.93:1. The landing page uses white only because its headline carries
a 3px ink text-shadow that manufactures the edge; the vault hero has no such device,
so its headline is ink at 9.05:1.

### Rule 4 — the focus ring changes colour on sky

Blue on sky is 2.68:1, below the 3:1 WCAG 2.4.11 requires of a focus indicator. On
sky bands the ring becomes ink (9.05:1); everywhere else it stays blue (5.17:1 on
white, 4.67:1 on sky-wash).

**This is an existing bug in already-shipped code.** The landing page's hero nav
pills and social buttons sit on sky and currently take a blue focus ring. The fix
applies to `body.portfolio` in the same change.

### Confirmed sound

Ink on yellow is 12.55:1 and ink on sky is 9.05:1, so the fill strategy carries text
comfortably at every size.

## Files Touched

- `tools/template/site.css` — the bulk of the work; 59 `var(--blue*)` references
- `tools/build-site.mjs` — arch-map node classes, header brand mark, and the
  hardcoded `#C6D3EC` at line 371
- `ARCHITECTURE.md` — §7 design system: the shared token block, and the fact that
  the theme is now site-wide rather than portfolio-only

`tools/template/game.js` needs no change.

## Verification

1. The five CI gates pass: `check-dsa.mjs`, `check-python.py`, `render-diagrams.mjs`
   + `build-site.mjs`, `check-site.mjs`.
2. Every colour pair introduced or changed is re-measured and recorded, including the
   four rules above. No pair regresses against today's values.
3. The vault home, a doc page, a DSA page and the progress page are screenshotted at
   1440px, 700px and 320px, with no horizontal overflow at any width and no console
   errors.
4. Focus rings are verified visible on sky bands on both `/vault/` and `/`.
5. Hover states are sampled after transitions settle, not mid-flight.
6. Reduced-motion still zeroes both animation duration and delay.

## Out Of Scope

- The doc article frame, side nav and TOC keep their existing layout and hairlines.
  Only their accent colours change.
- The mountain landscape is not reused on the vault hero.
- Dark mode.
- The `--amber` / `--good` / `--danger` semantic colours.
- Any change to document content, the challenge system or the practice mechanics.
