// Pre-renders every ```mermaid block in the docs to a static SVG.
// One Chrome session for all diagrams; output is content-hashed so rebuilds are incremental.
//   node render-diagrams.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'site', 'assets', 'diagrams');
const MERMAID_JS = path.join(__dirname, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const DOC_ROOTS = ['LLD/CoreConcepts', 'LLD/questions', 'LLD/SystemDesign', 'DSA'];

export function walkMarkdown(dir, acc = []) {
  const abs = path.join(REPO, dir);
  if (!existsSync(abs)) return acc;
  for (const e of readdirSync(abs)) {
    const p = path.join(abs, e);
    const rel = path.relative(REPO, p);
    if (statSync(p).isDirectory()) walkMarkdown(rel, acc);
    else if (e.endsWith('.md')) acc.push(rel);
  }
  return acc;
}

export const hashOf = (src) => createHash('sha1').update(src).digest('hex').slice(0, 16);
export const extractMermaid = (md) =>
  [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = DOC_ROOTS.flatMap((d) => walkMarkdown(d));
  const blocks = new Map(); // hash -> source
  for (const f of files) {
    for (const src of extractMermaid(readFileSync(path.join(REPO, f), 'utf8'))) {
      blocks.set(hashOf(src), src);
    }
  }
  const todo = [...blocks].filter(([h]) => !existsSync(path.join(OUT, `${h}.svg`)));
  console.log(`${blocks.size} unique diagrams · ${todo.length} to render · ${blocks.size - todo.length} cached`);
  if (!todo.length) return;

  const browser = await puppeteer.launch({
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  await page.setContent(`<!DOCTYPE html><html><head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
    </head><body><div id="c"></div></body></html>`, { waitUntil: 'networkidle0' });
  await page.addScriptTag({ path: MERMAID_JS });
  await page.evaluate(() => {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
      // Construction paper, matching site.css: pale-yellow cutouts with 2px ink
      // outlines and ink connectors. Diagrams sit on the WHITE article surface
      // (.diagram is #FCFDFF inside .art), never on a sky band, so every label
      // is ink: 16.05:1 on the --acc-wash node fill, 17.48:1 on --paper,
      // 15.80:1 on the --sky-wash cluster fill, 17.18:1 on the .diagram inset.
      themeVariables: {
        background: 'transparent',
        primaryColor: '#FFF6C9',        // --acc-wash — the node fill
        primaryTextColor: '#0E1A2B',    // --ink
        primaryBorderColor: '#0E1A2B',  // --ink
        secondaryColor: '#FFFFFF',      // --paper
        secondaryTextColor: '#0E1A2B',
        secondaryBorderColor: '#0E1A2B',
        tertiaryColor: '#EAF5FD',       // --sky-wash — subgraph / cluster fill
        tertiaryTextColor: '#0E1A2B',
        tertiaryBorderColor: '#0E1A2B',
        lineColor: '#0E1A2B',
        textColor: '#0E1A2B',
        fontSize: '14px',
      },
      // Mermaid has no theme variable for stroke width, and a 1px hairline is
      // not the cutout look. themeCSS is emitted scoped to the diagram's own
      // `#m<hash>` id, so it cannot leak onto the vault map's .node rect.
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node polygon, .node path,
        .cluster rect, .actor, .labelBox, .er.entityBox, .note { stroke-width: 2px; }
        .edgePath .path, .flowchart-link, .messageLine0, .messageLine1,
        .transition, .relationshipLine, .er.relationshipLine { stroke-width: 1.5px; }
      `,
    });
  });

  let ok = 0, fail = 0;
  for (const [hash, src] of todo) {
    const res = await page.evaluate(async (id, code) => {
      try {
        const { svg } = await window.mermaid.render('m' + id, code);
        return { svg };
      } catch (e) { return { err: String((e && e.message) || e).split('\n')[0] }; }
    }, hash, src);
    if (res.svg) {
      // keep intrinsic size but let it scale down responsively
      const svg = res.svg
        .replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" ')
        .replace(/style="max-width:\s*([\d.]+)px;?/, 'style="max-width:$1px;width:100%;height:auto;');
      writeFileSync(path.join(OUT, `${hash}.svg`), svg);
      ok++;
    } else {
      fail++;
      console.log(`  FAIL ${hash}: ${res.err}`);
      console.log(`       ${src.split('\n')[0].slice(0, 70)}`);
    }
    if ((ok + fail) % 50 === 0) console.log(`  ...${ok + fail}/${todo.length}`);
  }
  await browser.close();
  console.log(`rendered ${ok}, failed ${fail}`);
  // a diagram that will not render is a broken doc — fail the build
  if (fail) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
