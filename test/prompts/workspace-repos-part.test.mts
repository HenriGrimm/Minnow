/**
 * Repo map prompt part for multi-repo workspace folders.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { beforeEach, describe, test } from 'node:test';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import { registerPromptFilesFromRaw, resetPromptRegistry } from '../../src/chat/prompts/prompt-loader.ts';
import type { ComposeContext } from '../../src/chat/prompts/types.ts';
import { renderWorkspaceReposBlock } from '../../server/workspace/repos.js';
import { fixturePath } from './test-helpers.mjs';

const repo = (id: string, slug: string | null) => ({
  id, relPath: id, absPath: `/w/${id}`, isRoot: id === '.',
  remote: slug ? { url: '', host: 'github', hostname: 'github.com', slug, owner: slug.split('/')[0], name: slug.split('/')[1] } : null,
});

async function registerFixtures() {
  const map: Record<string, string> = {};
  for (const [folder, name] of [['base', 'base-default.full.md'], ['tool-usage', 'tool-usage-default.full.md']]) {
    map[`./${folder}/${name}`] = await fs.readFile(fixturePath(name), 'utf8');
  }
  registerPromptFilesFromRaw(map);
}

const baseContext: ComposeContext = {
  cwd: '/w', modeId: null, expertId: null, workAgentId: null, skillBody: null, memoryBlock: null,
  codeMapBlock: null, contextDocumentsBlock: null, enabledToolIds: ['git_status'], infoPresetId: null,
};

describe('workspace repos prompt part', () => {
  beforeEach(() => resetPromptRegistry());

  test('renders nothing for zero or one repo', () => {
    assert.equal(renderWorkspaceReposBlock([]), '');
    assert.equal(renderWorkspaceReposBlock([repo('.', 'acme/solo')]), '');
  });

  test('lists each repo with its remote', () => {
    const block = renderWorkspaceReposBlock([repo('backend', 'acme/api'), repo('frontend', null)]);
    assert.match(block, /`backend` — github\.com\/acme\/api/);
    assert.match(block, /`frontend` — no remote/);
    assert.match(block, /cd backend && gh pr create/);
  });

  test('the composed prompt includes the block only when given, and is otherwise unchanged', async () => {
    await registerFixtures();
    const plain = composeSystemPrompt(baseContext);
    const block = renderWorkspaceReposBlock([repo('backend', 'acme/api'), repo('frontend', 'acme/web')]);
    const multi = composeSystemPrompt({ ...baseContext, workspaceReposBlock: block });
    assert.equal(plain.includes('Workspace repositories'), false);
    assert.ok(multi.includes('`frontend` — github.com/acme/web'));
    assert.equal(composeSystemPrompt({ ...baseContext, workspaceReposBlock: '' }), plain);
    assert.equal(composeSystemPrompt({ ...baseContext, workspaceReposBlock: null }), plain);
  });

  test('the block is stable instructions, not per-turn CLI context', async () => {
    await registerFixtures();
    const block = renderWorkspaceReposBlock([repo('backend', 'acme/api'), repo('frontend', 'acme/web')]);
    const turn: string[] = [];
    const stable = composeSystemPrompt({ ...baseContext, workspaceReposBlock: block }, { turnContext: turn });
    assert.ok(stable.includes('Workspace repositories'));
    assert.equal(turn.join('').includes('Workspace repositories'), false);
  });
});
