/** Conservative Excalidraw palette migration. Geometry, labels and font metrics stay intact. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const palette = Object.freeze({
  '#1e1e1e': '#0E1A2B', '#343a40': '#0E1A2B',
  '#1971c2': '#245B85', '#2f9e44': '#176349', '#e03131': '#A1273E', '#f08c00': '#85520B',
  '#a5d8ff': '#EAF5FD', '#b2f2bb': '#DDF3EC', '#ffec99': '#FFF6C9', '#ffc9c9': '#FCE5EA', '#d0bfff': '#EDE8FA', '#eebefa': '#EDE8FA',
});
export function normalizeSvg(source) {
  if (!source.includes('svg-source:excalidraw')) return source;
  // Restrict replacements to presentation attributes; embedded artwork/data and CSS remain authentic.
  return source.replace(/\b(fill|stroke)=(['"])(#[a-f\d]{6})\2/gi, (full, attr, quote, color) =>
    palette[color.toLowerCase()] ? `${attr}=${quote}${palette[color.toLowerCase()]}${quote}` : full)
    // Light gray explanatory labels disappeared against white. Keep pale shape
    // fills intact; only text and connector strokes get the stronger neutral.
    .replace(/<text\b[^>]*>/g, tag => tag.replace(/fill="(?:#868e96|#adb5bd|#74808b)"/gi, 'fill="#4F5F79"'))
    .replace(/stroke="(?:#868e96|#adb5bd|#74808b)"/gi, 'stroke="#4F5F79"');
}
export function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)]).sort();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let changed = 0;
  for (const file of filesUnder('LLD').filter(file => /\/assets\/.*\.svg$/.test(file))) {
    const before = fs.readFileSync(file, 'utf8');
    const after = normalizeSvg(before);
    if (before !== after) { changed++; if (!process.argv.includes('--check')) fs.writeFileSync(file, after); }
  }
  console.log(`${changed} SVG files ${process.argv.includes('--check') ? 'need normalization' : 'normalized'}; fonts and geometry preserved.`);
  if (process.argv.includes('--check') && changed) process.exitCode = 1;
}
// Optional browser-measured typography migration. Original Excalidraw group bounds
// constrain each line; emoji and lines without a trustworthy box retain their font.
if (process.argv.includes('--fonts')) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  let migrated = 0, retained = 0;
  const exceptions = [];
  for (const file of filesUnder('LLD').filter(file => /\/assets\/.*\.svg$/.test(file))) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('svg-source:excalidraw')) continue;
    const decisions = await page.evaluate(source => {
      const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      return [...xml.querySelectorAll('text')].map(text => {
        const family = text.getAttribute('font-family') || '';
        if (family.startsWith('Arial') || family === 'Segoe UI Emoji') return { skip: true };
        const rotation = text.parentElement.getAttribute('transform')?.match(/rotate\(\s*[-\d.e]+[ ,]+([-\d.e]+)[ ,]+([-\d.e]+)\)/);
        const width = rotation ? Number(rotation[1]) * 2 : 0;
        const height = rotation ? Number(rotation[2]) * 2 : 0;
        const size = parseFloat(text.getAttribute('font-size'));
        const label = text.textContent;
        if (!label.trim()) return { skip: true };
        ctx.font = `${size}px Arial`;
        const metrics = ctx.measureText(label);
        const safe = width > 0 && height >= size && metrics.width <= width * 1.15 && !/\p{Extended_Pictographic}/u.test(label);
        return { safe, label, width: Math.round(width * 1000) / 1000, constrain: metrics.width > width, measuredWidth: Math.round(metrics.width * 1000) / 1000 };
      });
    }, source);
    let index = 0;
    const after = source.replace(/<text\b[^>]*>/g, tag => {
      const decision = decisions[index++];
      if (decision.skip) return tag;
      if (!decision.safe) { retained++; exceptions.push({ file, ...decision }); return tag; }
      migrated++;
      tag = tag.replace(/font-family="[^"]*"/, 'font-family="Arial, Helvetica, sans-serif"');
      if (decision.constrain) tag = tag.replace(/>$/, ` textLength="${decision.width}" lengthAdjust="spacingAndGlyphs">`);
      return tag;
    });
    if (after !== source) fs.writeFileSync(file, after);
  }
  await browser.close();
  fs.writeFileSync('/tmp/interviewvault-font-review.json', JSON.stringify({ migrated, retained, exceptions }, null, 2));
  console.log(`${migrated} labels migrated to measured Arial; ${retained} retained for geometric/emoji safety. Details: /tmp/interviewvault-font-review.json`);
}

if (process.argv.includes('--verify-baseline')) {
  const comparable = source => source.replace(/\b(fill|stroke|font-family)="[^"]*"/g, '$1="STYLE"').replace(/ (textLength|lengthAdjust)="[^"]*"/g, '');
  let checked = 0;
  for (const file of filesUnder('LLD').filter(file => /\/assets\/.*\.svg$/.test(file))) {
    const before = execFileSync('git', ['show', `HEAD:${file}`], {encoding:'utf8', maxBuffer: 32 * 1024 * 1024});
    const after = fs.readFileSync(file,'utf8');
    if (comparable(before) !== comparable(after)) throw new Error(`Non-style content changed: ${file}`);
    checked++;
  }
  console.log(`${checked} SVG sources preserve every byte except fill/stroke/font-family and added text constraints versus HEAD.`);
}
