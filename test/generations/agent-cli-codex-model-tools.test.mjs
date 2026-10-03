import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCodexModelToolSmoke } from '../../scripts/codex-model-tool-smoke.mjs';

test('every installed Codex catalog model hands tools to Minnow and resumes with the real result', {
  skip: process.env.MINNOW_CODEX_APP_SERVER_SMOKE !== '1', timeout: 120_000,
}, async () => {
  const results = await runCodexModelToolSmoke();
  assert.ok(results.length > 0);
  assert.deepEqual(results.filter(row => row.status !== 'passed'), []);
});
