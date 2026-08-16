// Fail if the portfolio landing page grows a looping animation that the motion
// pause button cannot stop.
//   node check-motion.mjs        (source gate — reads tools/template/site.css)
//
// WHY THIS EXISTS. The page animates forever, so WCAG 2.2.2 requires a mechanism
// to stop it. That mechanism is one custom property, --amb, which portfolio.js
// flips to `paused`. An animation only obeys it if the declaration binds it:
//
//     animation: pf-sway 6s ease-in-out infinite var(--amb, running);
//                                                ^^^^^^^^^^^^^^^^^^^
//
// Two failures shipped before this gate existed and neither was visible in a
// diff. First, animations that simply never carried the binding (.pf-sun,
// .pf-cloud). Second — the subtle one — rules that set the binding as a lone
// `animation-play-state` longhand and were then overwritten by a LATER
// `animation:` shorthand at equal specificity, because the shorthand resets every
// animation-* longhand it does not name. Both look fine; both leave the button
// lying to the reader. So the rule enforced here is deliberately blunt:
//
//     any rule in the portfolio block whose declarations mention `infinite`
//     must also mention `var(--amb` in that same rule.
//
// Binding inside the shorthand is what satisfies it robustly, since the binding
// then travels with the declaration and no later shorthand can strip it.
//
// SMIL (<animateMotion>: .pf-rabbit, .pf-pond, .pf-gondola) is out of scope — it
// is paused by pauseAnimations() in portfolio.js and has no CSS animation to
// carry a binding. It is invisible to this check precisely because it declares
// no animation.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = path.resolve(__dirname, 'template', 'site.css');
// the comment that opens the landing-page section of the stylesheet
const MARKER = 'portfolio landing page';

const raw = readFileSync(CSS, 'utf8');
const markerAt = raw.indexOf(MARKER);
if (markerAt === -1) {
  console.error(`check-motion: cannot find the "${MARKER}" marker in ${path.relative(process.cwd(), CSS)}.`);
  console.error('If that section was renamed, update MARKER here — do not delete the gate.');
  process.exit(1);
}

// Strip comments but keep newlines, so reported line numbers stay true.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const lineOf = (index) => css.slice(0, index).split('\n').length;

// Walk balanced braces from `start` to `end`, yielding { selector, body, at }
// for every style rule. At-rules that wrap other rules (@media, @supports) are
// recursed into; @keyframes is skipped, since its blocks are frames, not rules.
function rules(start, end, acc = []) {
  let i = start;
  while (i < end) {
    const open = css.indexOf('{', i);
    if (open === -1 || open >= end) break;
    let depth = 0, close = -1;
    for (let j = open; j < end; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { close = j; break; }
    }
    if (close === -1) break;

    const prelude = css.slice(i, open).trim();
    if (/^@(?:media|supports|layer|container|scope)\b/.test(prelude)) rules(open + 1, close, acc);
    else if (!prelude.startsWith('@')) {
      acc.push({ selector: prelude.replace(/\s+/g, ' '), body: css.slice(open + 1, close), at: lineOf(open) });
    }
    i = close + 1;
  }
  return acc;
}

const block = rules(markerAt, css.length);
const looping = block.filter((r) => /\binfinite\b/.test(r.body));
const unbound = looping.filter((r) => !r.body.includes('var(--amb'));

// A gate that silently matches nothing is worse than no gate, so refuse to pass
// if the block has no looping animations left to check.
if (!looping.length) {
  console.error('check-motion: found no infinite animations in the portfolio block.');
  console.error('Either the block moved or this gate stopped matching — fix it, do not ignore it.');
  process.exit(1);
}

console.log(`rules ${block.length} · looping animations ${looping.length} · pause-bound ${looping.length - unbound.length}`);

if (unbound.length) {
  console.error(`\n${unbound.length} looping animation(s) the motion pause button cannot stop:`);
  for (const r of unbound) {
    console.error(`  site.css:${r.at}  ${r.selector}`);
    console.error('    → end the animation shorthand with var(--amb, running)');
  }
  process.exit(1);
}
console.log('motion OK — every looping portfolio animation is bound to --amb');
