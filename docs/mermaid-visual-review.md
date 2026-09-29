# Mermaid visual review

Review performed 2026-09-12. The inventory contains 636 unique source blocks (628 LLD, 8 DSA). Source identifiers below are the first 16 SHA1 characters of the raw Mermaid block; rendered filenames now use the renderer's theme-aware hash.

## Coverage and method

`node tools/review-mermaid.mjs` captures 32 contact sheets with Chrome through Puppeteer. Output is local under `/tmp/mermaid-review/`, together with an index mapping each tile to its document, section, source and original hash. The script resolves current SVGs using `hashOf` from the renderer. These are review artifacts, not site assets.

All 32 original contact sheets were visually scanned: 635 cached diagrams and one missing original cache. This was a layout and visual-complexity scan, not a line-by-line correctness review or a guarantee against every small collision. The newly themed sheets 0, 10, 15, 22, 27 and 31 were additionally inspected. Current diagrams 2, 217, 310 and 544 were enlarged to confirm findings. The missing original diagram 544 now renders and was inspected. All eight DSA diagrams had straightforward, comprehensible layouts in both old and new sheets.

## Confirmed findings and recommendations

| Priority | Document / section | Original source hash | Visual finding / recommended action |
| --- | --- | --- | --- |
| High | `LLD/CoreConcepts/Networking.md:1185`, Circuit Breakers | `77544e79a9cb41fc` | All three states display literal `\n` between state names and descriptions. Confirmed in enlarged current rendering. Replace with supported HTML line breaks. |
| High | `LLD/questions/Design Dropbox.md:374`, Delta Sync via Content-Defined Chunking | `c6de99099a85f045` | Comparison renders as two long vertical stacks, with content-defined above fixed-size despite source order. Makes corresponding changed/unchanged chunks hard to compare. Use two aligned horizontal rows with explicit subgraph directions and stable order, or two side-by-side vertical columns. |
| High | `LLD/questions/Design Whatsapp.md:1173`, Complete Message Flow Diagram | `9e8c1bbb5035f037` | Very tall overview (original height 2487px) repeats three identical delivery/online/ACK branches. Replace the repeated server branches with one representative per-recipient branch, or split persistence, routing/delivery and reconnect/receipt into separate diagrams. |
| Medium | `LLD/CoreConcepts/Networking.md:912`, Complete Data Flow Through OSI Layers | `6dc13641faef2055` | Original is a 2093px single column. Sender and receiver layers cannot be compared at a glance. Use adjacent sender and receiver columns with a transmission bridge, maintaining direction inside each column. |
| Medium | `LLD/CoreConcepts/ConsistentHashing.md:530`, Hash Ring with Virtual Nodes | `8acfd03d7ba9c7d8` | Very wide, shallow strip makes labels microscopic when fit to article width. Native-scale horizontal scroll/zoom is useful. A circular ring illustration would better explain clockwise ownership than a long row. |
| Medium | `LLD/CoreConcepts/DistributedLocking.md:694`, Production Checklist | `ac83d17f952cce17` | Checklist fans into one very wide row. A two-column checklist or grouped two-level diagram would read better; this is primarily checklist content. |
| Medium | `LLD/questions/Design News Aggregator.md:111`, High-Level Design | `b9a4c166dbc7f38c` | Tall dense architecture mixes ingestion, processing and serving. Preserve as an expandable overview, with reader-visible labels for its phases and a native-size zoom option. |
| Medium | Mindmaps, e.g. `LLD/CoreConcepts/Caching.md:60`, Key Benefits | `c5b195612162c23b` | New pastel nodes with ink labels improve the earlier neon appearance. Connectors inherit very pale fill colors and become faint on white. Darken connectors independently while keeping pastel fills. Enlarged new mindmap has no label collision. |

## Shared UX observations

Long pipelines and dense sequence diagrams frequently become unreadable when forcibly fit to narrow article width. Provide discoverable expand/zoom controls, preserve native text size when expanded and allow horizontal panning. Sequence actor names should remain distinguishable, with message wrapping rather than manual shortening that removes meaning. The new theme's stronger actor hierarchy and wrapped notes improve the inspected examples.

A selective interactive consistent-hash ring would directly support learning: move a key clockwise, add/remove a server, and highlight only reassigned ranges. A controlled message-flow stepper would help the WhatsApp overview. Three-dimensional perspective is useful for the existing layered arena/memory visualization where depth represents an actual layer; it adds little to ER, state or sequence diagrams. Keep playback user-controlled, with reduced-motion support and an equivalent static view.

The report records findings at review time. It does not claim all recommendations have been implemented, nor that every regenerated SVG has received an enlarged inspection.

## Implementation follow-through

The confirmed high-priority findings are now fixed: circuit-breaker labels use
rendered line breaks, Dropbox uses two separately labelled comparison rows, and
WhatsApp splits into persistence, live delivery and reconnect stages. The OSI
flow is an aligned two-column SVG, the virtual-node diagram is a circular SVG,
and the lock checklist is a grouped table. Mindmap connectors use the stronger
neutral independently of their pastel node fills. Dense News Aggregator and other
retained overviews have full-size viewing, zoom and selectable label alternatives.

See `visual-audit.md` for final coverage and verification. The original hashes
above intentionally identify the reviewed baseline rather than the revised files.
