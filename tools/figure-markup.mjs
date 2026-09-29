export const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function extractSvgLabels(svg) {
  const text = [...svg.matchAll(/<(text|foreignObject)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(match =>
    match[2].replace(/<br\s*\/?\s*>/gi, ' · ').replace(/<[^>]*>/g, ' ')
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(text)];
}

export function sectionAt(markdown, offset, fallback) {
  let heading = fallback, fence = null;
  for (const line of markdown.slice(0, offset).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence) heading = line.match(/^#{1,6}\s+(.+)$/)?.[1] || heading;
  }
  return heading.replace(/[*_`]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
}

export function renderFigure({ id, title, src, svg, alt, kind = 'Diagram', walkthrough, labels = [] }) {
  const captionId = `${id}-caption`;
  const titleId = `${id}-title`;
  const safe = escapeHtml;
  const description = walkthrough?.description || alt || title;
  const content = svg
    ? svg.replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(?:role|aria-label|aria-labelledby|aria-describedby|tabindex)="[^"]*"/g, '')} role="img" aria-labelledby="${titleId} ${captionId}">`)
    : `<img src="${safe(src)}" alt="${safe(alt || title)}" loading="lazy" decoding="async">`;
  const steps = walkthrough ? `<details class="figure-transcript"><summary>Read the ${walkthrough.steps.length}-step explanation</summary><ol>${walkthrough.steps.map(step => `<li><strong>${safe(step.title)}.</strong> ${safe(step.description)}</li>`).join('')}</ol></details>
  <script type="application/json" class="figure-steps">${JSON.stringify(walkthrough.steps).replace(/</g, '\\u003c')}</script>`
    : labels.length ? `<details class="figure-transcript"><summary>Read diagram labels</summary><ul>${labels.map(label => `<li>${safe(label)}</li>`).join('')}</ul></details>` : '';
  return `<figure class="content-figure${walkthrough ? ' has-walkthrough' : ''}" id="${id}" aria-labelledby="${titleId}">
    <div class="figure-heading"><div><span class="figure-kind">${safe(kind)}</span><strong id="${titleId}">${safe(title)}</strong></div>
    <a class="figure-expand" href="${safe(src)}" aria-label="Open full-size figure: ${safe(title)}">Open full size <span aria-hidden="true">↗</span></a></div>
    <div class="figure-viewport"><div class="figure-canvas">${content}</div></div>
    <figcaption id="${captionId}">${safe(description)}</figcaption>${steps}
  </figure>`;
}
