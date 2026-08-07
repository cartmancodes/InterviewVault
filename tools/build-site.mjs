// Builds the static InterviewVault site from the markdown vault.
//   node build-site.mjs      (run render-diagrams.mjs first for diagrams)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { hashOf, extractMermaid } from './render-diagrams.mjs';
import { buildChallenges } from './gen-challenges.mjs';
import { DSA_TOPICS } from './dsa-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SITE = path.join(REPO, 'site');
const TPL = path.join(__dirname, 'template');
const DIAGRAMS = path.join(SITE, 'assets', 'diagrams');

/* ── collections: repo dir -> site section ─────────────── */
const COLLECTIONS = [
  { dir: 'LLD/SystemDesign/InaHurry',              key: 'in-a-hurry',  label: 'In a Hurry',          url: 'in-a-hurry',        blurb: 'The 60-minute orientation: framework, key technologies, how to prepare.' },
  { dir: 'LLD/CoreConcepts',                       key: 'notes',       label: 'Deep Notes',          url: 'notes',             blurb: 'Long-form handwritten notes on the fundamentals, with worked diagrams.' },
  { dir: 'LLD/SystemDesign/CoreConcepts',          key: 'concepts',    label: 'Core Concepts',       url: 'concepts',          blurb: 'The vocabulary every design rests on — caching, sharding, indexing, CAP.' },
  { dir: 'LLD/SystemDesign/Patterns/QuickReference', key: 'quickref',  label: 'Quick Reference',     url: 'patterns/quick-reference', blurb: 'Condensed cheat-sheets for each pattern. Built for the last hour before an interview.' },
  { dir: 'LLD/SystemDesign/Patterns',              key: 'patterns',    label: 'Patterns',            url: 'patterns',          blurb: 'Reusable solution shapes: scaling reads and writes, contention, real-time, blobs.' },
  { dir: 'LLD/SystemDesign/DeepDives',             key: 'deep-dives',  label: 'Deep Dives',          url: 'deep-dives',        blurb: 'One technology at a time, to the depth a staff interview actually probes.' },
  { dir: 'LLD/SystemDesign/ProblemBreakdowns',     key: 'breakdowns',  label: 'Problem Breakdowns',  url: 'breakdowns',        blurb: 'Full worked designs for the questions that get asked by name.' },
  { dir: 'LLD/SystemDesign/IntheWild',             key: 'in-the-wild', label: 'In the Wild',         url: 'in-the-wild',       blurb: 'How real companies solved it, and what they gave up to get there.' },
  { dir: 'LLD/questions',                          key: 'answers',     label: 'Interview Answers',   url: 'answers',           blurb: 'My own answers: requirements, deep dives, scaling journey, expected depth by level.' },
  { dir: 'DSA',                                    key: 'dsa',         label: 'Data Structures',     url: 'dsa',               blurb: 'The algorithm and data-structure notes that back the coding rounds.' },
];

const SKIP = new Set(['LLD/SystemDesign/README.md']);

// `/` is the portfolio landing page; the vault's own home lives one level in.
// Everything that links "back to the library" goes through this constant.
const VAULT = '/vault/';

/* ── helpers ───────────────────────────────────────────── */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// marked has already entity-encoded its output; decode before re-escaping so we
// don't ship &amp;#39; into the TOC.
const decodeEnt = (s) => String(s)
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const stripEmoji = (s) =>
  s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '').trim();
const slugify = (s) =>
  stripEmoji(s).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');

function fileSlug(name) {
  const base = name.replace(/\.md$/, '');
  return base
    .replace(/^Design\s+/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function titleOf(md, fallback) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? stripEmoji(m[1]).trim() : fallback;
}

function collectionFor(rel) {
  // longest dir match wins (QuickReference before Patterns)
  return COLLECTIONS.filter((c) => rel.startsWith(c.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
}

function listMarkdown(dir) {
  const abs = path.join(REPO, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((e) => e.endsWith('.md') && statSync(path.join(abs, e)).isFile())
    .map((e) => `${dir}/${e}`)
    .filter((r) => !SKIP.has(r));
}

/* ── discover docs ─────────────────────────────────────── */
const docs = [];
for (const c of COLLECTIONS) {
  for (const rel of listMarkdown(c.dir)) {
    const md = readFileSync(path.join(REPO, rel), 'utf8');
    const name = path.basename(rel);
    const slug = fileSlug(name);
    const title = titleOf(md, name.replace(/\.md$/, ''));
    const words = md.split(/\s+/).length;
    const diagrams = extractMermaid(md).length;
    const images = (md.match(/!\[[^\]]*\]\([^)]+\.(?:svg|png|jpe?g)/gi) || []).length;
    const dsa = c.key === 'dsa' ? DSA_TOPICS[slug] : null;
    if (c.key === 'dsa' && !dsa) throw new Error(`${rel}: missing DSA metadata for slug ${slug}`);
    docs.push({
      rel, md, slug, title, words, diagrams, images, dsa,
      col: c, url: `/${c.url}/${slug}/`,
      out: path.join(SITE, c.url, slug, 'index.html'),
    });
  }
}
// registry for cross-links: repo-relative md path -> url
const byRel = new Map(docs.map((d) => [d.rel, d]));

function docsForCollection(collection) {
  const list = docs.filter((doc) => doc.col.key === collection.key);
  if (collection.key !== 'dsa') return list;
  return list.sort((a, b) => a.dsa.order - b.dsa.order);
}

/* ── markdown -> html ──────────────────────────────────── */
marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false });

const copiedAssets = new Set();
function copyAsset(repoRelPath) {
  const src = path.join(REPO, repoRelPath);
  if (!existsSync(src)) return null;
  const dest = path.join(SITE, 'assets', 'docs', repoRelPath);
  if (!copiedAssets.has(repoRelPath)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copiedAssets.add(repoRelPath);
  }
  return '/assets/docs/' + repoRelPath.split(path.sep).join('/');
}

function decorateDsaSections(html) {
  const classes = {
    'at-a-glance': 'dsa-summary',
    'interview-method': 'dsa-method',
    'failure-modes': 'dsa-warning',
    'recall-drill': 'dsa-recall',
  };

  return html.replace(
    /<h2 id="([^"]+)">([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2 id="|$)/g,
    (full, id, title, content) => classes[id]
      ? `<section class="dsa-section ${classes[id]}"><h2 id="${id}">${title}</h2>${content}</section>`
      : full,
  );
}

