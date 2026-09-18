import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { rankSettingsSearch } = await import(
  '../../src/ui/settings-search-rank.ts'
);
const { buildSettingsSearchIndex } = await import(
  '../../src/ui/settings-search-index.ts'
);
const {
  closeSettingsSearchResultsForTests,
  focusSettingsSearchInputForTests,
  initSettingsSearchFinder,
} = await import('../../src/ui/settings-search-finder.ts');
const { resolveSettingsSearchDomTarget } = await import(
  '../../src/ui/settings-search-navigate.ts'
);

function setupSettingsHeaderDom() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };

  const settingsView = document.createElement('main');
  settingsView.id = 'settingsView';
  settingsView.className = 'settings-page is-open';

  const header = document.createElement('header');
  header.className = 'settings-page-header';

  const back = document.createElement('button');
  back.type = 'button';
  back.id = 'btnSettingsPageBack';
  header.appendChild(back);

  const title = document.createElement('h1');
  title.className = 'settings-page-header__title';
  title.textContent = 'Settings';
  header.appendChild(title);

  const homeSlot = document.createElement('div');
  homeSlot.id = 'settingsSearchFinderSlot';
  homeSlot.className = 'settings-search-finder-slot';

  const finder = document.createElement('div');
  finder.id = 'settingsSearchFinder';
  finder.className = 'settings-search-finder';

  const label = document.createElement('label');
  label.className = 'settings-search-finder__field';
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'settingsSearchInput';
  input.className = 'settings-search-finder__input';
  label.appendChild(input);
  finder.appendChild(label);

  const results = document.createElement('div');
  results.id = 'settingsSearchResults';
  results.className = 'settings-search-finder__results';
  results.hidden = true;
  finder.appendChild(results);

  homeSlot.appendChild(finder);
  header.appendChild(homeSlot);

  const estimate = document.createElement('span');
  estimate.id = 'settingsPromptTokenEstimate';
  estimate.className = 'settings-prompt-estimate';
  estimate.textContent = '~0 tokens';
  header.appendChild(estimate);

  settingsView.appendChild(header);
  document.body.appendChild(settingsView);

  const section = document.createElement('section');
  section.id = 'settingsSection-tools';
  section.className = 'settings-section';
  const group = document.createElement('section');
  group.className = 'settings-group';
  group.dataset.settingsSearchKey = 'tools.category.web';
  section.appendChild(group);
  document.body.appendChild(section);

  return { input, results, estimate, header };
}

describe('settings-search-finder', () => {
  afterEach(() => {
    closeSettingsSearchResultsForTests();
  });

  test('header keeps token estimate beside search field', () => {
    const { header, estimate, input } = setupSettingsHeaderDom();
    assert.ok(header.contains(input));
    assert.ok(header.contains(estimate));
  });

  test('ranking drives result list on input', () => {
    const { input, results } = setupSettingsHeaderDom();
    initSettingsSearchFinder();
    input.value = 'diagnostics';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const ranked = rankSettingsSearch('diagnostics', buildSettingsSearchIndex());
    assert.ok(ranked.length > 0);
    assert.ok(results.querySelector('.settings-search-finder__option'));
    assert.equal(results.hidden, false);
  });

  test('Escape closes results', () => {
    const { input, results } = setupSettingsHeaderDom();
    initSettingsSearchFinder();
    input.value = 'general';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(results.hidden, false);
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.equal(results.hidden, true);
  });

  test('resolveSettingsSearchDomTarget falls back when key missing', () => {
    setupSettingsHeaderDom();
    const target = resolveSettingsSearchDomTarget('tools', 'tools.item.missing');
    assert.ok(target);
    assert.equal(target.dataset.settingsSearchKey, 'tools.category.web');
  });

});
