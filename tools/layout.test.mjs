// Run after build-site.mjs: node --test tools/layout.test.mjs
//
// The landing page is a single-screen composition, so it has to hold together
// across screen shapes, not just at the width it was drawn for. These tests pin
// that down: the two-column layout fits the window it is given, the shell
// reaches the bottom of tall windows, and nothing with an intrinsic ratio (the
// Cartman sprite, the snake board, the vault's icons) is ever squeezed.
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
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

async function at(route, { width, height, theme = 'dark', touch = false }, run) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  await page.setViewport({ width, height, hasTouch: touch, isMobile: touch });
  try {
    await page.goto(origin + route, { waitUntil: 'load' });
    return await run(page);
  } finally { await context.close(); }
}

const measure = page => page.evaluate(() => {
  const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const de = document.documentElement;
  const shellEl = document.querySelector('.site-shell');
  return {
    // how much larger than drawn the page is shown: 1 up to a 1440px window, more beyond
    scale: shellEl.getBoundingClientRect().width / shellEl.offsetWidth,
    viewport: { width: de.clientWidth, height: de.clientHeight },
    page: { width: de.scrollWidth, height: de.scrollHeight },
    body: box('body'), shell: box('.site-shell'), footer: box('.site-shell > footer'),
    terminal: box('#terminal'), input: box('#command-form'), cartman: box('#cartman'),
    stage: box('.character-stage'), speech: box('.speech'), caption: box('.scene-caption'),
    copy: box('.intro-copy'), social: box('.social-links'),
  };
});

// Window sizes a visitor on a laptop or monitor actually gets, browser chrome
// included, from a 1366x768 laptop up to a 4K-class display.
const DESKTOP = [
  [1280, 720], [1366, 768], [1440, 900], [1440, 790], [1536, 864],
  [1536, 740], [1920, 1080], [1920, 950], [1024, 768], [2560, 1440], [3440, 1440],
];

test('the desktop landing page fits the window: no page scroll, command input in view', async () => {
  for (const [width, height] of DESKTOP) {
    const m = await at('/', { width, height }, measure);
    const label = `${width}x${height}`;
    assert.equal(m.page.height, m.viewport.height, `${label}: page is ${m.page.height}px tall in a ${m.viewport.height}px window`);
    assert.equal(m.page.width, m.viewport.width, `${label}: page scrolls sideways`);
    assert.ok(m.input.bottom <= m.viewport.height, `${label}: command input ends at ${Math.round(m.input.bottom)}px, below the fold`);
    assert.ok(m.terminal.bottom <= m.footer.top, `${label}: terminal overlaps the footer`);
  }
});

test('the shell and its grid backdrop reach the bottom of the window in both themes', async () => {
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1920, 1080], [2560, 1440], [3440, 1440], [1024, 1366]]) {
      const m = await at('/', { width, height, theme }, measure);
      const label = `${width}x${height} ${theme}`;
      assert.ok(m.body.bottom >= m.viewport.height - 0.5, `${label}: body (grid backdrop) stops at ${Math.round(m.body.bottom)}px`);
      assert.ok(m.shell.bottom >= m.viewport.height - 0.5, `${label}: shell stops at ${Math.round(m.shell.bottom)}px`);
      assert.ok(Math.abs(m.footer.bottom - m.viewport.height) <= 1, `${label}: footer ends at ${Math.round(m.footer.bottom)}px, not the window bottom`);
    }
  }
});

test('the Cartman frame stays 3:2, stays legible, and stays inside its column', async () => {
  const shapes = [...DESKTOP.map(([width, height]) => ({ width, height })),
    { width: 1180, height: 820, touch: true }, { width: 820, height: 1180, touch: true },
    { width: 844, height: 390, touch: true }, { width: 390, height: 844, touch: true }, { width: 360, height: 640, touch: true }];
  for (const shape of shapes) {
    const m = await at('/', shape, measure);
    const label = `${shape.width}x${shape.height}`;
    const ratio = m.cartman.width / m.cartman.height;
    assert.ok(Math.abs(ratio - 1.5) < 0.015, `${label}: sprite frame is ${Math.round(m.cartman.width)}x${Math.round(m.cartman.height)} (${ratio.toFixed(3)}), not 3:2`);
    assert.ok(m.cartman.width >= 180, `${label}: sprite shrank to ${Math.round(m.cartman.width)}px wide`);
    assert.ok(m.cartman.left >= m.stage.left - 1 && m.cartman.right <= m.stage.right + 1, `${label}: sprite spills out of its column`);
    assert.ok(m.speech.left >= m.stage.left - 1 && m.speech.right <= m.stage.right + 1, `${label}: speech bubble leaves its column`);
    // one line is 40px, or 50px once the bubble's 2deg tilt is in the bounding box
    assert.ok(m.speech.height <= 56 * m.scale, `${label}: speech bubble wrapped to ${Math.round(m.speech.height)}px tall`);
    if (!shape.touch) assert.ok(m.speech.top >= m.copy.bottom, `${label}: speech bubble overlaps the intro copy`);
    assert.ok(m.caption.bottom <= m.social.top, `${label}: caption overlaps the social links`);
    assert.equal(m.page.width, m.viewport.width, `${label}: page scrolls sideways`);
  }
});

