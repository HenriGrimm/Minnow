/**
 * Mode prompt loader integration tests.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  loadModePromptBody,
  MODE_IDS,
} from '../../src/chat/modes/registry.ts';
import {
  clearUserPromptRegistry,
  registerPromptFilesFromRaw,
  resetPromptRegistry,
  setUserPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { loadBuiltinModePromptMap } from './test-helpers.mts';

describe('loadModePromptBody', () => {
  beforeEach(() => {
    resetPromptRegistry();
    clearUserPromptRegistry();
  });

  test('each mode loads a non-empty prompt', async () => {
    registerPromptFilesFromRaw(await loadBuiltinModePromptMap());
    for (const id of MODE_IDS) {
      const body = loadModePromptBody(id);
      const markerId = id === 'desktop' || id === 'email' ? 'general' : id;
      assert.ok(body.length > 0, `${id} full empty`);
      assert.match(body, new RegExp(`MINNOW_MODE_MARKER: ${markerId} full`));
    }
  });

  test('plan full contains do-not-modify guidance', async () => {
    registerPromptFilesFromRaw(await loadBuiltinModePromptMap());
    const body = loadModePromptBody('plan');
    assert.match(body.toLowerCase(), /do not modify/);
  });

  test('user override wins over built-in', async () => {
    registerPromptFilesFromRaw(await loadBuiltinModePromptMap());
    setUserPromptRegistry([
      {
        id: 'build',
        kind: 'mode',
        part: 'mode',
        label: 'Build override',
        version: 1,
        body: 'OVERRIDE_MARKER full body',
        relativePath: 'modes/build.full.md',
        source: 'user',
      },
    ]);
    const body = loadModePromptBody('build');
    assert.match(body, /OVERRIDE_MARKER/);
  });
});