function renderDoc(doc) {
  let md = doc.md;
  // drop the H1 (shown in the page header instead)
  md = md.replace(/^#\s+.+\n+/, '');
  // drop the doc's own "Table of Contents" section — the page renders a live one
  md = md.replace(/^##\s+[^\n]*Table of Contents[^\n]*\n[\s\S]*?(?=^##\s)/m, '');
  // a lone horizontal rule left where the TOC was reads as a stray divider
  md = md.replace(/^\s*---\s*$\n(?=\s*##\s)/m, '');

  // pull mermaid out before parsing; re-inject rendered SVG after
  const diagrams = [];
  md = md.replace(/```mermaid\n([\s\S]*?)```/g, (_, src) => {
    const h = hashOf(src);
    diagrams.push(h);
    return `\n<div class="diagram" data-diagram="${h}"></div>\n`;
  });

  let html = marked.parse(md);
  const docDir = path.dirname(doc.rel);
  const headings = [];
  const seen = new Map();

  // headings: ids + collect TOC
  html = html.replace(/<h([234])>([\s\S]*?)<\/h\1>/g, (m, lvl, inner) => {
    const text = stripEmoji(decodeEnt(inner.replace(/<[^>]+>/g, ''))).trim();
    let id = slugify(text) || 'section';
    if (seen.has(id)) { const n = seen.get(id) + 1; seen.set(id, n); id = `${id}-${n}`; } else seen.set(id, 1);
    if (lvl !== '4') headings.push({ lvl: Number(lvl), id, text });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });

  // images -> copied assets
  html = html.replace(/<img([^>]*?)src="([^"]+)"([^>]*)>/g, (m, pre, src, post) => {
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) return m;
    const repoRel = path.normalize(path.join(docDir, decodeURIComponent(src))).split(path.sep).join('/');
    const newSrc = copyAsset(repoRel);
    if (!newSrc) return m;
    const alt = (m.match(/alt="([^"]*)"/) || [, ''])[1];
    return `<figure class="fig"><img${pre}src="${newSrc}"${post} loading="lazy">${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`;
  });

  // internal .md links -> site urls
  html = html.replace(/<a([^>]*?)href="([^"]+)"/g, (m, pre, href) => {
    if (/^(https?:|mailto:|#)/.test(href)) return m;
    const [p, frag] = href.split('#');
    if (!p.endsWith('.md')) return m;
    const repoRel = path.normalize(path.join(docDir, decodeURIComponent(p))).split(path.sep).join('/');
    const target = byRel.get(repoRel);
    if (!target) return m;
    return `<a${pre}href="${target.url}${frag ? '#' + slugify(frag) : ''}"`;
  });

  // tables: horizontally scrollable
  html = html.replace(/<table>/g, '<div class="tbl-wrap"><table>').replace(/<\/table>/g, '</table></div>');

  // inject pre-rendered diagrams
  html = html.replace(/<div class="diagram" data-diagram="([0-9a-f]+)"><\/div>/g, (m, h) => {
    const f = path.join(DIAGRAMS, `${h}.svg`);
    if (!existsSync(f)) return `<div class="diagram"><p class="empty">Diagram unavailable.</p></div>`;
    return `<div class="diagram">${readFileSync(f, 'utf8')}</div>`;
  });

  if (doc.col.key === 'dsa') html = decorateDsaSections(html);

  return { html, headings, diagramCount: diagrams.length };
}

/* ── page shell ────────────────────────────────────────── */
// 700 is here for the portfolio landing page only — its wordmark and headline
// are the one place on the site that goes heavier than 600.
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@400;600&display=swap" rel="stylesheet">`;

