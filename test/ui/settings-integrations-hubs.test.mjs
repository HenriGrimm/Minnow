import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { SETTINGS_INTEGRATIONS_HUBS, hubForArea } = await import(
  '../../src/ui/settings-page-types.ts'
);

describe('settings integrations hubs', () => {
  test('hubForArea maps legacy integration areas', () => {
    assert.equal(hubForArea('search'), 'web-research');
    // Deep Research was dropped with the Research app (hidden for release).
    assert.equal(hubForArea('deep-research'), undefined);
    assert.equal(hubForArea('servers'), 'servers');
    assert.equal(hubForArea('tools'), 'tools');
    assert.equal(hubForArea('skills'), 'skills');
    assert.equal(hubForArea('skills-library'), 'skills');
    assert.equal(hubForArea('browser'), 'browser');
    assert.equal(hubForArea('mcp'), 'mcp');
    assert.equal(hubForArea('mcp-hub'), 'mcp-hub');
    assert.equal(hubForArea('lsp'), 'lsp');
    assert.equal(hubForArea('editor'), 'editor');
    assert.equal(hubForArea('webhooks'), 'external');
  });

  test('every integration area belongs to exactly one hub', () => {
    const integrationAreas = [
      'search',
      'servers',
      'tools',
      'skills',
      'skills-library',
      'browser',
      'mcp',
      'mcp-hub',
      'lsp',
      'editor',
      'webhooks',
    ];
    for (const area of integrationAreas) {
      assert.ok(hubForArea(area), `missing hub for ${area}`);
    }
    const hubAreaCount = SETTINGS_INTEGRATIONS_HUBS.reduce(
      (sum, hub) => sum + hub.areas.length,
      0,
    );
    assert.equal(hubAreaCount, integrationAreas.length);
  });
});
