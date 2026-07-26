// Builds the per-doc challenge set that drives the sidecar.
//
// Two sources, merged:
//   1. extracted  — requirements triage and win conditions, pulled out of the
//      markdown you already wrote (In scope / Out of scope, Key Takeaways).
//   2. authored   — content/challenges/<slug>.json, for the mechanics that
//      cannot be derived from headings (duel, ladder, builder, bottleneck).
//
// Authored checkpoints win on id collision.
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const AUTHORED = path.join(REPO, 'content', 'challenges');

const TIER_ORDER = ['mid', 'senior', 'staff'];
const stripEmoji = (s) =>
  s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '').trim();

const clean = (s) =>
  stripEmoji(s)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const listItems = (block) =>
  block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(\d+\.|[-*])\s+/.test(l))
    .map((l) => clean(l.replace(/^(\d+\.|[-*])\s+/, '')))
    .filter((l) => l.length > 8 && l.length < 160);

/** "A user can submit a long URL and receive a shortened URL." -> a scannable chip */
function condense(text) {
  let t = text.replace(/\.$/, '');
  t = t.replace(/^(A|An|The)\s+/i, '');
  t = t.replace(/^users? (should be able to|can|may)\s+/i, '');
  t = t.replace(/^(rider|driver|client|anyone|user)\s+(can|should|may)\s+/i, '');
  if (t.length > 96) t = t.slice(0, 93).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The real Functional Requirements section, skipping the table of contents. */
function frSection(md) {
  const m = md.match(/^#{2,3}\s+[^\n]*Functional Requirements\s*$([\s\S]*?)(?=^#{2,3}\s|\Z)/m);
  return m ? m[1] : null;
}

/**
 * Requirements triage: the doc's own above/below-the-line lists.
 * Three headings are in use across the vault — "In scope", "Core", and
 * "Core Requirements" — so split on whatever marks the out-of-scope half.
 */
function extractTriage(md) {
  const body = frSection(md);
  if (!body) return null;
  // the label is bold in most docs and an H4 in a couple
  const split = body.match(/^(?:\*\*|#{4}\s+)(?:Out of scope|Below the [Ll]ine)[^\n]*$/m);
  if (!split) return null;

  const above = body.slice(0, split.index);
  const below_ = body.slice(split.index + split[0].length);

  // drop the "In scope" / "Core" label line itself
  const aboveStart = above.search(/^(?:\*\*|#{4}\s+)(?:In[- ]scope|Core)[^\n]*$/m);
  const aboveBody = aboveStart >= 0 ? above.slice(aboveStart) : above;

  const core = listItems(aboveBody).map((t) => ({ text: condense(t), answer: 'core' }));
  const below = listItems(below_).map((t) => ({ text: condense(t), answer: 'below' }));
  if (core.length < 2 || below.length < 2) return null;

  // interleave so the answer pattern is not a giveaway
  const items = [];
  const max = Math.max(core.length, below.length);
  for (let i = 0; i < max; i++) {
    if (core[i]) items.push(core[i]);
    if (below[i]) items.push(below[i]);
  }
  return {
    id: 'requirements',
    type: 'triage',
    tier: 'mid',
    title: 'Requirements triage',
    xp: 60,
    prompt: 'Above or below the line?',
    timeLimitSec: 15 + items.length * 4,
    items: items.slice(0, 10),
  };
}

/**
 * Win conditions. The interview-answer docs carry "Insider Tips and Tricks" —
 * each H3 there is a point the answer is expected to land — while the scraped
 * docs use a "Key Takeaways" bullet list. Accept either.
 */
function extractRecall(md) {
  const i = md.search(/^##\s+[^\n]*(?:Insider Tips|Key Takeaways)/m);
  if (i < 0) return null;
  const rest = md.slice(i + 3);
  const end = rest.search(/\n##\s/);
  const body = end > 0 ? rest.slice(0, end) : rest;

  // H3 headings first (Insider Tips), else bullets (Key Takeaways)
  let items = [...body.matchAll(/^###\s+(.+)$/gm)].map((m) => clean(m[1])).filter(Boolean);
  if (items.length < 3) items = listItems(body);
  if (items.length < 3) return null;
  return {
    id: 'recall',
    type: 'recall',
    tier: 'mid',
    title: 'Win conditions',
    xp: 40,
    prompt: 'The points this design is expected to land. Tick what you could defend right now.',
    items: items.slice(0, 8).map((t) => ({ text: t })),
  };
}

/** Deep dives become the tier-scoped level list shown in the sidecar. */
function extractLevels(md) {
  const i = md.search(/^##\s+[^\n]*Deep Dives/m);
  if (i < 0) return [];
  const rest = md.slice(i + 3);
  const end = rest.search(/\n##\s/);
  const body = end > 0 ? rest.slice(0, end) : rest;
  return [...body.matchAll(/^###\s+(.+)$/gm)]
    .map((m) => clean(m[1]).replace(/^\d+\.\s*/, ''))
    .filter(Boolean)
    .slice(0, 10);
}

export function buildChallenges(mdPath, slug) {
  const md = readFileSync(mdPath, 'utf8');
  const extracted = [extractTriage(md), extractRecall(md)].filter(Boolean);

  let authored = [];
  const file = path.join(AUTHORED, `${slug}.json`);
  if (existsSync(file)) {
    try {
      authored = JSON.parse(readFileSync(file, 'utf8')).checkpoints || [];
    } catch (err) {
      throw new Error(`${slug}.json is not valid JSON: ${err.message}`);
    }
  }

  const byId = new Map();
  for (const cp of extracted) byId.set(cp.id, cp);
  for (const cp of authored) byId.set(cp.id, cp); // authored wins

  const checkpoints = [...byId.values()].sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)
  );

  return {
    slug,
    levels: extractLevels(md),
    checkpoints,
    authoredCount: authored.length,
  };
}

export function authoredSlugs() {
  if (!existsSync(AUTHORED)) return [];
  return readdirSync(AUTHORED).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}