// GitHub / LinkedIn brand marks, inlined so there are no icon assets to fetch.
const SOCIALS = `<div class="socials">
<a href="https://github.com/cartmancodes" title="GitHub" aria-label="GitHub profile" rel="me">
<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
</a>
<a href="https://in.linkedin.com/in/shubhojeet-chakraborty-540570b0" title="LinkedIn" aria-label="LinkedIn profile" rel="me">
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.72C24 .77 23.2 0 22.22 0z"/></svg>
</a>
</div>`;

const header = (active) => `<header class="hdr"><div class="hdr-in">
<a class="brand" href="${VAULT}"><span class="brand-mark">IV</span><span class="brand-name">Interview<span>Vault</span></span></a>
<nav class="hdr-nav">${COLLECTIONS.filter((c) => c.key !== 'quickref')
  .map((c) => `<a href="${VAULT}#${c.key}"${active === c.key ? ' aria-current="page"' : ''}>${c.label}</a>`).join('')}</nav>
${SOCIALS}
</div></header>`;

const footer = () => `<footer class="foot"><div class="foot-in">
<span>InterviewVault — system design study vault</span>
<span>${docs.length} documents · ${docs.reduce((a, d) => a + d.diagrams, 0)} diagrams</span>
</div></footer>`;

// `chrome: false` drops the vault header and footer — the portfolio landing page
// carries its own nav and footer and shares nothing but the shell and the fonts.
function page({ title, desc, body, active, cls = '', chrome = true }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
${FONTS}
<link rel="stylesheet" href="/assets/site.css">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
</head>
<body class="${cls}">
${chrome ? header(active) : ''}
${body}
${chrome ? footer() : ''}
</body>
</html>`;
}

/* ── doc pages ─────────────────────────────────────────── */
function buildDocPage(doc, siblings, idx) {
  const { html, headings } = renderDoc(doc);
  const prev = siblings[idx - 1], next = siblings[idx + 1];
  const toc = headings.length
    ? `<nav class="toc"><h4>On this page</h4><ol>${headings
        .map((h) => `<li><a class="${h.lvl === 3 ? 'h3' : ''}" href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ol></nav>`
    : '';

  const ch = buildChallenges(path.join(REPO, doc.rel), doc.slug);
  const hasSidecar = doc.col.key === 'answers'
    ? ch.checkpoints.length
    : doc.col.key === 'deep-dives' && ch.authoredCount > 0;
  let sidecar = '', sheetBtn = '', vaultScript = '';
  if (hasSidecar) {
    sidecar =
      `<section id="iv-sidecar" class="sidecar" aria-label="Practice"></section>` +
      `<script type="application/json" id="iv-challenges">${JSON.stringify(ch).replace(/</g, '\\u003c')}</script>`;
    sheetBtn = `<button id="iv-sheet-open" class="sheet-open-btn" type="button" aria-expanded="false" hidden>Practice</button>`;
    vaultScript = `<script src="/assets/vault.js" defer></script>`;
  }
  const rail = sidecar || toc ? `<aside class="rail">${sidecar}${toc}</aside>` : '<aside></aside>';
  const side = doc.dsa
    ? `<nav class="side dsa-track" aria-label="DSA study track"><h4>DSA study track</h4><ol>${siblings
        .map((s) => `<li><a href="${s.url}"${s.slug === doc.slug ? ' aria-current="page"' : ''}><span class="track-n">${String(s.dsa.order).padStart(2, '0')}</span><span>${esc(s.title)}</span></a></li>`).join('')}</ol></nav>`
    : `<nav class="side"><h4>${esc(doc.col.label)}</h4><ol>${siblings
        .map((s) => `<li><a href="${s.url}"${s.slug === doc.slug ? ' aria-current="page"' : ''}>${esc(s.title)}</a></li>`).join('')}</ol></nav>`;

  const meta = [
    `${doc.words.toLocaleString()} words`,
    doc.diagrams ? `${doc.diagrams} diagram${doc.diagrams > 1 ? 's' : ''}` : null,
    doc.images ? `${doc.images} figure${doc.images > 1 ? 's' : ''}` : null,
  ].filter(Boolean).map((m) => `<span>${m}</span>`).join('');
  const dsaMeta = doc.dsa
    ? `<div class="dsa-meta" data-dsa-order="${doc.dsa.order}"><span>${String(doc.dsa.order).padStart(2, '0')} / ${String(siblings.length).padStart(2, '0')}</span><span>${esc(doc.dsa.pattern)}</span><span>${esc(doc.dsa.difficulty)}</span><span>${doc.dsa.reviewMinutes} min review</span></div>`
    : '';

  const body = `<div class="doc-shell">
${side}
<main>
<article class="art">
<div class="art-head">
<div class="art-kicker">${esc(doc.col.label)}</div>
<h1>${esc(doc.title)}</h1>
<div class="art-meta">${meta}</div>
${dsaMeta}
</div>
<div class="prose">${html}</div>
</article>
<nav class="pager">
${prev ? `<a href="${prev.url}"><span>Previous</span><b>${esc(prev.title)}</b></a>` : '<span></span>'}
${next ? `<a class="nx" href="${next.url}"><span>Next</span><b>${esc(next.title)}</b></a>` : '<span></span>'}
</nav>
</main>
${rail}
</div>
${sheetBtn}
<script src="/assets/doc.js" defer></script>${vaultScript}`;

  mkdirSync(path.dirname(doc.out), { recursive: true });
  writeFileSync(doc.out, page({
    title: `${doc.title} — InterviewVault`,
    desc: `${doc.title}: ${doc.col.blurb}`,
    body, active: doc.col.key, cls: doc.dsa ? 'doc dsa-doc' : 'doc',
  }));
}

/* ── the architecture-map signature ────────────────────── */
function archMap(counts) {
  const N = (x, y, w, h, key, label, count) => {
    const c = counts[key] || 0;
    return `<a class="node" href="${VAULT}#${key}" role="link" aria-label="${label}, ${c} documents">
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7"></rect>
      <text class="n-label" x="${x + w / 2}" y="${y + h / 2 - 3}" text-anchor="middle">${label}</text>
      <text class="n-count" x="${x + w / 2}" y="${y + h / 2 + 16}" text-anchor="middle">${c} docs</text>
    </a>`;
  };
  const edge = (d, cls = '', len = 300) =>
    `<path class="edge ${cls}" style="--len:${len}" d="${d}" marker-end="url(#ah)"></path>`;

  return `<section class="map">
<div class="map-cap">The vault, as a system — how the material builds on itself</div>
<svg viewBox="0 0 1000 300" role="img" aria-label="Map of the vault: In a Hurry leads to Deep Notes and Core Concepts, which feed Patterns and Deep Dives, which feed Problem Breakdowns and your own Interview Answers. Data Structures is a separate track.">
<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path class="edge-head" d="M0 0 L8 4 L0 8 z"></path></marker></defs>

<!-- row A: orientation -> fundamentals -->
${edge('M190 54 H 240', '', 50)}
${edge('M405 54 H 455', 'd2', 50)}
${edge('M660 54 H 710', 'd3', 50)}

<!-- fundamentals drop into the applied row -->
${edge('M557 82 V 118 H 190 V 172', 'd2', 440)}
${edge('M790 82 V 118 H 455 V 172', 'd3', 440)}

<!-- applied row reads left to right -->
${edge('M275 200 H 325', '', 50)}
${edge('M580 200 H 630', 'd2', 50)}

${N(30, 26, 160, 56, 'in-a-hurry', 'In a Hurry')}
${N(240, 26, 165, 56, 'notes', 'Deep Notes')}
${N(455, 26, 205, 56, 'concepts', 'Core Concepts')}
${N(710, 26, 160, 56, 'deep-dives', 'Deep Dives')}

${N(110, 172, 165, 56, 'patterns', 'Patterns')}
${N(325, 172, 255, 56, 'breakdowns', 'Problem Breakdowns')}
${N(630, 172, 225, 56, 'answers', 'Interview Answers')}

<line x1="878" y1="150" x2="878" y2="266" stroke="#C6D3EC" stroke-width="1" stroke-dasharray="4 5"></line>
<text x="940" y="164" class="n-count" style="font-size:10.5px" text-anchor="middle">separate track</text>
${N(898, 172, 88, 56, 'dsa', 'DSA')}
</svg>
</section>`;
}

/* ── vault home ────────────────────────────────────────── */
function buildIndex() {
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c.key, docs.filter((d) => d.col.key === c.key).length]));
  const totalDiagrams = docs.reduce((a, d) => a + d.diagrams, 0);
  const totalWords = docs.reduce((a, d) => a + d.words, 0);

  // map svg with real counts substituted
  let map = archMap(counts);
  map = map.replace(/>(\d+) docs</g, (m, n) => m); // counts already injected

  const chips = COLLECTIONS.map((c) =>
    `<button class="chip" data-f="${c.key}" aria-pressed="false">${c.label}<span class="c-n">${counts[c.key] || 0}</span></button>`).join('');

  const rows = COLLECTIONS.map((c) => {
    const list = docsForCollection(c);
    if (!list.length) return '';
    return `<div class="sec" data-sec="${c.key}" id="${c.key}">
<div class="sec-h">${c.label} · <span style="text-transform:none;letter-spacing:0">${esc(c.blurb)}</span></div>
${list.map((d) => `<a class="row" href="${d.url}" data-t="${esc((d.title + ' ' + c.label).toLowerCase())}">
<span class="row-t">${esc(d.title)}</span>
<span class="row-s">${esc(c.label)}</span>
<span class="row-m">${d.diagrams ? `<i>${d.diagrams}</i> diagram${d.diagrams > 1 ? 's' : ''} · ` : ''}${(d.words / 1000).toFixed(1)}k words</span>
</a>`).join('')}
</div>`;
  }).join('');

  // Hero: copy left, Packet Runner right ("every doc travels as a packet").
  // See docs/superpowers — CartmanCodes Portfolio Animation Concepts, concept 2a.
  const body = `<section class="hero blueprint"><div class="hero-in hero-split">
<div class="hero-copy">
<h1>Everything I know about <em>designing systems</em>, in one place.</h1>
<p class="hero-sub">Worked breakdowns, pattern cheat-sheets and long-form notes — written to be read the week before an interview, and re-read the morning of.</p>
<div class="stats">
<div class="stat"><b>${docs.length}</b><span>Documents</span></div>
<div class="stat"><b>${totalDiagrams}</b><span>Diagrams</span></div>
<div class="stat"><b>${Math.round(totalWords / 1000)}k</b><span>Words</span></div>
</div>
<div class="story">
<div>$ ping knowledge.local</div>
<div>$ 64 bytes received: curiosity alive</div>
</div>
</div>
<div class="hero-game">
<div class="game-caption">PACKET RUNNER — DON'T DROP THE STREAM</div>
<div id="pr-board" aria-label="Packet Runner, a snake-style mini-game. Use arrow keys or WASD once started.">
<div id="pr-food"></div>
<div id="pr-overlay">
<h2 id="pr-title">PACKET RUNNER</h2>
<p id="pr-sub">guide the stream · deliver packets · don't drop the connection</p>
<button id="pr-btn" type="button">START</button>
</div>
</div>
<div class="scorebar">
<div class="score-label">PACKETS DELIVERED <b id="pr-score" aria-live="polite">0</b></div>
<div class="keys"><span class="k-desk">← ↑ ↓ → OR WASD</span><span class="k-touch">TAP WHERE THE STREAM SHOULD GO</span></div>
</div>
</div>
</div></section>

${map}

<section class="lib">
<div class="lib-bar">
<label class="search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7C96" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
<input id="q" type="search" placeholder="Search ${docs.length} documents…" autocomplete="off" aria-label="Search documents">
<kbd>/</kbd></label>
${chips}
</div>
<div class="rows" id="rows">${rows}</div>
<p class="empty" id="none" hidden>No document matches that.</p>
</section>
<script src="/assets/home.js" defer></script>
<script src="/assets/game.js" defer></script>`;

  const out = path.join(SITE, 'vault', 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, page({
    title: 'InterviewVault — System Design Study Vault',
    desc: `${docs.length} worked system-design documents: patterns, deep dives, problem breakdowns and interview answers.`,
    body, cls: '',
  }));
}

