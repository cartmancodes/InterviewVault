// Fail if the built site has a broken internal link, a missing asset, or a
// table-of-contents anchor that points nowhere.
//   node check-site.mjs        (run after build-site.mjs)
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(__dirname, '..', 'site');
const CHALLENGES = path.resolve(__dirname, '..', 'content', 'challenges');
const AUTHORED_CONTRACT = {
  tradeoff: { type: 'duel', tier: 'senior', xp: 80 },
  capacity: { type: 'ladder', tier: 'senior', xp: 70 },
  architecture: { type: 'builder', tier: 'staff', xp: 100 },
  bottleneck: { type: 'bottleneck', tier: 'staff', xp: 90 },
};

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

function checkpointIds(checkpoints) {
  const ids = [], issues = [], seen = new Set();
  checkpoints.forEach((checkpoint, index) => {
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      issues.push(`checkpoint ${index + 1} must be a non-null object`);
      return;
    }
    if (typeof checkpoint.id !== 'string' || !checkpoint.id.trim()) {
      issues.push(`checkpoint ${index + 1} id must be a non-empty string`);
      return;
    }
    if (seen.has(checkpoint.id)) issues.push(`duplicate checkpoint id "${checkpoint.id}"`);
    seen.add(checkpoint.id);
    ids.push(checkpoint.id);
  });
  return { ids, issues };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionIssues(options, label, exactlyOneCorrect = false) {
  const issues = [];
  if (!Array.isArray(options) || options.length < 2) return [`${label} must be an array with at least 2 entries`];
  options.forEach((option, index) => {
    if (!isObject(option)) {
      issues.push(`${label}[${index}] must be an object`);
      return;
    }
    if (typeof option.label !== 'string' || !option.label.trim()) issues.push(`${label}[${index}].label must be a non-empty string`);
    if (typeof option.correct !== 'boolean') issues.push(`${label}[${index}].correct must be boolean`);
  });
  if (exactlyOneCorrect && options.filter((option) => isObject(option) && option.correct === true).length !== 1) {
    issues.push(`${label} must contain exactly one correct option`);
  }
  return issues;
}

