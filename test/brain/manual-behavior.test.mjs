import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_SYNTHESIS_CONFIG } from '../../server/brain/synthesis-config.js';
import { routeSynthesisFact } from '../../server/brain/synthesis.js';

test('manual confidence routing agrees with shipped defaults and review override', async () => {
  const manual = await fs.readFile(new URL('../../documentation/manual/apps/brain.md', import.meta.url), 'utf8');
  const config = DEFAULT_SYNTHESIS_CONFIG;
  assert.equal(config.requireConfirmation, false);
  assert.ok(manual.includes(`below ${config.confidenceThreshold} confidence are skipped`));
  assert.ok(manual.includes(`at or above ${config.autoWriteConfidence} are saved directly`));
  assert.equal(routeSynthesisFact({ confidence: config.confidenceThreshold }, config), 'propose');
  assert.equal(routeSynthesisFact({ confidence: config.autoWriteConfidence }, config), 'write');
  assert.equal(routeSynthesisFact({ confidence: 1 }, { ...config, requireConfirmation: true }), 'propose');
  assert.ok(manual.includes('PUT /api/memory/synthesis/config'));
  assert.ok(manual.includes('"requireConfirmation":true,"autoWriteConfidence":0.85'));
});
test('both memory pages explain snapshot replay and supported freshness paths', async () => {
  for (const name of ['apps/brain.md', 'concepts/context-and-memory.md']) {
    const manual = await fs.readFile(new URL(`../../documentation/manual/${name}`, import.meta.url), 'utf8');
    assert.match(manual, /first user turn/);
    assert.match(manual, /Later turns replay that (saved )?snapshot/);
    assert.ok(manual.includes('brain_search') && manual.includes('brain_read_page'));
    assert.match(manual, /new chat/);
  }
});