/* ── portfolio landing page ────────────────────────────── */
// The construction-paper theme: flat cutout shapes, 2px ink outlines and hard
// offset shadows over the vault's IBM Plex identity. Design source of truth is
// docs/superpowers "InterviewVault Design System" → portfolio-reference.html.

const PF_EXPERIENCE = [
  {
    when: '2025—',
    role: 'Arcesium — Technical Lead, AI/ML — Arcesium Intelligence (formerly Maelstrom)',
    founding: true,
    body: 'AI agents for CI/CD, DevOps and financial-analysis workflows across the firm. Built the LiteLLM proxy layer that powers Arcesium-grade AI infrastructure — the central gateway with per-user/team rate limits and budget caps, routing across OpenAI, Anthropic and AWS Bedrock, and full spend audit trails. On Arcesium Intelligence, agents run on the Claude Agent SDK in sandboxed environments — AWS Lambda, PostgreSQL, S3, and EKS + Fargate, with EKS for long-running servers.',
  },
  {
    when: '2023–25',
    role: 'Arcesium — Technical Lead, TRACS',
    founding: true,
    body: 'MiFID/MAS trade-reporting platform for hedge-fund clients. Spark ETL orchestrated with Argo Workflows — checkpointed, idempotent, high-throughput; client-facing web modules on AWS EKS, batch compute on EC2 Spot.',
  },
  {
    when: '2021–23',
    role: 'Arcesium — Senior Software Engineer, ARMOR',
    founding: true,
    body: 'Automatic post-trade reporting for TICB/TIC SLT; led the web layer, data-quality checker, authorisation module and core ETL — Java/Spring Boot orchestrated with Argo Workflows on EC2 Spot, with retry and checkpoint logic.',
  },
  {
    when: '2019–21',
    role: 'Arcesium — Software Engineer',
    founding: false,
    body: 'MiFID/EMIR regulatory ETL in Python (pandas, SQLAlchemy) on SQL Server: ingestion, transformation, validation, plus deterministic and fuzzy-matching reconciliation utilities for high-volume trade data.',
  },
  {
    when: '2017–19',
    role: 'Samsung Research — Software Engineer, Advanced Software',
    founding: false,
    body: 'GPU-accelerated image/video effects in OpenGL ES at 60fps; native Tizen C++. On the Advanced Software team, built C# applications in Xamarin for mobile and TV.',
  },
];

