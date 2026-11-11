/**
 * Scan built-in and user prompt directories for overrides API.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { parsePromptMarkdown } from './parse.js';

function shouldSkip(relativePath) {
  const norm = relativePath.replace(/\\/g, '/');
  return norm.split('/').some(segment => segment === '_example' || segment === '_template') || /(?:^|[./])lite\.md$/i.test(norm);
}

/**
 * Recursively collect .md files under dir.
 * @param {string} root
 * @param {string} prefix
 */
async function collectMarkdownFiles(root, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdownFiles(full, rel)));
    } else if (entry.name.endsWith('.md')) {
      out.push({ full, relative: rel });
    }
  }
  return out;
}

/**
 * @param {string} projectRoot
 * @returns {Promise<Array<object>>}
 */
export async function buildPromptRegistry(projectRoot) {
  const builtinRoot = path.join(projectRoot, 'src', 'chat', 'prompts');
  const userRoot = path.join(getMinnowHome(), 'prompts');

  const byKey = new Map();

  async function ingest(root, source) {
    const files = await collectMarkdownFiles(root);
    for (const { full, relative } of files) {
      if (shouldSkip(relative)) continue;
      try {
        const raw = await fs.readFile(full, 'utf8');
        const parsed = parsePromptMarkdown(raw, relative);
        const key = `${parsed.kind}:${parsed.id}`;
        const existing = byKey.get(key);
        const entry = { ...parsed, source };
        if (!existing || (source === 'user' && existing.source === 'builtin') ||
            (source === existing.source && relative.endsWith('.full.md'))) {
          byKey.set(key, entry);
        }
      } catch {
        /* skip invalid */
      }
    }
  }

  await ingest(builtinRoot, 'builtin');
  await ingest(userRoot, 'user');

  return [...byKey.values()];
}
