#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiconsRoot = join(root, 'src/styles/vendor/uicons');

function loadUiconClasses(relativePath) {
  const css = readFileSync(join(uiconsRoot, relativePath), 'utf8');
  const classes = new Set();
  for (const m of css.matchAll(/\.(fi-(?:rr|sr)-[a-z0-9-]+)/g)) {
    classes.add(m[1]);
  }
  return classes;
}

const catalog = new Set([
  ...loadUiconClasses('regular-rounded.css'),
  ...loadUiconClasses('solid-rounded.css'),
]);

const iconTs = readFileSync(join(root, 'src/ui/icon.ts'), 'utf8');
const entries = [...iconTs.matchAll(/^\s+(\w+):\s+'(fi-(?:rr|sr)-[^']+)'/gm)];

const missing = [];
for (const [, name, cls] of entries) {
  if (!catalog.has(cls)) missing.push({ name, cls });
}

if (missing.length) {
  console.error('check-icons: missing Uicons classes:\n');
  for (const { name, cls } of missing) {
    console.error(`  ${name} -> ${cls}`);
  }
  process.exit(1);
}

console.log(`check-icons: ok total=${entries.length} missing=0`);
