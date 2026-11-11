/** Load Builder, Tester, and Final Tester system prompts. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

/**
 * Drop YAML frontmatter so the model sees instructions, not the authoring header.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripPromptFrontmatter(raw) {
  const text = String(raw ?? '');
  if (!text.startsWith('---')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text.trim();
  return text.slice(end + 4).replace(/^\s*\r?\n/, '').trim();
}

/**
 * @param {'builder' | 'tester' | 'final'} role
 * @returns {Promise<string>}
 */
export async function loadRolePrompt(role) {
  if (role !== 'builder' && role !== 'tester' && role !== 'final') {
    throw new Error(`loadRolePrompt: ${String(role)} is not an agent role`);
  }
  const raw = await fs.readFile(path.join(PROMPTS_DIR, role, 'agent.full.md'), 'utf8');
  return stripPromptFrontmatter(raw);
}

/**
 * Substitute `{{cwd}}` (and any other `{{name}}`) in a loaded prompt.
 *
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
export function interpolatePrompt(template, vars) {
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : '',
  );
}