// Windows wider than the 1440px the page was drawn at. The page used to stop
// growing there and sit as a narrow column between two empty bands (a 1920px
// window lost a quarter of its width, a 2560px one almost half). It is now
// magnified as one piece until the window's width or height is used up.
const WIDE = [[1920, 950], [1920, 1080], [2560, 1300], [2837, 1406], [3440, 1340], [3840, 2000]];

test('wide windows are filled edge to edge, by magnifying the page as one piece', async () => {
  for (const [width, height] of WIDE) {
    for (const theme of ['light', 'dark']) {
      const m = await at('/', { width, height, theme }, measure);
      const label = `${width}x${height} ${theme}`;
      assert.ok(m.shell.left <= 0.5 && m.shell.right >= m.viewport.width - 0.5, `${label}: page spans ${Math.round(m.shell.left)}..${Math.round(m.shell.right)}px of a ${m.viewport.width}px window`);
      assert.ok(Math.abs(m.scale - Math.min(width / 1440, height / 880)) < 0.01, `${label}: magnified ${m.scale.toFixed(3)}x`);
      assert.ok(m.terminal.height >= 0.6 * m.viewport.height, `${label}: terminal uses only ${Math.round(m.terminal.height)}px of the window's height`);
      assert.equal(m.page.height, m.viewport.height, `${label}: page is ${m.page.height}px tall in a ${m.viewport.height}px window`);
      assert.equal(m.page.width, m.viewport.width, `${label}: page scrolls sideways`);
      assert.ok(m.input.bottom <= m.viewport.height, `${label}: command input is below the fold`);
      assert.ok(Math.abs(m.footer.bottom - m.viewport.height) <= 1, `${label}: footer ends at ${Math.round(m.footer.bottom)}px`);
      assert.ok(Math.abs(m.cartman.width / m.cartman.height - 1.5) < 0.015, `${label}: sprite frame is off 3:2`);
      assert.ok(m.speech.height <= 56 * m.scale && m.speech.top >= m.copy.bottom, `${label}: speech bubble wraps or overlaps the intro copy`);
    }
  }
});

test('a window no wider than 1440px is shown at its drawn size', async () => {
  for (const [width, height] of [[1440, 900], [1366, 768], [1024, 768], [390, 844]]) {
    const m = await at('/', { width, height }, measure);
    assert.ok(Math.abs(m.scale - 1) < 0.001, `${width}x${height}: magnified ${m.scale.toFixed(3)}x`);
  }
});

test('short windows degrade to a scroll, never to a terminal taller than the window', async () => {
  for (const [width, height] of [[1366, 650], [1280, 600], [1024, 560]]) {
    const m = await at('/', { width, height }, measure);
    assert.ok(m.terminal.height <= height, `${width}x${height}: terminal is ${Math.round(m.terminal.height)}px tall`);
    assert.ok(m.page.height - height <= 160, `${width}x${height}: page overflows by ${m.page.height - height}px`);
    assert.ok(Math.abs(m.cartman.width / m.cartman.height - 1.5) < 0.015, `${width}x${height}: sprite frame is off 3:2`);
    assert.ok(m.terminal.height >= 420, `${width}x${height}: terminal collapsed to ${Math.round(m.terminal.height)}px`);
  }
});

test('vault media keeps its intrinsic ratio at every width', async () => {
  for (const [width, height] of [[1920, 1080], [1024, 768], [390, 844]]) {
    const m = await at('/vault/', { width, height }, page => page.evaluate(() => {
      const size = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { width: r.width, height: r.height }; };
      return { icon: size('.search svg'), board: size('#pr-board'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    }));
    const label = `${width}x${height}`;
    assert.ok(Math.abs(m.icon.width - m.icon.height) < 0.5, `${label}: search icon is ${m.icon.width.toFixed(1)}x${m.icon.height.toFixed(1)}, not square`);
    assert.ok(Math.abs(m.board.width / m.board.height - 5 / 3) < 0.015, `${label}: snake board is ${Math.round(m.board.width)}x${Math.round(m.board.height)}, not 5:3`);
    assert.equal(m.overflow, 0, `${label}: vault scrolls sideways`);
  }
});
