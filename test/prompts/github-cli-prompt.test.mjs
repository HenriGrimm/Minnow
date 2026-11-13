/**
 * GitHub CLI (gh) prompt fragment and composer integration (MIN-558).
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

async function loadGithubCliPromptMap() {
  const toolDir = path.join(REPO_ROOT, 'src/chat/prompts/tool-usage');
  const baseDir = path.join(REPO_ROOT, 'src/chat/prompts/base');
  const map = await loadBuiltinModePromptMap();
  map['./tool-usage/github-cli.full.md'] = await fs.readFile(
    path.join(toolDir, 'github-cli.md'),
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
  return map;
}

describe('github-cli prompts', () => {
  beforeEach(() => {
    resetPromptRegistry();
  });

  test('github-cli fragment loads with gh guidance', async () => {
    registerPromptFilesFromRaw(await loadGithubCliPromptMap());
    const loaded = loadPromptById('tool-usage', 'github-cli');
    assert.ok(loaded?.body);
    assert.match(loaded.body, /`gh pr list`/);
    assert.match(loaded.body, /Do \*\*not\*\* open github\.com/);
    assert.match(loaded.body, /gh auth login/);
  });

  test('composeSystemPrompt appends github-cli when execute_command is enabled', async () => {
    registerPromptFilesFromRaw(await loadGithubCliPromptMap());
    const out = composeSystemPrompt({
        cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['execute_command', 'read_file'],
    });
    assert.match(out, /GitHub — use `gh`/);
    assert.match(out, /gh pr create/);
  });

  test('composeSystemPrompt omits github-cli without execute_command', async () => {
    registerPromptFilesFromRaw(await loadGithubCliPromptMap());
    const out = composeSystemPrompt({
        cwd: '/proj',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file'],
    });
    assert.doesNotMatch(out, /GitHub — use `gh`/);
  });
});
