import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { SETTINGS_SECTIONS } = await import(
  '../../src/ui/settings-page-types.ts'
);
const { buildSettingsSearchIndex } = await import(
  '../../src/ui/settings-search-index.ts'
);

describe('settings-search-index', () => {
  test('section entries derive from SETTINGS_SECTIONS inventory', () => {
    const index = buildSettingsSearchIndex();
    const sectionEntries = index.filter((e) => e.kind === 'section');
    assert.equal(sectionEntries.length, SETTINGS_SECTIONS.length);
    for (const sectionId of SETTINGS_SECTIONS) {
      assert.ok(
        sectionEntries.some(
          (e) => e.sectionId === sectionId && e.id === `section:${sectionId}`,
        ),
        `missing section entry for ${sectionId}`,
      );
    }
  });

  test('diagnostics aliases include health keywords', () => {
    const index = buildSettingsSearchIndex();
    const diagnostics = index.find((e) => e.id === 'section:diagnostics');
    assert.ok(diagnostics);
    assert.ok(diagnostics.keywords?.includes('health'));
  });

  test('voice keywords route to Models app entry', () => {
    const index = buildSettingsSearchIndex();
    const voice = index.find((e) => e.id === 'models:voice');
    assert.ok(voice);
    assert.equal(voice.kind, 'models-section');
    assert.equal(voice.modelsSection, 'voice');
    assert.ok(voice.keywords?.includes('stt'));
    assert.ok(voice.keywords?.includes('tts'));
  });

  test('servers section includes searxng and managed server keywords', () => {
    const index = buildSettingsSearchIndex();
    const servers = index.find((e) => e.id === 'section:servers');
    assert.ok(servers);
    assert.equal(servers.sectionId, 'servers');
    assert.ok(servers.keywords?.includes('searxng'));
    assert.ok(servers.keywords?.includes('managed server'));
  });

  test('includes built-in tool entries', () => {
    const index = buildSettingsSearchIndex();
    const webSearch = index.find((e) => e.id === 'tool:web_search');
    assert.ok(webSearch);
    assert.equal(webSearch.sectionId, 'search');
    assert.equal(webSearch.searchKey, 'tools.item.web_search');
  });

  test('memory catalog fields route to Brain app', () => {
    const index = buildSettingsSearchIndex();
    const memory = index.find((e) => e.id === 'brain:memories-enabled');
    assert.ok(memory);
    assert.equal(memory.kind, 'brain-section');
    assert.equal(memory.brainSection, 'memories');
    assert.equal(memory.searchKey, 'knowledge.memory.enabled');
    const embeddings = index.find((e) => e.id === 'brain:embeddings');
    assert.ok(embeddings);
    assert.equal(embeddings.brainSection, 'settings');
  });

  test('injection fields route to the main Agents settings section', () => {
    const index = buildSettingsSearchIndex();
    const injection = index.find((e) => e.id === 'field:agents.injection.brainNotes');
    assert.ok(injection);
    assert.equal(injection.kind, 'field');
    assert.equal(injection.sectionId, 'injection');
    assert.equal(injection.searchKey, 'agents.injection.brainNotes');
    assert.equal(index.some((e) => e.id === 'brain:memories-injection'), false);
    assert.equal(index.some((e) => e.id === 'brain:code-map-injection-default'), false);
  });

  test('includes category entries', () => {
    const index = buildSettingsSearchIndex();
    const models = index.find((e) => e.id === 'category:models');
    assert.ok(models);
    assert.equal(models.kind, 'category');
  });

  test('omits email mode when Email app is release-hidden', () => {
    const index = buildSettingsSearchIndex();
    assert.equal(index.some((e) => e.id === 'mode:email'), false);
    assert.ok(index.some((e) => e.id === 'mode:general'));
  });
});
