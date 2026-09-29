// Run after build-site.mjs: node --test tools/theme.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../site');
let server, browser, origin;
before(async () => {
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

async function scenario(run) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  try { await run(page, context); } finally { await context.close(); }
}
const theme = page => page.evaluate(() => document.documentElement.dataset.theme);

test('system theme, keyboard toggle, and saved choice persist across every page type', async () => scenario(async page => {
  await page.goto(origin + '/');
  assert.equal(await theme(page), 'dark');
  await page.focus('#theme-toggle');
  await page.keyboard.press('Enter');
  assert.equal(await theme(page), 'light');
  assert.equal(await page.$eval('#theme-toggle', e => e.getAttribute('aria-label')), 'Switch to dark mode');
  for (const route of ['/vault/', '/answers/ad-click-aggregator/', '/progress/', '/']) {
    await page.goto(origin + route);
    assert.equal(await theme(page), 'light', route);
    assert.equal(await page.$$eval('#theme-toggle', nodes => nodes.length), 1, route);
  }
  await page.reload();
  assert.equal(await theme(page), 'light');
}));

test('system changes are followed until the visitor chooses a theme', async () => scenario(async page => {
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(origin + '/vault/');
  assert.equal(await theme(page), 'light');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.click('#theme-toggle');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  assert.equal(await theme(page), 'light');
}));

test('legacy portfolio preference migrates; invalid saved values fall back to the system', async () => scenario(async page => {
  await page.goto(origin + '/');
  await page.evaluate(() => localStorage.setItem('pf-theme', 'light'));
  await page.reload();
  assert.equal(await theme(page), 'light');
  assert.equal(await page.evaluate(() => localStorage.getItem('iv-theme')), 'light');
  await page.evaluate(() => localStorage.setItem('iv-theme', 'invalid'));
  await page.reload();
  assert.equal(await theme(page), 'dark');
}));

test('toggle works with storage disabled and at mobile widths', async () => scenario(async page => {
  await page.evaluateOnNewDocument(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } }));
  await page.setViewport({ width: 390, height: 844 });
  for (const route of ['/', '/vault/', '/answers/ad-click-aggregator/', '/progress/']) {
    await page.goto(origin + route);
    assert.equal(await theme(page), 'dark');
    await page.click('#theme-toggle');
    assert.equal(await theme(page), 'light');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `mobile overflow: ${route}`);
  }
}));

test('theme changes synchronize across tabs', async () => scenario(async (page, context) => {
  await page.goto(origin + '/vault/');
  const second = await context.newPage();
  await second.goto(origin + '/progress/');
  await page.bringToFront();
  await page.click('#theme-toggle');
  await second.bringToFront();
  await second.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await second.$eval('#theme-label', e => e.textContent), 'Dark mode');
}));

test('sticky library controls stay below wrapped headers at desktop widths', async () => scenario(async page => {
  for (const width of [1440, 1100, 1051]) {
    await page.setViewport({ width, height: 900 });
    await page.goto(origin + '/vault/');
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--header-height'));
    await page.evaluate(() => scrollTo(0, document.querySelector('.lib-bar').getBoundingClientRect().top + scrollY + 200));
    await page.waitForFunction(() => document.querySelector('.lib-bar').getBoundingClientRect().top >= document.querySelector('.hdr').getBoundingClientRect().bottom - 1);
  }
}));

test('dark article text and yellow active controls retain readable contrast', async () => scenario(async page => {
  await page.goto(origin + '/answers/ad-click-aggregator/');
  const contrasts = await page.evaluate(() => {
    function rgb(value) { return value.match(/[\d.]+/g).slice(0, 3).map(Number); }
    function lum(color) { return rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0); }
    return ['.prose p', '.prose pre', '.hdr-nav a[aria-current]', '.side a[aria-current]', '.figure-expand'].map(selector => {
      const element = document.querySelector(selector);
      let ancestor = element;
      while (getComputedStyle(ancestor).backgroundColor === 'rgba(0, 0, 0, 0)') ancestor = ancestor.parentElement;
      const a = lum(getComputedStyle(element).color), b = lum(getComputedStyle(ancestor).backgroundColor);
      return [selector, (Math.max(a, b) + .05) / (Math.min(a, b) + .05)];
    });
  });
  for (const [selector, ratio] of contrasts) assert.ok(ratio >= 4.5, `${selector}: ${ratio}`);
}));
