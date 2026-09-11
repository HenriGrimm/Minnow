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
import { isToolAllowedForMode } from '../../src/chat/modes/tool-policy.ts';

describe('mode registry super-plan', () => {
  // Super Plan is disabled for release — see src/config/super-plan-enabled.ts.
  test('listModes excludes super-plan while it is disabled', () => {
    const ids = listModes().map((m) => m.id);
    assert.ok(!ids.includes('super-plan'));
  });

  test('normalizeModeId collapses super-plan to plan', () => {
    assert.equal(normalizeModeId('super-plan'), 'plan');
  });

  test('getMode returns Super Plan definition', () => {
    const mode = getMode('super-plan');
    assert.equal(mode.id, 'super-plan');
    assert.equal(mode.label, 'Super Plan');
    assert.equal(mode.promptId, 'super-plan');
  });

  test('listComposerModes excludes super-plan from top-level strip', () => {
    const composer = listComposerModes().map((m) => m.id);
    assert.ok(!composer.includes('super-plan'));
    assert.ok(composer.includes('plan'));
  });
});

describe('super-plan tool policy', () => {
  test('denies execute_command', () => {
    assert.equal(isToolAllowedForMode('super-plan', 'execute_command'), false);
  });

  test('allows spawn_sub_agent and get_sub_agent_status', () => {
    assert.equal(isToolAllowedForMode('super-plan', 'spawn_sub_agent'), true);
    assert.equal(isToolAllowedForMode('super-plan', 'get_sub_agent_status'), true);
  });

  test('allows save_file for plan writes', () => {
    assert.equal(isToolAllowedForMode('super-plan', 'save_file'), true);
  });

  test('allows issue_* tools', () => {
    assert.equal(isToolAllowedForMode('super-plan', 'issue_search'), true);
    assert.equal(isToolAllowedForMode('super-plan', 'issue_update'), true);
  });
});

describe('persisted email mode remap', () => {
  test("normalizeModeId('email') === 'general'", () => {
    assert.equal(normalizeModeId('email'), 'general');
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
  test("normalizeModeId('desktop') === 'general'", () => {
    assert.equal(normalizeModeId('desktop'), 'general');
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
