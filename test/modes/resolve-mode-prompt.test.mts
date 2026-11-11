/**
 * Mode prompt path resolution tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveModePromptPath } from '../../src/chat/modes/registry.ts';

describe('resolveModePromptPath', () => {
  test('general', () => {
    assert.ok(
      resolveModePromptPath('general').endsWith('modes/general.full.md'),
    );
  });

  test('email remaps to the general prompt file', () => {
    assert.ok(resolveModePromptPath('email').endsWith('modes/general.full.md'));
  });

  test('build', () => {
    assert.ok(resolveModePromptPath('build').endsWith('modes/build.full.md'));
  });

  test('plan', () => {
    assert.ok(resolveModePromptPath('plan').endsWith('modes/plan.full.md'));
  });

  test('orchestrate', () => {
    assert.ok(
      resolveModePromptPath('orchestrate').endsWith('modes/orchestrate.full.md'),
    );
  });

  test('debug', () => {
    assert.ok(resolveModePromptPath('debug').endsWith('modes/debug.full.md'));
  });

});
