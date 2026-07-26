// Fail if the built site has a broken internal link, a missing asset, or a
// table-of-contents anchor that points nowhere.
//   node check-site.mjs        (run after build-site.mjs)
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..', 'site');
const CHALLENGES = path.resolve(__dirname, '..', 'content', 'challenges');

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
const embeddedChallengeSlugs = new Set();

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

  for (const m of html.matchAll(/<script type="application\/json" id="iv-challenges">([^<]*)<\/script>/g)) {
    try {
      embeddedChallengeSlugs.add(JSON.parse(m[1]).slug);
    } catch (err) {
      problems.push(`${rel}: invalid iv-challenges payload — ${err.message}`);
    }
  }
}

for (const file of readdirSync(CHALLENGES).filter((f) => f.endsWith('.json'))) {
  const slug = file.slice(0, -5);
  if (!embeddedChallengeSlugs.has(slug)) problems.push(`authored challenge slug is unreachable: ${slug}`);
}

// client scripts must at least parse — a broken one silently kills the sidecar
let scripts = 0;
for (const js of readdirSync(path.join(SITE, 'assets')).filter((f) => f.endsWith('.js'))) {
  scripts++;
  const src = readFileSync(path.join(SITE, 'assets', js), 'utf8');
  try { new Function(src); } catch (err) { problems.push(`assets/${js}: does not parse — ${err.message}`); }
}

console.log(`pages ${pages.length} · links ${links} · assets ${assets} · anchors ${anchors} · scripts ${scripts}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  if (problems.length > 40) console.error(`  …and ${problems.length - 40} more`);
  process.exit(1);
}
console.log('site OK — no broken links, missing assets or dead anchors');
