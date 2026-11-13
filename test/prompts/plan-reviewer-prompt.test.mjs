/**
 * Static checks for plan-reviewer sub-agent prompts (Super Plan Phase 5).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHIPPED_SUB_AGENT_PROMPTS } from '../../src/agents/shipped-sub-agent-prompts.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PROMPT_DIR = path.join(REPO_ROOT, 'src/agents/prompts/sub-agents');

async function readPrompt(name) {
  return (await fs.readFile(path.join(PROMPT_DIR, name), 'utf8')).trim();
}

describe('plan-reviewer sub-agent prompts', () => {
  test('plan-reviewer.full is populated', async () => {
    const body = await readPrompt('plan-reviewer.full.md');
    assert.ok(body.length > 0, 'plan-reviewer.full shipped prompt must be non-empty');
    assert.ok(body.includes('Pass 1'), 'must describe pass 1 behavior');
    assert.ok(body.includes('Pass 2'), 'must describe pass 2 behavior');
    assert.ok(body.includes('suggested fix'), 'must require suggested fixes in findings');
    assert.ok(body.includes('read-only'), 'must enforce read-only constraints');
    assert.match(body, /Empty workspace: Wave 1 is scaffold only/);
    assert.match(body, /\*\*blocker\*\*/);
  });

  test('shipped map matches greenfield blocker contract', () => {
    const full = SHIPPED_SUB_AGENT_PROMPTS['plan-reviewer'] ?? '';
    assert.match(full, /Empty workspace: Wave 1 is scaffold only/);
  });
});