const PF_STACK = [
  'Java / Spring Boot', 'Python / FastAPI', 'Spark', 'LiteLLM', 'LangGraph', 'C++',
  'Postgres + pgvector', 'Redis', 'AWS EKS', 'Azure VMSS', 'Argo Workflows', 'React / TypeScript',
];

const PF_PROJECTS = [
  {
    name: 'litellm-rust',
    href: 'https://github.com/cartmancodes/litellm-rust',
    blurb: 'A minimal Rust gateway built for coding agents, LiteLLM-compatible.',
    meta: 'Rust · github ↗',
  },
  {
    name: 'kafka-poc',
    href: 'https://github.com/cartmancodes/kafka-poc',
    blurb: "Proof-of-concept Kafka pipeline; the notes behind the vault's Kafka deep dive.",
    meta: 'Java · github ↗',
  },
];

const PF_HOBBIES = [
  {
    name: 'Music theory',
    body: 'I study harmony the way I read codebases: chord functions as interfaces, voice leading as data flow. Most evenings this means working out why a borrowed iv resolves the way it does, then writing it down like a postmortem.',
  },
  {
    name: 'Football',
    body: 'I play, and I watch tactics more than matches. A pressing scheme is an architecture diagram — triggers are event handlers, the double pivot is redundancy, a low block is graceful degradation.',
  },
];

