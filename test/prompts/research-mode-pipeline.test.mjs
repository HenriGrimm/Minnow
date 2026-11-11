/**
 * Static checks for researcher sub-agent worker prompts (composer Research mode removed).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SHIPPED_SUB_AGENT_PROMPTS } from '../../src/agents/shipped-sub-agent-prompts.ts';

describe('researcher sub-agent prompts', () => {
  test('SHIPPED_SUB_AGENT_PROMPTS researcher is populated', () => {
    const body = SHIPPED_SUB_AGENT_PROMPTS['researcher']?.trim() ?? '';
    assert.ok(body.length > 0, 'researcher.full shipped prompt must be non-empty');
    assert.ok(body.includes('## Findings'), 'worker contract must include Findings');
    assert.ok(body.includes('## Sources'), 'worker contract must include Sources');
  });
});
