/**
 * GET /api/skills/impeccable/upstream — patched SKILL.upstream.md body (no frontmatter).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureImpeccableSkillInstalled } from './skill-install.js';

const MAX_UPSTREAM_CHARS = 128_000;
const TRUNCATION_MARKER = '\n\n…[upstream body truncated at 128k]';

/**
 * Strip optional HTML comment + YAML frontmatter from a skill markdown file.
 * @param {string} raw
 * @returns {string}
 */
export function stripSkillMarkdownEnvelope(raw) {
  let text = typeof raw === 'string' ? raw : '';
  text = text.replace(/^<!--[\s\S]*?-->\s*/u, '');
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/u);
  return match ? match[1].trim() : text.trim();
}

/**
 * One-line preamble so relative `reference/…` / `scripts/…` mentions resolve.
 * @param {string} skillDir
 * @returns {string}
 */
export function formatSkillDirPreamble(skillDir) {
  const dir = skillDir.replace(/\\/g, '/');
  return `Impeccable skill files are installed at \`${dir}\`. Every \`reference/…\` and \`scripts/…\` path below is relative to that directory (read or run it there, not in the workspace or the Minnow app bundle).`;
}

/**
 * Read upstream Impeccable SKILL body from the installed skill.
 * @param {string} skillDir Installed Impeccable skill dir
 * @returns {{ content: string } | null}
 */
export function readImpeccableUpstreamBody(skillDir) {
  const upstreamPath = path.join(skillDir, 'SKILL.upstream.md');
  if (!fs.existsSync(upstreamPath)) {
    return null;
  }

  let content = stripSkillMarkdownEnvelope(fs.readFileSync(upstreamPath, 'utf8'));
  if (content.length > MAX_UPSTREAM_CHARS) {
    content = content.slice(0, MAX_UPSTREAM_CHARS) + TRUNCATION_MARKER;
  }

  return { content: `${formatSkillDirPreamble(skillDir)}\n\n${content}` };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} appRoot Minnow install root (seed for the ~/.minnow install)
 * @returns {boolean} true when handled
 */
export function handleImpeccableUpstreamRequest(req, res, pathname, appRoot) {
  if (pathname !== '/api/skills/impeccable/upstream' || req.method !== 'GET') {
    return false;
  }

  const payload = readImpeccableUpstreamBody(ensureImpeccableSkillInstalled(appRoot));

  res.setHeader('Content-Type', 'application/json');
  if (!payload) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Upstream skill body not found' }));
    return true;
  }

  res.statusCode = 200;
  res.end(JSON.stringify(payload));
  return true;
}
