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
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;600&display=swap" rel="stylesheet">`;

const header = (active) => `<header class="hdr"><div class="hdr-in">
<a class="brand" href="/"><span class="brand-mark">IV</span><span class="brand-name">Interview<span>Vault</span></span></a>
<nav class="hdr-nav">${COLLECTIONS.filter((c) => c.key !== 'quickref')
  .map((c) => `<a href="/#${c.key}"${active === c.key ? ' aria-current="page"' : ''}>${c.label}</a>`).join('')}</nav>
</div></header>`;

const footer = () => `<footer class="foot"><div class="foot-in">
<span>InterviewVault — system design study vault</span>
<span>${docs.length} documents · ${docs.reduce((a, d) => a + d.diagrams, 0)} diagrams</span>
</div></footer>`;

function page({ title, desc, body, active, cls = '' }) {
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
${header(active)}
${body}
${footer()}
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
    return `<a class="node" href="/#${key}" role="link" aria-label="${label}, ${c} documents">
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

/* ── index page ────────────────────────────────────────── */
function buildIndex() {
  const counts = Object.fromEntries(COLLECTIONS.map((c) => [c.key, docs.filter((d) => d.col.key === c.key).length]));
  const totalDiagrams = docs.reduce((a, d) => a + d.diagrams, 0);
  const totalFigures = docs.reduce((a, d) => a + d.images, 0);
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

  const body = `<section class="hero blueprint"><div class="hero-in">
<div class="eyebrow">System design · study vault</div>
<h1>Everything I know about <em>designing systems</em>, in one place.</h1>
<p class="hero-sub">Worked breakdowns, pattern cheat-sheets and long-form notes — written to be read the week before an interview, and re-read the morning of.</p>
<div class="stats">
<div class="stat"><b>${docs.length}</b><span>Documents</span></div>
<div class="stat"><b>${totalDiagrams}</b><span>Diagrams</span></div>
<div class="stat"><b>${totalFigures}</b><span>Figures</span></div>
<div class="stat"><b>${Math.round(totalWords / 1000)}k</b><span>Words</span></div>
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
<script src="/assets/home.js" defer></script>`;

  writeFileSync(path.join(SITE, 'index.html'), page({
    title: 'InterviewVault — System Design Study Vault',
    desc: `${docs.length} worked system-design documents: patterns, deep dives, problem breakdowns and interview answers.`,
    body, cls: '',
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
  for (const d of ['answers', 'notes', 'concepts', 'patterns', 'deep-dives', 'breakdowns', 'in-the-wild', 'in-a-hurry', 'dsa', 'progress']) {
    rmSync(path.join(SITE, d), { recursive: true, force: true });
  }
  mkdirSync(path.join(SITE, 'assets'), { recursive: true });

  for (const c of COLLECTIONS) {
    const sibs = docsForCollection(c);
    sibs.forEach((d, i) => buildDocPage(d, sibs, i));
  }
  buildIndex();
  buildProgressPage();

  copyFileSync(path.join(TPL, 'site.css'), path.join(SITE, 'assets', 'site.css'));
  copyFileSync(path.join(TPL, 'home.js'), path.join(SITE, 'assets', 'home.js'));
  copyFileSync(path.join(TPL, 'doc.js'), path.join(SITE, 'assets', 'doc.js'));
  copyFileSync(path.join(TPL, 'vault.js'), path.join(SITE, 'assets', 'vault.js'));
  copyFileSync(path.join(TPL, 'progress.js'), path.join(SITE, 'assets', 'progress.js'));
  copyFileSync(path.join(TPL, 'favicon.svg'), path.join(SITE, 'assets', 'favicon.svg'));
  for (const f of ['_headers', '_redirects', 'robots.txt']) {
    if (existsSync(path.join(TPL, f))) copyFileSync(path.join(TPL, f), path.join(SITE, f));
  }
  // sitemap
  const origin = process.env.SITE_ORIGIN || 'https://interviewvault.pages.dev';
  const urls = ['/', ...docs.map((d) => d.url)];
  writeFileSync(path.join(SITE, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${origin}${u}</loc></url>`).join('\n') + `\n</urlset>\n`);

  const missing = docs.reduce((a, d) => a + (extractMermaid(d.md).filter((s) => !existsSync(path.join(DIAGRAMS, hashOf(s) + '.svg'))).length), 0);
  console.log(`built ${docs.length} pages · ${copiedAssets.size} assets copied · ${missing} diagrams missing`);
  for (const c of COLLECTIONS) console.log(`  ${String(docs.filter((d) => d.col.key === c.key).length).padStart(3)}  ${c.label}`);
}

build();
