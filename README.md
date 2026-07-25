# InterviewVault

A system-design and DSA study vault: 122 worked documents, 607 diagrams, written to be
read the week before an interview and re-read the morning of.

The markdown is the source of truth. `site/` is a static build of it — a browsable
library that deploys to Cloudflare Pages.

---

## The library

| Collection | Docs | What it is |
|---|---|---|
| [In a Hurry](LLD/SystemDesign/InaHurry/) | 8 | The orientation: delivery framework, key technologies, how to prepare. |
| [Deep Notes](LLD/CoreConcepts/) | 9 | Long-form handwritten notes on the fundamentals. |
| [Core Concepts](LLD/SystemDesign/CoreConcepts/) | 9 | Caching, sharding, indexing, CAP, networking, API design. |
| [Patterns](LLD/SystemDesign/Patterns/) | 7 | Scaling reads/writes, contention, real-time, blobs, long-running work. |
| [Quick Reference](LLD/SystemDesign/Patterns/QuickReference/) | 7 | Condensed cheat-sheets, one per pattern. |
| [Deep Dives](LLD/SystemDesign/DeepDives/) | 13 | One technology at a time — Kafka, Cassandra, Redis, Flink, and friends. |
| [Problem Breakdowns](LLD/SystemDesign/ProblemBreakdowns/) | 30 | Full worked designs for the questions asked by name. |
| [In the Wild](LLD/SystemDesign/IntheWild/) | 3 | How real companies solved it, and what they traded away. |
| [Interview Answers](LLD/questions/) | 28 | My own answers: requirements → deep dives → scaling journey → depth by level. |
| [Data Structures](DSA/) | 8 | The algorithm notes behind the coding rounds. |

Every document carries a table of contents, a plain-language explanation, worked
diagrams, key takeaways, and cross-links to related material.

---

## The site

```bash
cd tools
npm install                  # once
node render-diagrams.mjs     # mermaid -> SVG (content-hashed, cached)
node build-site.mjs          # markdown -> site/

cd ../site && python3 -m http.server 8899    # preview at localhost:8899
```

Diagrams are pre-rendered to SVG at build time, so pages ship with **no client-side
JavaScript for rendering** — they load instantly and work without JS. The only scripts
are a small search filter on the home page and a table-of-contents highlighter.

Deployment (Cloudflare Pages + a GoDaddy domain) is documented in **[DEPLOY.md](DEPLOY.md)**.

### How the build works

| File | Job |
|---|---|
| [tools/render-diagrams.mjs](tools/render-diagrams.mjs) | Extracts every mermaid block, renders it through headless Chrome, writes `site/assets/diagrams/<hash>.svg`. Re-runs only for new diagrams. |
| [tools/build-site.mjs](tools/build-site.mjs) | Walks the collections, converts markdown to HTML, rewrites internal links and image paths, injects the rendered diagrams, and emits the pages, index and sitemap. |
| [tools/template/](tools/template/) | The design system: `site.css`, the home-page filter, the TOC highlighter, favicon, and Cloudflare `_headers` / `_redirects`. |

Adding a document is just adding a markdown file to one of the collection folders and
rebuilding — it appears in the library, the section nav, and the sitemap automatically.

### Writing diagrams that render

Mermaid is stricter than it looks. Two rules cover almost every failure:

- **No `;` inside label or message text** — use a comma.
- **Quote any label containing brackets or parentheses**: `A["Write WAL (log): 1 I/O"]`.

Validate before committing:

```bash
cd tools && node render-diagrams.mjs     # reports any block that fails to parse
```
