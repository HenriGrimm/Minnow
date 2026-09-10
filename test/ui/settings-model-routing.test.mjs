import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

describe('settings model routing HTML', () => {
  test('model-routing section and nav exist', () => {
    assert.match(html, /id="settingsSection-model-routing"/);
    assert.match(html, /id="settingsModelRoutingBody"/);
    assert.match(html, /data-settings-nav-area="model-routing"/);
    assert.match(html, /data-settings-nav-area="providers"/);
    assert.match(html, /<h2>Routing<\/h2>/);
  });
});

describe('settings model routing catalog', () => {
  test('catalog source defines main-chat row', () => {
    const source = readFileSync(join(root, 'src/settings/model-routing-catalog.ts'), 'utf8');
    assert.match(source, /id: 'main-chat'/);
    assert.match(source, /group: 'main-chat'/);
    assert.match(source, /persistKind: 'main-chat'/);
    assert.match(source, /id: 'utility-tasks'/);
    const uiSource = readFileSync(join(root, 'src/ui/settings-model-routing.ts'), 'utf8');
    assert.match(uiSource, /combinedModelPicker: true/);
  });
});

describe('settings model routing types', () => {
  test('models category areas include model-routing', async () => {
    const { SETTINGS_CATEGORY_AREAS } = await import('../../src/ui/settings-page-types.ts');
    const modelsAreas = SETTINGS_CATEGORY_AREAS.models;
    assert.ok(modelsAreas.includes('model-routing'));
    const providersIdx = modelsAreas.indexOf('providers');
    const routingIdx = modelsAreas.indexOf('model-routing');
    assert.ok(providersIdx >= 0 && routingIdx > providersIdx);
  });
});
