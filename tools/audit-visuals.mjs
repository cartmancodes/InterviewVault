/** Reproducible source inventory. Run from repository root; --contact-sheets adds browser validation/review sheets. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { marked } from 'marked';
import { hashOf } from './render-diagrams.mjs';
import { filesUnder } from './normalize-svg.mjs';
const roots = ['LLD', 'DSA', 'content'];
const files = roots.flatMap(filesUnder);
const docs = files.filter(file => /\.md$/i.test(file));
const assetFiles = files.filter(file => /\.(svg|png|jpe?g|gif|webp|avif)$/i.test(file));
const visuals = [];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
for (const doc of docs) {
  let section = '', index = 0;
  const tokens = marked.lexer(fs.readFileSync(doc, 'utf8'));
  const add = (href, caption, format) => {
    const external = /^(https?:)?\/\//i.test(href);
    const asset = external || /^data:/i.test(href) ? href : path.normalize(path.join(path.dirname(doc), decodeURIComponent(href.split(/[?#]/)[0])));
    visuals.push({ document: doc, section, index: ++index, asset, format: format || path.extname(asset).slice(1).toLowerCase(), caption: caption || '', external, missing: !external && !/^data:/i.test(asset) && !fs.existsSync(asset) });
  };
  for (const block of tokens) {
    if (block.type === 'heading') section = block.text;
    marked.walkTokens([block], token => {
      if (token.type === 'image') add(token.href, token.text);
      if (token.type === 'code' && token.lang?.trim() === 'mermaid') {
        const source = token.raw.match(/^```mermaid\n([\s\S]*?)```/)?.[1] ?? token.text + '\n';
        const asset = `site/assets/diagrams/${hashOf(source)}.svg`;
        visuals.push({ document: doc, section, index: ++index, asset, format: 'mermaid', caption: section, external: false, missing: !fs.existsSync(asset), sourceHash: hash(source), source });
      }
      if (token.type === 'html') for (const match of token.text.matchAll(/<img\b[^>]*>/gi)) {
        const attrs = Object.fromEntries([...match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(a => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4]]));
        if (attrs.src) add(attrs.src, attrs.alt || attrs.title || '');
      }
    });
  }
}
const referenced = new Set(visuals.filter(v => v.format !== 'mermaid').map(v => v.asset));
const assets = assetFiles.map(file => {
  const bytes = fs.readFileSync(file), source = /\.svg$/.test(file) ? bytes.toString() : '';
  return { file, format: path.extname(file).slice(1), sha256: hash(bytes), referenced: referenced.has(file), review: /LLD\/SystemDesign\/.*\/assets\/.*\.svg$/.test(file) ? 'contact-sheet-triage-2026-09-12; detailed-reading-not-complete' : 'see-visual-audit-report', disposition: source.includes('svg-source:excalidraw') ? 'normalized-palette; measured-arial-where-safe; preserved-geometry' : 'retained-original',
    ...(source ? { viewBox: source.match(/viewBox="([^"]*)"/)?.[1] || null, labels: [...source.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map(m => m[1].replace(/<[^>]*>/g, '')), colors: [...new Set(source.match(/#[\da-f]{3,8}\b/gi) || [])].sort(), fonts: [...new Set([...source.matchAll(/font-family="([^"]*)"/g)].map(m => m[1]))], externalResources: [...new Set([...source.matchAll(/(?:href=["']|url\(["']?)(https?:[^"')\s]+)/g)].map(m => m[1]))] } : {}) };
});
const groups = new Map();
for (const asset of assets) groups.set(asset.sha256, [...(groups.get(asset.sha256) || []), asset.file]);
const duplicateGroups = [...groups.values()].filter(group => group.length > 1);
const summary = { documents: docs.length, visuals: visuals.length, mermaid: visuals.filter(v => v.format === 'mermaid').length, images: visuals.filter(v => v.format !== 'mermaid').length, assets: assets.length, svg: assets.filter(a => a.format === 'svg').length, missing: visuals.filter(v => v.missing).length, externalImages: visuals.filter(v => v.external).length, orphanAssets: assets.filter(a => !a.referenced).length, duplicateGroups: duplicateGroups.length };
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/visual-inventory.json', JSON.stringify({ summary, visuals, assets, duplicateGroups }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes('--contact-sheets')) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => /^https?:/.test(req.url()) ? req.abort() : req.continue());
  await page.setViewport({ width: 1800, height: 1800, deviceScaleFactor: 1 });
  const svgAssets = assets.filter(a => a.format === 'svg');
  const errors = [];
  for (const asset of svgAssets) {
    const error = await page.evaluate(source => {
      const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
      return xml.querySelector('parsererror')?.textContent || null;
    }, fs.readFileSync(asset.file, 'utf8'));
    if (error) errors.push({ file: asset.file, error });
  }
  fs.mkdirSync('/tmp/interviewvault-visual-review', { recursive: true });
  for (let start = 0; start < svgAssets.length; start += 36) {
    const batch = svgAssets.slice(start, start + 36);
    await page.setContent(`<style>body{margin:0;font:11px Arial;background:#e5e7eb;display:grid;grid-template-columns:repeat(6,300px)}figure{margin:3px;background:white;height:290px;padding:2px}img{width:288px;height:255px;object-fit:contain}figcaption{overflow-wrap:anywhere}</style>` + batch.map((a, i) => `<figure><img src="data:image/svg+xml;base64,${fs.readFileSync(a.file).toString('base64')}"><figcaption>${start + i}: ${a.file.split('/').slice(-2).join('/')}</figcaption></figure>`).join(''));
    await page.evaluate(async () => Promise.all([...document.images].map(img => img.decode().catch(() => {}))));
    await page.screenshot({ path: `/tmp/interviewvault-visual-review/sheet-${String(start / 36).padStart(2, '0')}.png`, fullPage: true });
  }
  fs.writeFileSync('/tmp/interviewvault-visual-review/svg-validation.json', JSON.stringify({ checked: svgAssets.length, errors }, null, 2));
  const rasters = assets.filter(a => a.format !== 'svg');
  for (let start = 0; start < rasters.length; start += 36) {
    await page.setContent(`<style>body{margin:0;font:11px Arial;background:#e5e7eb;display:grid;grid-template-columns:repeat(6,300px)}figure{margin:3px;background:white;height:290px;padding:2px}img{width:288px;height:255px;object-fit:contain}figcaption{overflow-wrap:anywhere}</style>` + rasters.slice(start,start+36).map((a,i) => `<figure><img src="data:image/${a.format};base64,${fs.readFileSync(a.file).toString('base64')}"><figcaption>${start+i}: ${a.file}</figcaption></figure>`).join(''));
    await page.evaluate(async () => Promise.all([...document.images].map(img => img.decode().catch(() => {}))));
    await page.screenshot({path: `/tmp/interviewvault-visual-review/raster-${start/36}.png`, fullPage:true});
  }
  for (const index of [1,59,157,193,229,484]) {
    const asset = svgAssets[index];
    await page.setViewport({width:1440,height:1000,deviceScaleFactor:1});
    await page.setContent(`<style>body{margin:20px}img{width:1400px;max-height:950px;object-fit:contain}</style><img src="data:image/svg+xml;base64,${fs.readFileSync(asset.file).toString('base64')}">`);
    await page.evaluate(async () => document.images[0].decode());
    await page.screenshot({path:`/tmp/interviewvault-visual-review/detail-${index}.png`,fullPage:true});
  }
  await browser.close();
  console.log(`Validated ${svgAssets.length} SVG XML documents; ${errors.length} errors. Sheets: /tmp/interviewvault-visual-review/`);
  if (errors.length) process.exitCode = 1;
}
if (summary.missing) process.exitCode = 1;
