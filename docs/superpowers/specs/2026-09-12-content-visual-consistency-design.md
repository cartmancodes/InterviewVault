# Content visual consistency

Approved by the user, including selective 3D and animation.

## Scope and initial evidence

Inventory across LLD, DSA and content: 129 Markdown files, 636 Mermaid blocks,
555 SVG assets, 54 PNG assets and 610 Markdown image references. These are source
counts, not a claim that every asset is referenced or visually reviewed.

The existing Mermaid renderer uses IBM Plex Sans, ink outlines, pale yellow nodes
and sky-tinted groups. Imported images do not use that renderer. Its cache hashes
diagram source only, so a theme change does not invalidate existing output.

## Recommended approach

Combine a shared visual system with individual content review. A palette-only
change would leave crowded labels and unclear flow intact. Redrawing everything
in 3D would make sequences and algorithms harder to follow and increase maintenance.

Keep the existing construction-paper identity on calm white reading surfaces.
Use ink #0E1A2B for labels and connectors, pale yellow #FFF6C9 for processing,
sky wash #EAF5FD for boundaries and clients, pale teal #DDF3EC for storage,
and pale violet #EDE8FA for queues/events. Reserve saturated yellow #FFD808
for the current step. Failure paths use explicit labels and dashed edges as
well as colour. Include a local legend wherever semantic colours are introduced.

Standardize typography, spacing, line weights, arrowheads, figure framing and
captions. Preserve technical meaning and attribution. Every figure should answer
one learning question, with clear reading order and a short explanatory caption.
Split crowded diagrams into overview and detail only after checking surrounding
prose. Preserve edge direction, cardinality, algorithm state and sequence order.

## Formats and reading experience

- Mermaid: shared theme across supported diagram types, audited source overrides,
  and cache invalidation that includes renderer/theme configuration.
- Imported SVG: review rendered output and source labels; normalize compatible
  styles and redraw unclear diagrams using editable vectors. Avoid blind colour
  substitution that could change semantic meaning.
- PNG and other images: distinguish diagrams from screenshots and photographs.
  Redraw instructional diagrams when useful; preserve authentic screenshots and
  use consistent framing, descriptive alternatives and captions.
- 3D: use restrained isometric SVG for physical/logical layers, distributed
  replicas, storage tiers or shard placement when depth encodes a relationship.
  Keep text horizontal, connections visible and the reading order explicit.
  Sequences, trees and algorithm traces retain flat layouts.
- Dense figures: provide accessible enlargement with keyboard dismissal and focus
  restoration; avoid shrinking all labels until they become unreadable on mobile.
- Animation: opt-in play/pause and step controls for authored explanations of
  request flows, queues, replication and algorithm states. Never infer execution
  order from arbitrary graph node order. Respect reduced motion and keep a complete
  static diagram available with JavaScript disabled.

## Implementation and coverage

Build a per-document inventory linking each image or Mermaid block to its source,
rendered output and review disposition. Include external images, HTML images,
duplicate assets and broken references. Record which visuals are retained,
normalized or redrawn and why. Review all referenced instructional visuals,
including figures whose colours already match. Do not equate a global CSS change
with an individual review.

Change source documents, source assets and tools only; site is generated output.
Keep content heading contracts and the existing DSA and Python conventions.

## Acceptance checks

Render every Mermaid diagram with the new configuration; verify theme changes
invalidate cached output. Check all image references, SVG validity and preserved
labels. Inspect rendered visuals for clipping, overlaps, illegible labels,
confusing edges and unintended colour semantics. Measure new text contrast to
at least 4.5:1 and meaningful graphic boundaries to at least 3:1.

Inspect representative pages at 1440px, 700px and 320px, including dense diagrams,
sequence diagrams, imported images and isometric figures. Verify enlargement by
keyboard, focus restoration and reduced motion. Run all repository gates:
check-dsa, check-python, check-motion, render-diagrams, build-site and check-site.
Report coverage and any remaining limitations explicitly.
