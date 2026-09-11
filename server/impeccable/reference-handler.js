/**
 * GET /api/skills/impeccable/reference/:command — harness reference markdown from ~/.minnow/skills/impeccable.
 */

import fs from 'node:fs';
import {
  isHarnessCommand,
  resolveHarnessCommand,
  resolveReferencePath,
} from './command-routing.js';
import { ensureImpeccableSkillInstalled } from './skill-install.js';

const MAX_REFERENCE_CHARS = 64_000;
const TRUNCATION_MARKER = '\n\n…[reference truncated at 64k]';

/**
 * Read harness reference content for a sub-command.
 * Aliases (e.g. teach → init) resolve before lookup.
 * @param {string} skillDir Installed Impeccable skill dir
 * @param {string} command Harness sub-command or alias
 * @returns {{ command: string, content: string } | null}
 */
export function readImpeccableReference(skillDir, command) {
  const cmd = typeof command === 'string' ? command.trim() : '';
  const resolved = resolveHarnessCommand(cmd);
  if (!cmd || !resolved || !isHarnessCommand(cmd)) {
    return null;
  }

  const refPath = resolveReferencePath(skillDir, cmd);
  if (!refPath) {
    return null;
  }

  let content = fs.readFileSync(refPath, 'utf8');
  if (content.length > MAX_REFERENCE_CHARS) {
    content = content.slice(0, MAX_REFERENCE_CHARS) + TRUNCATION_MARKER;
  }

  return { command: resolved, content };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} appRoot Minnow install root (seed for the ~/.minnow install)
 * @returns {boolean} true when handled
 */
export function handleImpeccableReferenceRequest(req, res, pathname, appRoot) {
  const match = pathname.match(/^\/api\/skills\/impeccable\/reference\/([^/]+)$/);
  if (!match || req.method !== 'GET') {
    return false;
  }

  const command = decodeURIComponent(match[1]);
  const payload = readImpeccableReference(ensureImpeccableSkillInstalled(appRoot), command);

  res.setHeader('Content-Type', 'application/json');
  if (!payload) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Reference not found' }));
    return true;
  }

  res.statusCode = 200;
  res.end(JSON.stringify(payload));
  return true;
}
