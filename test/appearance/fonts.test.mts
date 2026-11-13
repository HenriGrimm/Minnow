/**
 * Font preset stacks and persistence.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import {
  applyAppearanceFonts,
  buildGoogleFontsCss2Url,
  getAppearanceFonts,
  GOOGLE_FONTS_LINK_ID,
  MONO_FONT_PRESETS,
  MONO_FONT_STACKS,
  resetAppearanceFontsForTests,
  setAppearanceFonts,
  subscribeAppearanceFonts,
  UI_FONT_PRESETS,
  UI_FONT_STACKS,
} from '../../src/appearance/fonts.ts';
import { APPEARANCE_STORAGE_KEYS } from '../../src/appearance/types.ts';

const STYLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/styles');

/** Recursively list CSS files under src/styles. */
function walkCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkCssFiles(full));
    else if (ent.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const storage = new Map<string, string>();

function mockLocalStorage(): void {
  (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.set(k, v);
    },
    removeItem: (k: string) => {
      storage.delete(k);
    },
    clear: () => storage.clear(),
    key: () => null,
    length: 0,
  };
}

function mockDocument(): void {
  (globalThis as typeof globalThis & { document?: unknown }).document = {
    documentElement: { style: { setProperty: () => {} } },
  };
}

afterEach(() => {
  storage.clear();
  resetAppearanceFontsForTests();
});

