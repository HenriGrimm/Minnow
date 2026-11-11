/**
 * Orchestrate mode prompts must not name deleted V1 board tools (MIN-715).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_ROOT = path.join(__dirname, '../../src/chat/prompts');
const SERVER_PROMPTS = path.join(__dirname, '../../server/orchestrator/prompts');

const DELETED_TOOLS = [
  'board_init',
  'board_update_task',
  'board_set_autonomy',
  'delegate_tasks',
  'board_report',
  'board_add_tasks',
  'board_get_state',
];

const FORBIDDEN_DEPENDS_ON_EMPTY = /dependsOn["']?\s*:\s*\[\s*\]/;

function walkMarkdown(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
      continue;
    }
    if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

describe('orchestrate prompts after P4-C', () => {
  test('mode prompts say Orchestrate opens a board, not a planner chat', () => {
    const full = fs.readFileSync(path.join(PROMPTS_ROOT, 'modes', 'orchestrate.full.md'), 'utf8');
    assert.match(full, /board, not a chat/i);
    assert.doesNotMatch(full, FORBIDDEN_DEPENDS_ON_EMPTY);
  });

  test('prompt corpus does not name deleted board tools or the empty-dependsOn workaround', () => {
    const files = [...walkMarkdown(PROMPTS_ROOT), ...walkMarkdown(SERVER_PROMPTS)];
    assert.ok(files.length > 0);
    for (const abs of files) {
      const body = fs.readFileSync(abs, 'utf8');
      const rel = path.relative(path.join(__dirname, '../..'), abs);
      for (const tool of DELETED_TOOLS) {
        assert.equal(
          body.includes(tool),
          false,
          `${rel} still names ${tool}`,
        );
      }
      assert.equal(
        FORBIDDEN_DEPENDS_ON_EMPTY.test(body),
        false,
        `${rel} still has the empty-dependsOn prompt workaround`,
      );
    }
  });

  test('board builders are not instructed to use renderer-only todo tools', () => {
    for (const variant of ['agent.full.md']) {
      const body = fs.readFileSync(path.join(SERVER_PROMPTS, 'builder', variant), 'utf8');
      assert.doesNotMatch(body, /todo_write|progress todos/i, variant);
    }
  });
});