// Career-as-system-diagram. Node geometry is fixed by the design (viewBox
// 0 0 1000 150); arrows sit in the 44px gutter between adjacent nodes.
const PF_CAREER = [
  { x: 10,  w: 152, label: 'Samsung · Advanced Software', years: '2017–19', under: 'OpenGL ES · 60fps',        size: 11 },
  { x: 210, w: 172, label: 'Arcesium · Regulatory ETL',   years: '2019–21', under: 'MiFID / EMIR',             size: 12 },
  { x: 430, w: 152, label: 'Arcesium · ARMOR',            years: '2021–23', under: 'TICB / TIC SLT',           size: 12 },
  { x: 630, w: 152, label: 'Arcesium · TRACS',            years: '2023–25', under: 'MiFID / MAS',              size: 12 },
  { x: 830, w: 160, label: 'Arcesium Intelligence',       years: '2025—',   under: 'LiteLLM · Claude Agent SDK', size: 12, accent: true },
];

const PF_SOCIALS = [
  {
    href: 'https://github.com/cartmancodes', label: 'GitHub', me: true,
    svg: `<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
  },
  {
    href: 'https://in.linkedin.com/in/shubhojeet-chakraborty-540570b0', label: 'LinkedIn', me: true,
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.72C24 .77 23.2 0 22.22 0z"/></svg>`,
  },
  {
    href: 'mailto:shubhchak@gmail.com', label: 'Email', me: false,
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
  },
];

function careerDiagram() {
  const nodes = PF_CAREER.map((n) => {
    const mid = n.x + n.w / 2;
    return `<rect class="pf-node${n.accent ? ' pf-node-now' : ''}" x="${n.x}" y="40" width="${n.w}" height="54" rx="8"></rect>
<text class="pf-node-label" x="${mid}" y="63" text-anchor="middle" font-size="${n.size}">${esc(n.label)}</text>
<text class="pf-node-years${n.accent ? ' pf-node-years-now' : ''}" x="${mid}" y="82" text-anchor="middle">${esc(n.years)}</text>
<text class="pf-node-under" x="${mid}" y="118" text-anchor="middle">${esc(n.under)}</text>`;
  }).join('\n');

  // one arrow per adjacent pair, drawn in left to right
  const arrows = PF_CAREER.slice(0, -1).map((n, i) => {
    const from = n.x + n.w, to = PF_CAREER[i + 1].x;
    return `<path class="pf-arrow" style="--i:${i}" d="M${from} 67 H ${to - 4}" marker-end="url(#pf-ah)"></path>`;
  }).join('\n');

  return `<div class="pf-diagram">
<svg viewBox="0 0 1000 150" role="img" aria-label="Career diagram: Samsung Research flows into regulatory ETL at Arcesium, then ARMOR, then TRACS, then Arcesium Intelligence, the AI/ML agent team.">
<defs><marker id="pf-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="#0E1A2B"></path></marker></defs>
<line class="pf-bracket" x1="210" y1="22" x2="790" y2="22"></line>
<text class="pf-bracket-label" x="500" y="16" text-anchor="middle">regulated scale</text>
${arrows}
${nodes}
</svg>
</div>`;
}

