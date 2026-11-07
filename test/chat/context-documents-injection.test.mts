/**
 * Context document path resolution and config defaults.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defaultEnabledPresetIds } from '../../src/chat/context-documents/catalog.ts';
import { resolveContextDocumentsBlock } from '../../src/chat/context-documents/resolve-block.ts';
import {
  dedupeCustomPathsAgainstPresets,
  isValidContextDocumentPath,
  resolveEnabledDocumentPaths,
  type ContextDocumentsConfig,
} from '../../src/chat/context-documents/config.ts';

describe('context documents config', () => {
  test('default presets include agents-md and context-md', () => {
    const ids = defaultEnabledPresetIds();
    assert.ok(ids.includes('agents-md'));
    assert.ok(ids.includes('context-md'));
  });

  test('resolveEnabledDocumentPaths unions presets and custom paths', () => {
    const config: ContextDocumentsConfig = {
      maxTotalChars: 48_000,
      enabledPresets: ['agents-md'],
      customPaths: ['docs/EXTRA.md'],
    };
    const paths = resolveEnabledDocumentPaths(config);
    assert.ok(paths.includes('AGENTS.md'));
    assert.ok(paths.includes('docs/EXTRA.md'));
  });

  test('isValidContextDocumentPath rejects absolute and parent segments', () => {
    assert.equal(isValidContextDocumentPath('AGENTS.md'), true);
    assert.equal(isValidContextDocumentPath('/etc/passwd'), false);
    assert.equal(isValidContextDocumentPath('..\\secret'), false);
    assert.equal(isValidContextDocumentPath('C:/Windows'), false);
  });

  test('dedupeCustomPathsAgainstPresets removes preset collisions', () => {
    const out = dedupeCustomPathsAgainstPresets(['AGENTS.md', 'custom/foo.md']);
    assert.deepEqual(out, ['custom/foo.md']);
  });

  test('required custom files cannot disappear or be silently dropped by the budget', async () => {
    const documents = { maxTotalChars: 10, enabledPresets: [], customPaths: ['required.md'] };
    await assert.rejects(resolveContextDocumentsBlock(documents, { readText: async () => null, listFiles: async () => [] }), /Required context document.*required\.md/);
    await assert.rejects(resolveContextDocumentsBlock(documents, { readText: async () => 'Required full instructions', listFiles: async () => [] }), /Required context documents exceed.*budget/);
  });
});