function mechanicIssues(checkpoint) {
  const issues = [];
  if (checkpoint.id === 'tradeoff') {
    issues.push(...optionIssues(checkpoint.options, 'options', true));
    if (!isObject(checkpoint.defend)) issues.push('defend must be an object');
    else issues.push(...optionIssues(checkpoint.defend.options, 'defend.options'));
  } else if (checkpoint.id === 'capacity') {
    if (!Array.isArray(checkpoint.rungs) || !checkpoint.rungs.length) return ['rungs must be a non-empty array'];
    checkpoint.rungs.forEach((rung, index) => {
      if (!isObject(rung)) {
        issues.push(`rungs[${index}] must be an object`);
        return;
      }
      if (!Array.isArray(rung.choices) || rung.choices.length < 2) {
        issues.push(`rungs[${index}].choices must be an array with at least 2 entries`);
      }
      if (!Number.isInteger(rung.answer)
          || !Array.isArray(rung.choices)
          || rung.answer < 0
          || rung.answer >= rung.choices.length) {
        issues.push(`rungs[${index}].answer must be an integer within choices bounds`);
      }
    });
  } else if (checkpoint.id === 'architecture') {
    const palette = checkpoint.palette;
    const paletteValues = new Set();
    if (!Array.isArray(palette) || !palette.length) issues.push('palette must be a non-empty array');
    else palette.forEach((entry, index) => {
      if (typeof entry !== 'string' || !entry.trim()) issues.push(`palette[${index}] must be a non-empty string`);
      else if (paletteValues.has(entry)) issues.push(`palette contains duplicate "${entry}"`);
      else paletteValues.add(entry);
    });

    const accepts = new Set();
    if (!Array.isArray(checkpoint.slots) || !checkpoint.slots.length) issues.push('slots must be a non-empty array');
    else checkpoint.slots.forEach((slot, index) => {
      if (!isObject(slot)) {
        issues.push(`slots[${index}] must be an object`);
        return;
      }
      if (typeof slot.accept !== 'string' || !slot.accept.trim()) {
        issues.push(`slots[${index}].accept must be a non-empty string`);
        return;
      }
      if (!paletteValues.has(slot.accept)) issues.push(`slots[${index}].accept "${slot.accept}" is not in palette`);
      if (accepts.has(slot.accept)) issues.push(`slots contain duplicate accept "${slot.accept}"`);
      accepts.add(slot.accept);
    });
  } else if (checkpoint.id === 'bottleneck') {
    const cardNames = [];
    const seen = new Set();
    if (!Array.isArray(checkpoint.cards) || checkpoint.cards.length < 2) issues.push('cards must be an array with at least 2 entries');
    else checkpoint.cards.forEach((card, index) => {
      if (!isObject(card)) {
        issues.push(`cards[${index}] must be an object`);
        return;
      }
      if (typeof card.name !== 'string' || !card.name.trim()) {
        issues.push(`cards[${index}].name must be a non-empty string`);
        return;
      }
      if (seen.has(card.name)) issues.push(`cards contain duplicate name "${card.name}"`);
      seen.add(card.name);
      cardNames.push(card.name);
    });
    if (typeof checkpoint.answer !== 'string' || !cardNames.includes(checkpoint.answer)) {
      issues.push('answer must match a card name');
    }
    if (!isObject(checkpoint.wrong)) issues.push('wrong must be an object');
    else {
      const expected = cardNames.filter((name) => name !== checkpoint.answer);
      const actual = Object.keys(checkpoint.wrong);
      const missing = expected.filter((name) => !actual.includes(name));
      const extra = actual.filter((name) => !expected.includes(name));
      if (missing.length || extra.length) {
        issues.push(`wrong keys must equal non-answer card names (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
      }
    }
  }
  return issues;
}

if (!existsSync(SITE)) {
  console.error('site/ does not exist — run build-site.mjs first');
  process.exit(1);
}

const pages = htmlFiles(SITE);
let links = 0, assets = 0, anchors = 0;
const problems = [];
const challengePayloads = [];
const challengePayloadCounts = new Map();
const authoredSlugs = new Set();

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

  const payloadMatches = [...html.matchAll(/<script\b[^>]*\bid="iv-challenges"[^>]*>([\s\S]*?)<\/script>/g)];
  challengePayloadCounts.set(rel, payloadMatches.length);
  if (payloadMatches.length > 1 && (rel.startsWith('answers/') || rel.startsWith('deep-dives/'))) {
    problems.push(`${rel}: expected exactly one iv-challenges payload, found ${payloadMatches.length}`);
  }

  for (const m of payloadMatches) {
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
      if (Array.isArray(payload.checkpoints)) shapeProblems.push(...checkpointIds(payload.checkpoints).issues);
    }
    if (shapeProblems.length) {
      problems.push(`${rel}: malformed iv-challenges payload — ${shapeProblems.join('; ')}`);
      continue;
    }

    challengePayloads.push({
      rel,
      slug: payload.slug,
      authoredCount: payload.authoredCount,
      checkpointIds: checkpointIds(payload.checkpoints).ids,
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
  const basename = file.slice(0, -5);
  const sourceCheckpoints = checkpointIds(source.checkpoints);
  const sourceIssues = [...sourceCheckpoints.issues];
  if (basename !== slug) sourceIssues.push(`filename slug "${basename}" must equal source.slug "${slug}"`);
  if (source.checkpoints.length !== 4) sourceIssues.push(`checkpoints must contain exactly 4 entries, found ${source.checkpoints.length}`);
  if (!sourceCheckpoints.issues.length) {
    const byId = new Map(source.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    for (const [id, contract] of Object.entries(AUTHORED_CONTRACT)) {
      const checkpoint = byId.get(id);
      if (!checkpoint) {
        sourceIssues.push(`missing standard checkpoint "${id}"`);
        continue;
      }
      if (checkpoint.type !== contract.type) sourceIssues.push(`${id}.type must be "${contract.type}"`);
      if (checkpoint.tier !== contract.tier) sourceIssues.push(`${id}.tier must be "${contract.tier}"`);
      if (checkpoint.xp !== contract.xp) sourceIssues.push(`${id}.xp must be ${contract.xp}`);
      sourceIssues.push(...mechanicIssues(checkpoint).map((issue) => `${id}.${issue}`));
    }
    for (const id of sourceCheckpoints.ids) {
      if (!AUTHORED_CONTRACT[id]) sourceIssues.push(`unexpected checkpoint id "${id}"`);
    }
  }
  if (sourceIssues.length) {
    problems.push(`${file}: malformed authored challenge ${slug} — ${sourceIssues.join('; ')}`);
    continue;
  }
  authoredSlugs.add(slug);

  const targets = [
    `answers/${slug}/index.html`,
    `deep-dives/${slug}/index.html`,
  ].filter((target) => existsSync(path.join(SITE, target)));
  if (!targets.length) {
    problems.push(`authored challenge ${slug}: no applicable built target page`);
    continue;
  }

  for (const target of targets) {
    const count = challengePayloadCounts.get(target) || 0;
    if (count !== 1) {
      problems.push(`authored challenge ${slug}: ${target}: expected exactly one iv-challenges payload, found ${count}`);
      continue;
    }
    const payload = challengePayloads.find((entry) => entry.rel === target && entry.slug === slug);
    if (!payload) {
      problems.push(`authored challenge ${slug}: ${target}: matching iv-challenges payload is missing`);
      continue;
    }
    if (payload.authoredCount !== source.checkpoints.length) {
      problems.push(`authored challenge ${slug}: ${target}: authoredCount ${payload.authoredCount}, expected ${source.checkpoints.length}`);
    }
    const missingIds = sourceCheckpoints.ids.filter((id) => !payload.checkpointIds.includes(id));
    if (missingIds.length) {
      problems.push(`authored challenge ${slug}: ${target}: missing checkpoint IDs ${missingIds.join(', ')}`);
    }
  }
}

for (const payload of challengePayloads.filter((entry) => entry.rel.startsWith('deep-dives/'))) {
  if (!authoredSlugs.has(payload.slug)) {
    problems.push(`${payload.rel}: deep-dive payload slug "${payload.slug}" has no matching authored source`);
  }
  if (payload.authoredCount <= 0) {
    problems.push(`${payload.rel}: deep-dive payload authoredCount must be greater than 0`);
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
