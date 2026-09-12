import { createHash } from 'node:crypto';

// One quiet palette for instructional figures. Preserve existing colour families:
// a green chosen path must never become indistinguishable from a red failure.
export const PALETTE = Object.freeze({
  ink: '#0E1A2B', muted: '#4F5F79', paper: '#FFFFFF',
  blue: '#EAF5FD', green: '#DDF3EC', yellow: '#FFF6C9',
  red: '#FCE5EA', purple: '#EDE8FA', active: '#FFD808',
});

const LEGACY = {
  '#90ee90': PALETTE.green, '#e8f5e9': PALETTE.green, '#e7f8f1': PALETTE.green,
  '#ffb6c1': PALETTE.red, '#ffe1e1': PALETTE.red,
  '#ffe4b5': PALETTE.yellow, '#fff4e1': PALETTE.yellow,
  '#fef3c7': PALETTE.yellow, '#fde9c8': PALETTE.yellow,
  '#e1f5ff': PALETTE.blue, '#f3e5f5': PALETTE.purple,
  '#6b7c96': PALETTE.muted, '#10b981': '#176349',
  '#f59e0b': '#85520B', '#d97706': '#85520B',
};

export function normalizeMermaid(source) {
  // Only CSS property values in style directives. Labels and identifiers can
  // legitimately contain hex strings; never rewrite arbitrary source text.
  return source.replace(/^(\s*(?:style|classDef|linkStyle)\s+.*)$/gm, line =>
    line.replace(/((?:fill|stroke|color)\s*:\s*)(#[\da-f]{3,8})\b/gi,
      (_, property, colour) => property + (LEGACY[colour.toLowerCase()] || colour)));
}

export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'base',
  fontFamily: 'Arial, Helvetica, sans-serif',
  flowchart: { htmlLabels: true, curve: 'linear', nodeSpacing: 32, rankSpacing: 48, padding: 16 },
  sequence: { useMaxWidth: true, wrap: true, width: 170, diagramMarginX: 24, diagramMarginY: 24, actorMargin: 48, messageMargin: 40, mirrorActors: false },
  themeVariables: {
    background: PALETTE.paper, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '16px',
    primaryColor: PALETTE.yellow, primaryTextColor: PALETTE.ink, primaryBorderColor: PALETTE.ink,
    secondaryColor: PALETTE.green, secondaryTextColor: PALETTE.ink, secondaryBorderColor: PALETTE.ink,
    tertiaryColor: PALETTE.blue, tertiaryTextColor: PALETTE.ink, tertiaryBorderColor: PALETTE.ink,
    lineColor: PALETTE.ink, textColor: PALETTE.ink,
    clusterBkg: PALETTE.blue, clusterBorder: PALETTE.muted,
    edgeLabelBackground: PALETTE.paper,
    actorBkg: PALETTE.blue, actorBorder: PALETTE.ink, actorTextColor: PALETTE.ink,
    actorLineColor: PALETTE.muted, signalColor: PALETTE.ink, signalTextColor: PALETTE.ink,
    labelBoxBkgColor: PALETTE.yellow, labelBoxBorderColor: PALETTE.ink,
    labelTextColor: PALETTE.ink, loopTextColor: PALETTE.ink,
    activationBkgColor: PALETTE.green, activationBorderColor: PALETTE.ink,
    noteBkgColor: PALETTE.yellow, noteBorderColor: PALETTE.muted, noteTextColor: PALETTE.ink,
    attributeBackgroundColorOdd: PALETTE.paper, attributeBackgroundColorEven: PALETTE.blue,
    cScale0: PALETTE.blue, cScale1: PALETTE.green, cScale2: PALETTE.yellow,
    cScale3: PALETTE.purple, cScale4: PALETTE.red, cScale5: PALETTE.blue,
    cScale6: PALETTE.green, cScale7: PALETTE.yellow, cScale8: PALETTE.purple,
    cScale9: PALETTE.red, cScale10: PALETTE.blue, cScale11: PALETTE.green,
    cScaleLabel0: PALETTE.ink, cScaleLabel1: PALETTE.ink, cScaleLabel2: PALETTE.ink,
    cScaleLabel3: PALETTE.ink, cScaleLabel4: PALETTE.ink, cScaleLabel5: PALETTE.ink,
    cScaleLabel6: PALETTE.ink, cScaleLabel7: PALETTE.ink, cScaleLabel8: PALETTE.ink,
    cScaleLabel9: PALETTE.ink, cScaleLabel10: PALETTE.ink, cScaleLabel11: PALETTE.ink,
  },
  themeCSS: `
    .node rect, .node circle, .node ellipse, .node polygon, .node path,
    .cluster rect, .actor, .labelBox, .er.entityBox, .note { stroke-width: 1.5px; }
    .edgePath .path, .flowchart-link, .messageLine0, .messageLine1,
    .transition, .relationshipLine, .er.relationshipLine { stroke-width: 1.5px; }
    .nodeLabel, .edgeLabel { line-height: 1.5; }
    path[class*="section-edge-"] { stroke: #4F5F79 !important; stroke-width: 1.5px !important; }
  `,
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function diagramHash(source, config = MERMAID_CONFIG) {
  return createHash('sha1').update(JSON.stringify(stable(config)))
    .update('\nvisuals-v1\n').update(normalizeMermaid(source)).digest('hex').slice(0, 16);
}
