/**
 * Mode registry tests (super-plan Phase 0).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  getMode,
  listComposerModes,
  listModes,
} from '../../src/chat/modes/registry.ts';
import { normalizeModeId } from '../../src/chat/modes/types.ts';
import { normalizePersistedModeId } from '../../src/state/session-schema.mjs';

describe('mode registry super-plan', () => {
  test('listModes excludes super-plan while it is disabled', () => {
    const ids = listModes().map((m) => m.id);
    assert.ok(!ids.includes('super-plan'));
  });

  test('persisted super-plan stays a compatible Plan record', () => {
    assert.equal(normalizePersistedModeId('super-plan'), 'plan');
    assert.equal(normalizeModeId('super-plan'), 'build');
  });

  test('getMode maps the retired id to Plan', () => {
    const mode = getMode('super-plan');
    assert.equal(mode.id, 'plan');
    assert.equal(mode.label, 'Plan');
    assert.equal(mode.promptId, 'plan');
  });

  test('listComposerModes excludes super-plan from top-level strip', () => {
    const composer = listComposerModes().map((m) => m.id);
    assert.ok(!composer.includes('super-plan'));
    assert.deepEqual(composer, []);
  });
});

describe('persisted email mode remap', () => {
  test("normalizePersistedModeId('email') === 'general'", () => {
    assert.equal(normalizePersistedModeId('email'), 'general');
  });

  test('getMode remaps email to the general definition', () => {
    const mode = getMode('email');
    assert.equal(mode.id, 'general');
    assert.equal(mode.label, 'General');
  });

  test('email is not a live registry entry', () => {
    assert.ok(!listModes().some((mode) => mode.id === 'email'));
    assert.ok(!listComposerModes().some((mode) => mode.id === 'email'));
  });
});

describe('persisted desktop mode remap', () => {
  test("normalizePersistedModeId('desktop') === 'general'", () => {
    assert.equal(normalizePersistedModeId('desktop'), 'general');
  });

  test('getMode remaps desktop to the general definition', () => {
    const mode = getMode('desktop');
    assert.equal(mode.id, 'general');
    assert.equal(mode.label, 'General');
  });

  test('desktop is not a live registry entry', () => {
    assert.ok(!listModes().some((mode) => mode.id === 'desktop'));
  });
});
