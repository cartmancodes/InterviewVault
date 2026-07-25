// Fail if the built site has a broken internal link, a missing asset, or a
// table-of-contents anchor that points nowhere.
//   node check-site.mjs        (run after build-site.mjs)
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..', 'site');

function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) htmlFiles(p, acc);
    else if (entry.endsWith('.html')) acc.push(p);
  }
  return acc;
}

function resolve(ref) {
  if (ref === '/') return path.join(SITE, 'index.html');
  if (ref.endsWith('/')) return path.join(SITE, ref, 'index.html');
  return path.join(SITE, ref);
}

if (!existsSync(SITE)) {
  console.error('site/ does not exist — run build-site.mjs first');
  process.exit(1);
}

const pages = htmlFiles(SITE);
let links = 0, assets = 0, anchors = 0;
const problems = [];

for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  const rel = path.relative(SITE, file);

  for (const m of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
    const ref = m[1].split('#')[0];
    if (!ref) continue;
    if (ref.startsWith('/assets/')) {
      assets++;
      if (!existsSync(resolve(ref))) problems.push(`${rel}: missing asset ${ref}`);
    } else {
      links++;
      if (!existsSync(resolve(ref))) problems.push(`${rel}: broken link ${ref}`);
    }
  }

  // same-page anchors must have a target
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/href="#([^"]+)"/g)) {
    anchors++;
    if (!ids.has(decodeURIComponent(m[1]))) problems.push(`${rel}: dead anchor #${m[1]}`);
  }
}

console.log(`pages ${pages.length} · links ${links} · assets ${assets} · anchors ${anchors}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  if (problems.length > 40) console.error(`  …and ${problems.length - 40} more`);
  process.exit(1);
}
console.log('site OK — no broken links, missing assets or dead anchors');
