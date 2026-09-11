/**
 * Appearance config normalize + HTML boot-script inject.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  appearanceBootPayload,
  appearanceLooksPersisted,
  defaultAppearanceConfig,
  injectAppearanceBootScript,
  normalizeAppearanceConfig,
} from '../../server/config/appearance.js';

describe('normalizeAppearanceConfig', () => {
  test('persists full chat view and normalizes unsupported values to compact', () => {
    assert.equal(normalizeAppearanceConfig({ chatView: 'full' }).chatView, 'full');
    assert.equal(appearanceBootPayload({ chatView: 'full' }).chatView, 'full');
    assert.equal(normalizeAppearanceConfig({ chatView: 'unknown' }).chatView, 'compact');
    assert.equal(appearanceLooksPersisted(normalizeAppearanceConfig({ chatView: 'full' })), true);
  });
  test('defaults when raw is empty', () => {
    const state = normalizeAppearanceConfig(null);
    assert.equal(state.themeId, 'swamp-dark');
    assert.equal(state.family, 'swamp');
    assert.equal(state.followSystem, false);
    assert.equal(state.updatedAt, null);
    assert.equal(appearanceLooksPersisted(state), false);
  });

  test('keeps an explicit ocean-dark theme id', () => {
    const state = normalizeAppearanceConfig({
      themeId: 'ocean-dark',
      family: 'swamp',
      updatedAt: '2026-09-05T00:00:00.000Z',
    });
    assert.equal(state.themeId, 'ocean-dark');
    assert.equal(state.family, 'ocean');
    assert.equal(appearanceLooksPersisted(state), true);
  });

  test('follow-system uses family as the source of truth', () => {
    const state = normalizeAppearanceConfig({
      followSystem: true,
      family: 'coral',
      themeId: 'ocean-light',
    });
    assert.equal(state.followSystem, true);
    assert.equal(state.family, 'coral');
    assert.equal(state.themeId, 'coral-light');
  });

  test('drops unsafe custom token values', () => {
    const state = normalizeAppearanceConfig({
      customEnabled: true,
      customTokens: {
        bg: '#0a1628',
        accent: '</script><script>',
        nope: '#fff',
      },
    });
    assert.equal(state.customTokens.bg, '#0a1628');
    assert.equal(state.customTokens.accent, undefined);
    assert.equal(state.customEnabled, true);
    assert.equal(appearanceLooksPersisted(state), true);
  });
});

describe('injectAppearanceBootScript', () => {
  test('inserts payload as the first script in head and escapes angle brackets', () => {
    const html = '<html><head><script>var x=1</script></head></html>';
    const payload = appearanceBootPayload({
      themeId: 'human-dark',
      customEnabled: true,
      customTokens: { bg: '#0f0f0f' },
      updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const out = injectAppearanceBootScript(html, payload);
    assert.match(out, /<head><script>window\.__MINNOW_APPEARANCE_BOOT__=/);
    assert.match(out, /"themeId":"human-dark"/);
  });

  test('escapes angle brackets inside the boot JSON', () => {
    const html = '<html><head></head></html>';
    const out = injectAppearanceBootScript(html, { note: '</script><script>alert(1)' });
    assert.match(out, /\\u003c/);
    const jsonStart = out.indexOf('__MINNOW_APPEARANCE_BOOT__=') + '__MINNOW_APPEARANCE_BOOT__='.length;
    const jsonEnd = out.indexOf(';</script>');
    const json = out.slice(jsonStart, jsonEnd);
    assert.doesNotMatch(json, /</);
  });

  test('no-ops when payload is missing', () => {
    const html = '<html><head></head></html>';
    assert.equal(injectAppearanceBootScript(html, null), html);
  });
});

describe('defaultAppearanceConfig', () => {
  test('matches swamp-dark defaults', () => {
    const state = defaultAppearanceConfig();
    assert.equal(state.version, 1);
    assert.equal(state.themeId, 'swamp-dark');
    assert.equal(state.fonts.ui.id, 'system');
  });
});