describe('appearance fonts', () => {
  test('defaults to bundled Geist and Geist Mono', () => {
    mockLocalStorage();
    const fonts = getAppearanceFonts();
    assert.equal(fonts.ui.kind, 'preset');
    assert.equal(fonts.mono.kind, 'preset');
    if (fonts.ui.kind === 'preset') assert.equal(fonts.ui.id, 'bundled-geist');
    if (fonts.mono.kind === 'preset') assert.equal(fonts.mono.id, 'bundled-geist');
  });

  test('setAppearanceFonts persists JSON', () => {
    mockLocalStorage();
    setAppearanceFonts({
      ui: { kind: 'preset', slot: 'ui', id: 'inter' },
      mono: { kind: 'preset', slot: 'mono', id: 'jetbrains-mono' },
    });
    const raw = storage.get(APPEARANCE_STORAGE_KEYS.fonts);
    assert.ok(raw?.includes('inter'));
    const loaded = getAppearanceFonts();
    if (loaded.ui.kind === 'preset') assert.equal(loaded.ui.id, 'inter');
  });

  test('preset stacks include fallbacks', () => {
    assert.match(UI_FONT_STACKS.inter, /Inter/);
    assert.match(MONO_FONT_STACKS['jetbrains-mono'], /JetBrains Mono/);
    assert.match(MONO_FONT_STACKS['fira-code'], /Fira Code/);
  });

  test('catalog has bundled Geist and retains the existing Google Fonts choices', () => {
    assert.ok(UI_FONT_PRESETS.length >= 31, `UI presets ${UI_FONT_PRESETS.length}`);
    assert.ok(MONO_FONT_PRESETS.length >= 21, `mono presets ${MONO_FONT_PRESETS.length}`);
    assert.ok(!UI_FONT_PRESETS.includes('geist'));
    assert.ok(!MONO_FONT_PRESETS.includes('geist-mono'));
    assert.ok(UI_FONT_PRESETS.includes('bundled-geist'));
    assert.ok(MONO_FONT_PRESETS.includes('bundled-geist'));
    assert.ok(UI_FONT_PRESETS.includes('inter'));
    assert.ok(MONO_FONT_PRESETS.includes('fira-code'));
    assert.ok(MONO_FONT_PRESETS.includes('cascadia-code'));
  });

  test('retired font IDs fall back to bundled defaults', () => {
    mockLocalStorage();
    storage.set(
      APPEARANCE_STORAGE_KEYS.fonts,
      JSON.stringify({
        ui: { kind: 'preset', slot: 'ui', id: 'geist' },
        mono: { kind: 'preset', slot: 'mono', id: 'geist-mono' },
      }),
    );
    const fonts = getAppearanceFonts();
    if (fonts.ui.kind === 'preset') assert.equal(fonts.ui.id, 'bundled-geist');
    if (fonts.mono.kind === 'preset') assert.equal(fonts.mono.id, 'bundled-geist');
  });

  test('Google Fonts CSS2 URL encodes families and weights', () => {
    const href = buildGoogleFontsCss2Url([
      { family: 'Inter', weights: [400, 500, 600] },
      { family: 'Fira Code', weights: [400, 500, 600] },
    ]);
    assert.equal(
      href,
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Fira+Code:wght@400;500;600&display=swap',
    );
  });

  test('duplicate Google families collapse to one CSS2 family param', () => {
    const href = buildGoogleFontsCss2Url([
      { family: 'JetBrains Mono', weights: [400, 500] },
      { family: 'JetBrains Mono', weights: [400, 600] },
    ]);
    assert.equal(
      href,
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap',
    );
  });

  // Regression: applying fonts must not notify font listeners. theme.ts
  // subscribes a listener that re-applies fonts; if applyAppearanceFonts emits,
  // that recurses infinitely (RangeError: Maximum call stack size exceeded) and
  // aborts boot. See MIN-262 crash log.
  test('applyAppearanceFonts does not re-emit to font listeners', async () => {
    mockLocalStorage();
    mockDocument();
    let reapplies = 0;
    const unsub = subscribeAppearanceFonts(() => {
      reapplies += 1;
      void applyAppearanceFonts();
    });
    await applyAppearanceFonts();
    unsub();
    assert.equal(reapplies, 0);
  });

  // --mn-font-mono was never defined. Appearance writes --font-mono on
  // documentElement; leftover --mn-font-mono rules ignored that preference.
  test('stylesheets do not reference the undefined --mn-font-mono alias', () => {
    const hits: string[] = [];
    for (const file of walkCssFiles(STYLES_DIR)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('--mn-font-mono')) {
        hits.push(path.relative(STYLES_DIR, file));
      }
    }
    assert.deepEqual(hits, []);
  });

  test('mono surfaces follow documentElement --font-mono after a preset change', () => {
    const win = new Window();
    const style = win.document.createElement('style');
    style.textContent = [
      readFileSync(path.join(STYLES_DIR, 'tokens.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'command-palette.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'context-menu.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'context-usage.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'code-change-strip.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'shell-keyboard-help.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'settings-page.css'), 'utf8'),
      readFileSync(path.join(STYLES_DIR, 'onboarding.css'), 'utf8'),
    ].join('\n');
    win.document.head.appendChild(style);

    // Same write applyAppearanceFonts performs for Settings → Appearance → Fonts.
    const stack = MONO_FONT_STACKS['ibm-plex-mono'];
    win.document.documentElement.style.setProperty('--font-mono', stack);

    const classes = [
      'mn-palette__shortcut',
      'mn-menu__shortcut',
      'context-usage-breakdown__model',
      'code-change-strip__stats',
      'shell-keyboard-help__kbd',
      'settings-proposal-body',
      'mn-onboarding__progress-label',
    ];
    for (const className of classes) {
      const el = win.document.createElement('span');
      el.className = className;
      el.textContent = '0123456789';
      win.document.body.appendChild(el);
      const family = win.getComputedStyle(el).fontFamily;
      assert.match(
        family,
        /IBM Plex Mono/,
        `${className} computed font-family ${JSON.stringify(family)} should follow --font-mono`,
      );
    }
    win.close();
  });

  test('stylesheets do not @import Google Fonts or Fontsource at boot', () => {
    const hits: string[] = [];
    for (const file of walkCssFiles(STYLES_DIR)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('fonts.googleapis.com') || text.includes('fontsource/geist')) {
        hits.push(path.relative(STYLES_DIR, file));
      }
    }
    assert.deepEqual(hits, []);
  });

  test('applyAppearanceFonts injects one Google Fonts stylesheet for the selected pair', async () => {
    mockLocalStorage();
    const win = new Window();
    const prevDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: win.document,
    });
    setAppearanceFonts({
      ui: { kind: 'preset', slot: 'ui', id: 'inter' },
      mono: { kind: 'preset', slot: 'mono', id: 'fira-code' },
    });
    await applyAppearanceFonts();
    const link = win.document.getElementById(GOOGLE_FONTS_LINK_ID);
    assert.ok(link, 'expected #minnow-google-fonts stylesheet');
    const href = link?.getAttribute('href') ?? '';
    assert.match(href, /family=Inter:wght@400;500;600/);
    assert.match(href, /family=Fira\+Code:wght@400;500;600/);
    assert.match(href, /display=swap/);
    win.close();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: prevDocument,
    });
  });
});
