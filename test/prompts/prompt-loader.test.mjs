/**
 * Prompt loader: built-in init, user override, _example exclusion.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  initBuiltinPromptRegistry,
  loadPromptById,
  registerPromptFilesFromRaw,
  resetPromptRegistry,
  setUserPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';

describe('prompt-loader', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('loads registered base default', () => {
    registerPromptFilesFromRaw({
      './base/default.full.md': `---
id: default
kind: base
label: Test
version: 1
---
Minnow base body`,
    });
    const loaded = loadPromptById('base', 'default');
    assert.ok(loaded?.body.includes('Minnow'));
  });

  test('user override wins on same id', () => {
    registerPromptFilesFromRaw({
      './base/default.full.md': `---
id: default
kind: base
label: Builtin
version: 1
---
BUILTIN`,
    });
    setUserPromptRegistry([
      {
        id: 'default',
        kind: 'base',
        part: 'base',
        label: 'User',
        version: 1,
        body: 'USER_OVERRIDE',
        relativePath: 'base/default.full.md',
        source: 'user',
      },
    ]);
    const loaded = loadPromptById('base', 'default');
    assert.equal(loaded?.body, 'USER_OVERRIDE');
  });

  test('_example paths are not registered via registerPromptFilesFromRaw', () => {
    registerPromptFilesFromRaw({
      './_example/sample.full.md': `---
id: sample
kind: base
label: Example
version: 1
---
SHOULD_NOT_LOAD`,
    });
    const loaded = loadPromptById('base', 'sample');
    assert.equal(loaded, null);
  });
});
