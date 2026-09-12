import test from 'node:test';
import assert from 'node:assert/strict';
import { diagramHash, normalizeMermaid, MERMAID_CONFIG, PALETTE } from './diagram-theme.mjs';
import fs from 'node:fs';
import { renderFigure, sectionAt, extractSvgLabels } from './figure-markup.mjs';
import { normalizeSvg } from './normalize-svg.mjs';

test('render cache changes with the theme, without depending on object key order', () => {
  const source = 'graph LR\n A --> B';
  assert.notEqual(diagramHash(source, { fontSize: 16 }), diagramHash(source, { fontSize: 18 }));
  assert.equal(diagramHash(source, { a: 1, b: 2 }), diagramHash(source, { b: 2, a: 1 }));
  assert.notEqual(diagramHash(source), diagramHash(source + '\n B --> C'));
});

test('palette normalization preserves labels, semantics and arbitrary colour-like identifiers', () => {
  const source = 'graph LR\n A["Order #1234, colour #90EE90"] --> B["Failure"]\n style A fill:#90EE90\n style B fill:#FFB6C1';
  const normalized = normalizeMermaid(source);
  assert.ok(normalized.includes('Order #1234, colour #90EE90'));
  assert.ok(normalized.includes('style A fill:#DDF3EC'));
  assert.ok(normalized.includes('style B fill:#FCE5EA'));
  assert.equal(normalizeMermaid(normalized), normalized);
});

test('theme uses readable text and explicit colours for sequence diagrams', () => {
  assert.equal(MERMAID_CONFIG.themeVariables.primaryTextColor, '#0E1A2B');
  assert.equal(MERMAID_CONFIG.themeVariables.actorTextColor, '#0E1A2B');
  assert.equal(MERMAID_CONFIG.themeVariables.signalTextColor, '#0E1A2B');
});

test('source figures retain text and geometry while normalizing known presentation colours', () => {
  const svg = '<svg><!-- svg-source:excalidraw --><path d="M0 0 L20 10" stroke="#1971c2"/><text fill="#e03131">#1971c2 is an example</text></svg>';
  const result = normalizeSvg(svg);
  assert.ok(result.includes('d="M0 0 L20 10" stroke="#245B85"'));
  assert.ok(result.includes('fill="#A1273E">#1971c2 is an example'));
  assert.equal(normalizeSvg(result), result);
  const logo = '<svg><path fill="#1971c2" d="M0 0 L1 1"/></svg>';
  assert.equal(normalizeSvg(logo), logo);
});

test('figures provide full-size fallback, escaped captions and a static step transcript', () => {
  const markup = renderFigure({ id: 'test', title: 'Cache < hit', src: '/cache.svg',
    svg: '<svg viewBox="0 0 10 10" role="img" aria-labelledby="old"></svg>',
    walkthrough: { description: 'A & B', steps: [{ title: 'Read', description: '</script><img>', focus: ['a'] }] } });
  assert.ok(markup.includes('href="/cache.svg"'));
  assert.ok(markup.includes('Cache &lt; hit'));
  assert.ok(markup.includes('aria-labelledby="test-title test-caption"'));
  assert.ok(markup.includes('<summary>Read the 1-step explanation</summary>'));
  assert.equal((markup.match(/<\/script>/g) || []).length, 1);
  assert.ok(!markup.includes('aria-labelledby="old"'));
});

test('contextual titles use the nearest heading before a figure', () => {
  const md = '# Cache\n## 🧒 Read path\ntext\n```mermaid\nA-->B\n```\n## Write path';
  assert.equal(sectionAt(md, md.indexOf('```'), 'Fallback'), 'Read path');
  const code = '# Cache\n## Read path\n```python\n# Implementation detail\n```\n';
  assert.equal(sectionAt(code, code.length, 'Fallback'), 'Read path');
});

test('diagram label alternatives decode SVG text and HTML labels without exposing markup', () => {
  assert.deepEqual(extractSvgLabels('<svg><style>.fake{}</style><text>A &amp; B</text><text>A &amp; B</text><foreignObject><div>GET<br/>cache &#x31;</div></foreignObject></svg>'), ['A & B', 'GET · cache 1']);
});

test('walkthrough steps reference real source groups', () => {
  const walkthroughs = JSON.parse(fs.readFileSync(new URL('../content/visuals/walkthroughs.json', import.meta.url)));
  assert.equal(new Set(walkthroughs.map(item => item.id)).size, walkthroughs.length);
  for (const item of walkthroughs) {
    const svg = fs.readFileSync(new URL('../' + item.asset, import.meta.url), 'utf8');
    const keys = [...svg.matchAll(/data-step-key="([^"]+)"/g)].map(match => match[1]);
    // Several nodes can share one focus key, e.g. B and C in a BFS layer.
    assert.ok(keys.length > 0);
    assert.ok(fs.existsSync(new URL('../' + item.sourceDoc, import.meta.url)));
    for (const step of item.steps) {
      assert.ok(step.title && step.description && step.focus.length);
      for (const key of step.focus) assert.ok(keys.includes(key), `${item.id}: ${key}`);
    }
  }
});

test('shared ink and dimmed walkthrough text retain readable contrast on every pale fill', () => {
  const rgb = hex => hex.slice(1).match(/../g).map(channel => parseInt(channel, 16));
  const lum = channels => channels.map(channel => {
    const c = channel / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  for (const name of ['paper', 'blue', 'green', 'yellow', 'red', 'purple', 'active']) {
    assert.ok(contrast(rgb(PALETTE.ink), rgb(PALETTE[name])) >= 4.5, name);
    const blend = colour => rgb(colour).map(channel => channel * .72 + 255 * .28);
    assert.ok(contrast(blend(PALETTE.ink), blend(PALETTE[name])) >= 4.5, `Dimmed ${name}`);
  }
});