function buildPortfolio() {
  const totalDiagrams = docs.reduce((a, d) => a + d.diagrams, 0);

  const landscape = `<svg class="pf-landscape" viewBox="0 0 1280 300" preserveAspectRatio="none" aria-hidden="true">
<polygon points="60,300 330,60 600,300" fill="#8C97AB"></polygon><polygon points="330,60 268,136 392,136" fill="#FFFFFF"></polygon>
<polygon points="420,300 740,20 1060,300" fill="#A6B0C2"></polygon><polygon points="740,20 664,116 816,116" fill="#FFFFFF"></polygon>
<polygon points="900,300 1140,90 1280,240 1280,300" fill="#8C97AB"></polygon><polygon points="1140,90 1088,152 1192,152" fill="#FFFFFF"></polygon>
<rect x="0" y="252" width="1280" height="48" fill="#FFFFFF"></rect>
<polygon points="80,252 110,196 140,252" fill="#2E7D46"></polygon><polygon points="150,252 180,204 210,252" fill="#3C9159"></polygon>
<polygon points="1060,252 1090,198 1120,252" fill="#2E7D46"></polygon><polygon points="1130,252 1160,206 1190,252" fill="#3C9159"></polygon>
</svg>`;

  const socials = PF_SOCIALS.map((s) =>
    `<a class="pf-icon-link" href="${s.href}" title="${s.label}" aria-label="${s.label}"${s.me ? ' rel="me"' : ''}>${s.svg}</a>`).join('\n');

  const hero = `<header class="pf-hero">
${landscape}
<div class="pf-shell pf-hero-shell">
<nav class="pf-nav" aria-label="Sections">
<span class="pf-wordmark">cartmancodes</span>
<a href="#experience">Experience</a><a href="#projects">Projects</a><a href="#notes">Notes</a><a href="#hobbies">Hobbies</a>
</nav>
<div class="pf-hero-content">
<div class="pf-hero-copy">
<p class="pf-badge">Shubhojeet Chakraborty · Technical Lead, AI/ML · Arcesium</p>
<h1>Building systems at scale by day. Crafting ambitious side projects by night.</h1>
<div class="pf-socials">${socials}</div>
</div>
<figure class="pf-polaroid">
<img src="/assets/cartman.png" width="728" height="563" alt="Staff photo: a cartoon character in a red jacket and blue hat" loading="eager">
<figcaption>STAFF PHOTO — “I'M NOT LAZY, I'M ASYNC.”</figcaption>
</figure>
</div>
</div>
</header>`;

  const timeline = PF_EXPERIENCE.map((e) => `<li class="pf-entry">
<span class="pf-when">${esc(e.when)}</span>
<div class="pf-entry-copy">
<h3>${esc(e.role)}${e.founding ? ' <span class="pf-founding">founding engineer</span>' : ''}</h3>
<p>${esc(e.body)}</p>
</div>
</li>`).join('\n');

  const experience = `<section id="experience" class="pf-section">
<h2 class="pf-label">Experience</h2>
${careerDiagram()}
<ol class="pf-timeline">
${timeline}
</ol>
<div class="pf-stack"><span class="pf-stack-label">stack</span>${
    PF_STACK.map((s) => `<span class="pf-pill">${esc(s)}</span>`).join('')}</div>
<p class="pf-creds">ACM ICPC regionals 2017 · national rank 57 in prelims — Codeforces Expert (1775) — Codechef 5★</p>
</section>`;

  const projects = `<section id="projects" class="pf-section">
<h2 class="pf-label">Projects</h2>
<div class="pf-cards">
${PF_PROJECTS.map((p) => `<a class="pf-card pf-project" href="${p.href}">
<h3>${esc(p.name)}</h3>
<span>${esc(p.blurb)}</span>
<small>${esc(p.meta)}</small>
</a>`).join('\n')}
</div>
</section>`;

  // The funnel into the vault. Counts come from the build, not the copy deck, so
  // they cannot drift from what the vault actually holds.
  const notes = `<section id="notes" class="pf-section">
<h2 class="pf-label">Notes</h2>
<a class="pf-notes" href="${VAULT}">
<span class="pf-iv">IV</span>
<span class="pf-notes-copy">
<strong>The notes section is a whole website — InterviewVault</strong>
<span>${docs.length} worked system-design documents · ${totalDiagrams} diagrams · 5 CI gates · a practice layer with XP · a snake game. Enter the vault →</span>
</span>
<span class="pf-notes-domain">cartmancodes.com/vault →</span>
</a>
<nav class="pf-notes-links" aria-label="Vault shortcuts">
<a href="${VAULT}#dsa">dsa track →</a><a href="${VAULT}#deep-dives">deep dives →</a><a href="${VAULT}">play packet runner →</a>
</nav>
</section>`;

  const hobbies = `<section id="hobbies" class="pf-section pf-last">
<h2 class="pf-label">Hobbies</h2>
<div class="pf-cards pf-cards-wide">
${PF_HOBBIES.map((h) => `<article class="pf-card">
<h3>${esc(h.name)}</h3>
<p class="pf-prose">${esc(h.body)}</p>
</article>`).join('\n')}
</div>
</section>`;

  const foot = `<footer class="pf-footer"><div class="pf-shell">
<span>Shubhojeet Chakraborty · <a href="mailto:shubhchak@gmail.com">shubhchak@gmail.com</a> · <a href="https://github.com/cartmancodes" rel="me">github</a> · <a href="https://in.linkedin.com/in/shubhojeet-chakraborty-540570b0" rel="me">linkedin</a></span>
<span>$ exit 0</span>
</div></footer>`;

  writeFileSync(path.join(SITE, 'index.html'), page({
    title: 'Shubhojeet Chakraborty — Technical Lead, AI/ML',
    desc: 'Shubhojeet Chakraborty builds systems at scale at Arcesium — AI infrastructure, regulatory data platforms, and InterviewVault.',
    body: `${hero}\n<main>\n${experience}\n${projects}\n${notes}\n${hobbies}\n</main>\n${foot}`,
    cls: 'portfolio',
    chrome: false,
  }));
}

