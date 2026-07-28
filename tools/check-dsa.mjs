import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DSA_TOPICS, REQUIRED_DSA_SECTIONS } from './dsa-config.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS, '..');
const DSA = path.join(REPO, 'DSA');

function slugOf(rel) {
  return path.basename(rel, '.md')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function compileBlocks(rel, source) {
  const issues = [];
  const blocks = [...source.matchAll(/```cpp\n([\s\S]*?)```/g)];
  const dir = mkdtempSync(path.join(tmpdir(), 'interview-vault-dsa-'));

  try {
    blocks.forEach((match, index) => {
      const file = path.join(dir, `block-${index + 1}.cpp`);
      writeFileSync(file, match[1]);
      const result = spawnSync(process.env.CXX || 'c++', [
        '-std=c++17',
        '-Wall',
        '-Wextra',
        '-pedantic',
        '-fsyntax-only',
        file,
      ], { encoding: 'utf8' });

      if (result.status !== 0) {
        const output = result.stderr || result.stdout || 'compiler did not start';
        const detail = output.trim().split('\n').slice(0, 3).join(' | ');
        issues.push(`${rel}: C++ block ${index + 1} does not compile: ${detail}`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return issues;
}

function linkIssues(rel, source) {
  const issues = [];
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
    const target = path.resolve(REPO, path.dirname(rel), decodeURIComponent(match[1]));
    if (!existsSync(target)) issues.push(`${rel}: broken Markdown link ${match[1]}`);
  }
  return issues;
}

function hasUntaggedFence(source) {
  let insideFence = false;
  for (const line of source.split('\n')) {
    if (!line.startsWith('```')) continue;
    if (!insideFence && line.trim() === '```') return true;
    insideFence = !insideFence;
  }
  return false;
}

export function validateDocument(rel, source, options = {}) {
  const issues = [];
  const h1s = [...source.matchAll(/^#\s+.+$/gm)];
  if (h1s.length !== 1) {
    issues.push(`${rel}: expected exactly one H1, found ${h1s.length}`);
  }

  const h2s = [...source.matchAll(/^##\s+([^\n]+?)\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(h2s) !== JSON.stringify(REQUIRED_DSA_SECTIONS)) {
    issues.push(`${rel}: required H2 sections must be ${REQUIRED_DSA_SECTIONS.join(' -> ')}`);
  }

  if (hasUntaggedFence(source)) issues.push(`${rel}: untagged code fence`);

  if (!/```cpp(?: legacy)?\n/.test(source)) {
    issues.push(`${rel}: expected at least one cpp block`);
  }

  if (options.checkLinks !== false) issues.push(...linkIssues(rel, source));
  if (options.compile !== false) issues.push(...compileBlocks(rel, source));
  return issues;
}

function selectedFiles(args) {
  if (args.length) {
    return args.map((arg) => path.relative(REPO, path.resolve(REPO, arg)));
  }
  return readdirSync(DSA)
    .filter((name) => name.endsWith('.md'))
    .map((name) => `DSA/${name}`);
}

export function run(args = process.argv.slice(2)) {
  const files = selectedFiles(args);
  const issues = [];
  const positions = new Map();

  for (const rel of files) {
    const slug = slugOf(rel);
    const topic = DSA_TOPICS[slug];
    if (!topic) {
      issues.push(`${rel}: missing DSA metadata for slug ${slug}`);
    } else if (positions.has(topic.order)) {
      issues.push(`${rel}: duplicate study position ${topic.order}`);
    } else {
      positions.set(topic.order, rel);
    }
    issues.push(...validateDocument(rel, readFileSync(path.join(REPO, rel), 'utf8')));
  }

  if (!args.length) {
    for (const slug of Object.keys(DSA_TOPICS)) {
      const found = files.some((rel) => slugOf(rel) === slug);
      if (!found) issues.push(`DSA metadata ${slug}: no matching Markdown file`);
    }
  }

  if (issues.length) {
    console.error(`${issues.length} DSA problem(s):\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    return 1;
  }

  console.log(`DSA OK - ${files.length} document(s), C++17 syntax checked`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
