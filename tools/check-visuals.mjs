// Browser regression checks for the generated figure experience.
// Run after rendering and building. Screenshots stay outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const site = path.resolve(import.meta.dirname, '../site');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let file;
  try { file = path.resolve(site, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); }
  catch { res.writeHead(400).end(); return; }
  if (!file.startsWith(site + path.sep) && file !== site) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [], results = [];
const out = '/tmp/interviewvault-figure-checks';
fs.mkdirSync(out, { recursive: true });
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => req.url().startsWith(origin) || req.url().startsWith('data:') ? req.continue() : req.abort());
  page.on('pageerror', error => errors.push(error.message));
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  let libraryPages = 0, libraryFigures = 0;
  for (const file of walk(site).filter(file => file.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes('class="prose"')) continue;
    const validation = await page.evaluate(source => {
      const doc = new DOMParser().parseFromString(source, 'text/html');
      const figures = [...doc.querySelectorAll('.content-figure')];
      return {
        count: figures.length,
        missingTitle: figures.filter(figure => !doc.getElementById(figure.getAttribute('aria-labelledby'))).length,
        unframedImages: [...doc.querySelectorAll('.prose img')].filter(img => !img.closest('.content-figure')).length,
        nested: doc.querySelectorAll('.content-figure .content-figure, p > .content-figure').length,
      };
    }, html);
    assert.equal(validation.missingTitle + validation.unframedImages + validation.nested, 0, file);
    libraryPages++;
    libraryFigures += validation.count;
  }
  const routes = ['/concepts/sharding/', '/concepts/caching/', '/deep-dives/kafka/', '/dsa/bfs/', '/notes/networking/', '/answers/whatsapp/', '/answers/dropbox/', '/patterns/quick-reference/scaling-reads/'];
  for (const width of (process.env.VISUAL_CHECK_WIDTH ? [Number(process.env.VISUAL_CHECK_WIDTH)] : [1440, 700, 320])) {
    await page.setViewport({ width, height: 1000 });
    for (const route of (process.env.VISUAL_CHECK_ROUTE ? [process.env.VISUAL_CHECK_ROUTE] : routes)) {
      const response = await page.goto(origin + route, { waitUntil: 'load' });
      assert.equal(response.status(), 200, route);
      const state = await page.evaluate(async () => {
        const figures = [...document.querySelectorAll('.content-figure')];
        document.querySelectorAll('.content-figure img').forEach(img => img.loading = 'eager');
        await Promise.all([...document.querySelectorAll('.content-figure img')].map(img => img.decode().catch(() => {})));
        return {
          figures: figures.length, pageWidth: document.documentElement.scrollWidth,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          broken: [...document.querySelectorAll('.content-figure img')].filter(img => !img.naturalWidth).length,
          missingTitle: figures.filter(figure => !document.getElementById(figure.getAttribute('aria-labelledby'))).length,
          nested: document.querySelectorAll('.content-figure .content-figure, p > .content-figure').length,
        };
      });
      assert.ok(state.figures > 0, `No figures at ${route}`);
      if (state.overflow) {
        console.log(state, await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && !(() => { for(let p=el.parentElement;p && p!==document.body;p=p.parentElement) if(getComputedStyle(p).overflowX !== 'visible') return true; return false; })()).slice(0,30).map(el => ({tag:el.tagName, class:el.className, text:el.textContent.slice(0,80), width:el.getBoundingClientRect().width, right:el.getBoundingClientRect().right}))));
      }
      assert.equal(state.overflow, false, `Page overflow ${width} ${route}`);
      assert.equal(state.broken, 0, `Broken images ${route}`);
      assert.equal(state.missingTitle, 0);
      assert.equal(state.nested, 0);
      results.push({ width, route, ...state });
      const selector = await page.$('.has-walkthrough') ? '.has-walkthrough' : '.content-figure';
      const figure = await page.$(selector);
      await figure.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: `${out}/${route.replaceAll('/', '_')}-${width}.png` });
      await page.click(`${selector} .figure-expand`);
      assert.equal(await page.$eval('.figure-dialog', el => el.open), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('figure-viewport')), true);
      const sizeBefore = await page.$eval('.figure-dialog .figure-canvas', el => el.getBoundingClientRect().width);
      await page.click('[data-zoom="in"]');
      assert.ok(await page.$eval('.figure-dialog .figure-canvas', el => el.getBoundingClientRect().width) > sizeBefore);
      await page.click('[data-zoom="fit"]');
      assert.ok(await page.$eval('.figure-dialog .figure-canvas', el => el.getBoundingClientRect().width) <= width);
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('.figure-dialog', el => el.open), false);
      await page.waitForFunction(() => document.activeElement.classList.contains('figure-expand'));
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('figure-expand')), true);
      assert.equal(await page.$eval(`${selector} .figure-viewport`, el => el.hasAttribute('tabindex')), false);
    }
  }
  await page.setViewport({ width: 1200, height: 1000 });
  for (const route of routes.slice(0, 4)) {
    await page.goto(origin + route, { waitUntil: 'load' });
    await page.$eval('.has-walkthrough', el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const steps = await page.$eval('.figure-steps', el => JSON.parse(el.textContent).length);
    for (let i = 0; i < steps; i++) {
      await page.click('.has-walkthrough [data-action="next"]');
      assert.match(await page.$eval('.figure-step-count', el => el.textContent), new RegExp(`Step ${i + 1} of ${steps}`));
      assert.ok(await page.$$eval('.has-walkthrough .is-current', els => els.length) > 0);
    }
    assert.ok(await page.$eval('[data-action="next"]', el => el.disabled));
    await page.click('[data-action="reset"]');
    assert.equal(await page.$$eval('.is-stepping', els => els.length), 0);
    await page.click('[data-action="play"]');
    assert.equal(await page.$eval('[data-action="play"]', el => el.textContent), 'Pause');
    await page.waitForFunction(() => document.querySelector('.figure-step-count').textContent.startsWith('Step 2'), { timeout: 15000 });
    await page.click('[data-action="play"]');
    const paused = await page.$eval('.figure-step-count', el => el.textContent);
    // Wait past the current interval: a stale timeout must not advance.
    await new Promise(resolve => setTimeout(resolve, 10000));
    assert.equal(await page.$eval('.figure-step-count', el => el.textContent), paused);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.waitForFunction(() => document.querySelector('[data-action="play"]').hidden);
    assert.equal(await page.$eval('[data-action="play"]', el => el.hidden), true);
    await page.click('[data-action="next"]');
    assert.match(await page.$eval('.figure-step-count', el => el.textContent), /Step 3/);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  }
  await page.setJavaScriptEnabled(false);
  await page.goto(origin + '/concepts/sharding/', { waitUntil: 'load' });
  assert.equal(await page.$eval('.has-walkthrough svg', el => el.getBoundingClientRect().width > 0), true);
  assert.equal(await page.$eval('.has-walkthrough .figure-transcript', el => el.textContent.includes('Route one key')), true);
  assert.equal(await page.$$eval('.figure-player', els => els.length), 0);
  const fallback = await page.$eval('.has-walkthrough .figure-expand', el => el.href);
  assert.equal((await page.goto(fallback)).status(), 200);
  assert.deepEqual(errors, []);
  fs.writeFileSync(`${out}/results.json`, JSON.stringify({ libraryPages, libraryFigures, results, errors, walkthroughs: 4, noJavaScript: 'passed' }, null, 2));
  console.log(`Visual UX OK: ${libraryPages} content pages / ${libraryFigures} framed figures, ${results.length} responsive page checks, four walkthroughs, enlargement/zoom/focus, reduced motion, no-JavaScript fallback. Screenshots: ${out}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  server.close();
}