/* ── vault map (1h) ────────────────────────────────────── */
function buildProgressPage() {
  const answers = docs.filter((d) => d.col.key === 'answers');
  const cards = answers.map((d) => {
    const ch = buildChallenges(path.join(REPO, d.rel), d.slug);
    return { slug: d.slug, title: d.title, url: d.url, total: ch.checkpoints.length };
  }).filter((c) => c.total);

  const body = `<section class="hero blueprint"><div class="hero-in">
<div class="eyebrow">Progress · stored on this device</div>
<h1>The vault map</h1>
<p class="hero-sub">Every question doc you have practised, and how far each one got. Nothing leaves this browser — see <a href="#storage">where that stops working</a>.</p>
<div class="stats" id="vm-stats"></div>
</div></section>

<section class="lib">
<div class="sec-h">Coverage · ${cards.length} question docs with checkpoints</div>
<div class="vault-grid" id="vm-grid">${cards.map((c) =>
  `<a class="vault-card" href="${c.url}" data-slug="${c.slug}" data-total="${c.total}">
<span class="vc-t">${esc(c.title)}</span>
<span class="vc-bar"><i></i></span>
<span class="vc-n">0 / ${c.total}</span>
</a>`).join('')}</div>

<div class="sec-h" style="margin-top:34px">Streak</div>
<div class="streak" id="vm-streak"></div>

<div class="sec-h" id="storage" style="margin-top:34px">Where device-local storage stops working</div>
<div class="tiers">
<div class="tier"><b>Device-local</b><span class="tier-tag now">in use</span>
<p>One JSON blob in <code>localStorage</code>, keyed by doc slug. Survives reloads, costs nothing, needs no account. It is gone if you clear site data, and it does not follow you to your phone.</p></div>
<div class="tier"><b>Portable code</b><span class="tier-tag">not built</span>
<p>Export the same blob as a base64 string you paste into the other browser. Still no server, still no account — but it is a manual sync you have to remember to do.</p></div>
<div class="tier"><b>Account sync</b><span class="tier-tag">not built</span>
<p>The first point that needs a backend, and the first point this stops being a static site. Worth it only if you want history across devices; not worth it for a personal vault.</p></div>
</div>

<div class="vm-danger">
<button id="vm-reset" class="chip" type="button">Reset all progress</button>
<span class="row-m">Clears the blob for every doc. Cannot be undone.</span>
</div>
</section>
<script src="/assets/progress.js" defer></script>`;

  const out = path.join(SITE, 'progress', 'index.html');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, page({
    title: 'Vault map — InterviewVault',
    desc: 'Your practice coverage across the interview-answer docs, stored on this device.',
    body,
  }));
}

/* ── build ─────────────────────────────────────────────── */
function build() {
  for (const d of ['answers', 'notes', 'concepts', 'patterns', 'deep-dives', 'breakdowns', 'in-the-wild', 'in-a-hurry', 'dsa', 'progress', 'vault']) {
    rmSync(path.join(SITE, d), { recursive: true, force: true });
  }
  mkdirSync(path.join(SITE, 'assets'), { recursive: true });

  for (const c of COLLECTIONS) {
    const sibs = docsForCollection(c);
    sibs.forEach((d, i) => buildDocPage(d, sibs, i));
  }
  buildPortfolio();
  buildIndex();
  buildProgressPage();

  copyFileSync(path.join(TPL, 'site.css'), path.join(SITE, 'assets', 'site.css'));
  copyFileSync(path.join(TPL, 'home.js'), path.join(SITE, 'assets', 'home.js'));
  copyFileSync(path.join(TPL, 'game.js'), path.join(SITE, 'assets', 'game.js'));
  copyFileSync(path.join(TPL, 'doc.js'), path.join(SITE, 'assets', 'doc.js'));
  copyFileSync(path.join(TPL, 'vault.js'), path.join(SITE, 'assets', 'vault.js'));
  copyFileSync(path.join(TPL, 'progress.js'), path.join(SITE, 'assets', 'progress.js'));
  copyFileSync(path.join(TPL, 'favicon.svg'), path.join(SITE, 'assets', 'favicon.svg'));
  copyFileSync(path.join(TPL, 'cartman.png'), path.join(SITE, 'assets', 'cartman.png'));
  for (const f of ['_headers', '_redirects', 'robots.txt']) {
    if (existsSync(path.join(TPL, f))) copyFileSync(path.join(TPL, f), path.join(SITE, f));
  }
  // sitemap
  const origin = process.env.SITE_ORIGIN || 'https://interviewvault.pages.dev';
  const urls = ['/', VAULT, ...docs.map((d) => d.url)];
  writeFileSync(path.join(SITE, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n') + `\n</urlset>\n`);

  const missing = docs.reduce((a, d) => a + (extractMermaid(d.md).filter((s) => !existsSync(path.join(DIAGRAMS, hashOf(s) + '.svg'))).length), 0);
  console.log(`built ${docs.length} pages · ${copiedAssets.size} assets copied · ${missing} diagrams missing`);
  for (const c of COLLECTIONS) console.log(`  ${String(docs.filter((d) => d.col.key === c.key).length).padStart(3)}  ${c.label}`);
}

build();
