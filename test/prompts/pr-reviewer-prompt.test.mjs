/**
 * Static checks for pr-reviewer sub-agent prompts.
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

describe('pr-reviewer sub-agent prompts', () => {
  test('pr-reviewer.full covers dimensions, verdict, JSON, unattended', async () => {
    const body = await readPrompt('pr-reviewer.full.md');
    assert.ok(body.includes('Correctness'));
    assert.ok(body.includes('APPROVE'));
    assert.ok(body.includes('REQUEST_CHANGES'));
    assert.ok(body.includes('NEEDS_DISCUSSION'));
    assert.ok(body.includes('suggested fix'));
    assert.ok(body.includes('ask_question'));
    assert.ok(body.includes('not') && body.includes('in this chat'));
  });

  test('shipped map includes the PR framing and JSON contract', () => {
    const body = SHIPPED_SUB_AGENT_PROMPTS['pr-reviewer'] ?? '';
    assert.ok(body.includes('PR reviewer'));
    assert.ok(body.includes('APPROVE'));
    assert.ok(body.includes('execute_command'));
    assert.ok(body.includes('NEEDS_DISCUSSION'));
  });
});
