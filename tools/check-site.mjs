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
const challengePayloads = [];

for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  const rel = path.relative(SITE, file).split(path.sep).join('/');

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

  for (const m of html.matchAll(/<script\b[^>]*\bid="iv-challenges"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!rel.startsWith('answers/') && !rel.startsWith('deep-dives/')) {
      problems.push(`${rel}: iv-challenges payload is outside answers/ or deep-dives/`);
    }

    let payload;
    try {
      payload = JSON.parse(m[1]);
    } catch (err) {
      problems.push(`${rel}: invalid iv-challenges payload — ${err.message}`);
      continue;
    }

    const shapeProblems = [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      shapeProblems.push('payload must be an object');
    } else {
      if (typeof payload.slug !== 'string' || !payload.slug.trim()) shapeProblems.push('slug must be a non-empty string');
      if (!Array.isArray(payload.checkpoints)) shapeProblems.push('checkpoints must be an array');
      if (!Number.isInteger(payload.authoredCount) || payload.authoredCount < 0) {
        shapeProblems.push('authoredCount must be a nonnegative integer');
      }
    }
    if (shapeProblems.length) {
      problems.push(`${rel}: malformed iv-challenges payload — ${shapeProblems.join('; ')}`);
      continue;
    }

    challengePayloads.push({
      rel,
      slug: payload.slug,
      authoredCount: payload.authoredCount,
      checkpointIds: payload.checkpoints
        .map((checkpoint) => checkpoint?.id)
        .filter((id) => typeof id === 'string'),
    });
  }
}

for (const file of readdirSync(CHALLENGES).filter((f) => f.endsWith('.json'))) {
  let source;
  try {
    source = JSON.parse(readFileSync(path.join(CHALLENGES, file), 'utf8'));
  } catch (err) {
    problems.push(`${file}: invalid authored challenge JSON — ${err.message}`);
    continue;
  }

  if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.slug !== 'string' || !source.slug.trim()
      || !Array.isArray(source.checkpoints)) {
    problems.push(`${file}: malformed authored challenge — expected object with non-empty slug and checkpoints array`);
    continue;
  }

  const slug = source.slug;
  const checkpointIds = source.checkpoints.map((checkpoint) => checkpoint?.id);
  if (checkpointIds.some((id) => typeof id !== 'string' || !id)) {
    problems.push(`${file}: malformed authored challenge ${slug} — every checkpoint needs a non-empty string id`);
    continue;
  }

  const targets = [
    `answers/${slug}/index.html`,
    `deep-dives/${slug}/index.html`,
  ].filter((target) => existsSync(path.join(SITE, target)));
  if (!targets.length) {
    problems.push(`authored challenge ${slug}: no applicable built target page`);
    continue;
  }

  for (const target of targets) {
    const payload = challengePayloads.find((entry) => entry.rel === target && entry.slug === slug);
    if (!payload) {
      problems.push(`authored challenge ${slug}: ${target}: matching iv-challenges payload is missing`);
      continue;
    }
    if (payload.authoredCount !== source.checkpoints.length) {
      problems.push(`authored challenge ${slug}: ${target}: authoredCount ${payload.authoredCount}, expected ${source.checkpoints.length}`);
    }
    const missingIds = checkpointIds.filter((id) => !payload.checkpointIds.includes(id));
    if (missingIds.length) {
      problems.push(`authored challenge ${slug}: ${target}: missing checkpoint IDs ${missingIds.join(', ')}`);
    }
  }
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
