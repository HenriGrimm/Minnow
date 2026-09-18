/**
 * Browser allowlist prompt fragment and composer integration.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  loadPromptById,
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { loadBuiltinModePromptMap } from '../modes/test-helpers.mts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

async function loadBrowserAllowlistPromptMap() {
  const toolDir = path.join(REPO_ROOT, 'src/chat/prompts/tool-usage');
  const baseDir = path.join(REPO_ROOT, 'src/chat/prompts/base');
  const map = await loadBuiltinModePromptMap();
  map['./tool-usage/browser-allowlist.full.md'] = await fs.readFile(
    path.join(toolDir, 'browser-allowlist.md'),
    'utf8',
  );
  map['./tool-usage/browser-allowlist.lite.md'] = await fs.readFile(
    path.join(toolDir, 'browser-allowlist.lite.md'),
    'utf8',
  );
  map['./tool-usage/default.full.md'] = await fs.readFile(
    path.join(toolDir, 'default.full.md'),
    'utf8',
  );
  map['./base/default.full.md'] = await fs.readFile(
    path.join(baseDir, 'default.full.md'),
    'utf8',
  );
  map['./modes/build.full.md'] = map['./modes/build.full.md'] ?? (await fs.readFile(
    path.join(REPO_ROOT, 'src/chat/prompts/modes/build.full.md'),
    'utf8',
  ));
  return map;
}

describe('browser-allowlist prompts', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('fragment teaches ask_question with once persist deny', async () => {
    registerPromptFilesFromRaw(await loadBrowserAllowlistPromptMap());
    const loaded = loadPromptById('tool-usage', 'browser-allowlist', 'full');
    assert.ok(loaded?.body);
    assert.match(loaded.body, /ask_question/);
    assert.match(loaded.body, /"id": "once"/);
    assert.match(loaded.body, /"id": "persist"/);
    assert.match(loaded.body, /"id": "deny"/);
    assert.match(loaded.body, /request_browser_origin_access/);
  });

  test('composeSystemPrompt uses lite allowlist before first browser tool use', async () => {
    registerPromptFilesFromRaw(await loadBrowserAllowlistPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['browser_navigate', 'ask_question'],
      browserActivated: false,
    });
    assert.match(out, /\*\*Browser workflow:\*\*/);
    assert.doesNotMatch(out, /## Browser navigation allowlist/);
    assert.doesNotMatch(out, /"id": "browser_allow_origin"/);
  });

  test('composeSystemPrompt appends full allowlist after browser tool use', async () => {
    registerPromptFilesFromRaw(await loadBrowserAllowlistPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['browser_navigate', 'ask_question'],
      browserActivated: true,
    });
    assert.match(out, /## Browser navigation allowlist/);
    assert.match(out, /browser_allow_origin/);
  });

  test('composeSystemPrompt omits allowlist fragment without CDP tools', async () => {
    registerPromptFilesFromRaw(await loadBrowserAllowlistPromptMap());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file'],
    });
    assert.doesNotMatch(out, /## Browser navigation allowlist/);
    assert.doesNotMatch(out, /"id": "browser_allow_origin"/);
  });
});
