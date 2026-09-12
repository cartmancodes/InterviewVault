// Pre-renders every ```mermaid block in the docs to a static SVG.
// One Chrome session for all diagrams; output is content-hashed so rebuilds are incremental.
//   node render-diagrams.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { diagramHash, normalizeMermaid, MERMAID_CONFIG } from './diagram-theme.mjs';
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

export const hashOf = diagramHash;
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
  await page.setContent('<!DOCTYPE html><html><body><div id="c"></div></body></html>');
  await page.addScriptTag({ path: MERMAID_JS });
  await page.evaluate(config => window.mermaid.initialize(config), MERMAID_CONFIG);
  await page.evaluate(() => document.fonts.ready);

  let ok = 0, fail = 0;
  for (const [hash, src] of todo) {
    const res = await page.evaluate(async (id, code) => {
      try {
        const { svg } = await window.mermaid.render('m' + id, code);
        return { svg };
      } catch (e) { return { err: String((e && e.message) || e).split('\n')[0] }; }
    }, hash, normalizeMermaid(src));
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
