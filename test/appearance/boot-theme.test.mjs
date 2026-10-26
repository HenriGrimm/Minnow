import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { appearanceBootPayload, injectAppearanceBootScript } from '../../server/config/appearance.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function boot({ saved, cached = {}, light = false } = {}) {
  const storage = new Map(Object.entries(cached));
  const attributes = new Map();
  const tokens = new Map();
  const root = {
    setAttribute: (key, value) => attributes.set(key, value),
    style: {
      setProperty: (key, value) => tokens.set(key, value),
      getPropertyValue: (key) => tokens.get(key) || '',
    },
    classList: { add() {} },
  };
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: light }) },
    performance: { now: () => 0 },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    document: { documentElement: root, querySelector: () => ({ setAttribute() {} }) },
  });
  const source = injectAppearanceBootScript(html, saved && appearanceBootPayload(saved));
  for (const script of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  return { theme: attributes.get('data-theme'), tokens, storage };
}

test('palette CSS blocks the first paint independently of the app entry module', () => {
  const stylesheet = html.indexOf('<link rel="stylesheet" href="/src/styles/tokens.css">');
  assert.ok(stylesheet > 0 && stylesheet < html.indexOf('<body'));
  const critical = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(critical, /background: var\(--mn-bg\);/);
  assert.doesNotMatch(critical, /html\[data-theme=.*background:/);
});

test('saved palette wins over a stale origin cache before the app starts', () => {
  assert.equal(boot({ saved: { themeId: 'human-light' }, cached: { 'minnow.theme': 'ocean-dark' } }).theme, 'human-light');
  assert.equal(boot({ saved: { followSystem: true, family: 'mint' }, light: true }).theme, 'mint-light');
  assert.equal(boot({ cached: { 'minnow.theme': 'desert-dark' } }).theme, 'desert-dark');
});

test('custom palette is applied before the loading screen renders', () => {
  const { tokens } = boot({ saved: { customEnabled: true, customTokens: { bg: '#112233', fg: '#eeeeee', accent: '#abcdef' } } });
  assert.equal(tokens.get('--mn-bg'), '#112233');
  assert.equal(tokens.get('--mn-fg'), '#eeeeee');
  assert.equal(tokens.get('--mn-accent'), '#abcdef');
});

test('disabled saved custom colors cannot leak from a stale cache into first paint', () => {
  const { tokens, storage } = boot({
    saved: { themeId: 'mono-light', customEnabled: false },
    cached: { 'minnow.appearance.customEnabled': '1', 'minnow.appearance.customTokens': '{"bg":"#112233"}' },
  });
  assert.equal(tokens.size, 0);
  assert.equal(storage.has('minnow.appearance.customEnabled'), false);
});
