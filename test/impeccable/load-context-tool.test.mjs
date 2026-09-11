/**
 * load_impeccable_context server tool runs the script from the skill dir.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { toolLoadImpeccableContext } from '../../server/impeccable/load-impeccable-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(PROJECT_ROOT, 'src', 'skills', 'impeccable');
const PARTIAL_FIXTURE = path.join(
  PROJECT_ROOT,
  'test/fixtures/impeccable-workspace-partial',
);

/** Strip optional server Note line appended for partial context. */
function parseToolResult(result) {
  const jsonLine = result.split('\n\nNote:')[0].trim();
  return JSON.parse(jsonLine);
}

describe('load_impeccable_context tool', () => {
  it('returns JSON with designJson for Minnow workspace', async () => {
    const { result } = await toolLoadImpeccableContext(SKILL_DIR, PROJECT_ROOT);
    assert.ok(!result.startsWith('Error:'), result.slice(0, 200));
    const payload = parseToolResult(result);
    assert.equal(payload.hasDesignJson, true);
    assert.equal(payload.designJson.schemaVersion, 3);
    assert.equal(payload.hasProduct, true);
    assert.equal(payload.hasDesign, true);
  });

  it('soft success when PRODUCT.md and DESIGN.md exist without sidecar', async () => {
    const { result } = await toolLoadImpeccableContext(SKILL_DIR, PARTIAL_FIXTURE);
    assert.ok(!result.startsWith('Error:'), result.slice(0, 200));
    const payload = parseToolResult(result);
    assert.equal(payload.hasProduct, true);
    assert.equal(payload.hasDesign, true);
    assert.equal(payload.hasDesignJson, false);
    assert.equal(payload.designJson, null);
    assert.match(payload.designJsonSetupHint, /\/impeccable document/);
    assert.match(result, /Note:.*\/impeccable document/);
  });
});
