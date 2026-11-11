/**
 * buildComposeContext cwd resolution — worktree-isolated board task chats.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { normalizeWorkspacePath } from '../../src/lib/normalize-workspace-path.ts';
import { buildComposeContext } from '../../src/chat/prompts/compose-context.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import { composeSystemPrompt } from '../../src/chat/prompts/prompt-composer.ts';
import {
  DEFAULT_PROMPT_META,
  resetPromptMetaCache,
  setPromptMetaCacheForTests,
} from '../../src/config/prompt-meta.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import type { Chat } from '../../src/types.ts';
import { resetConfigFileCacheForTests } from '../../src/config/config-file-cache.ts';
import { isLocalServerAvailable, setLocalServerAvailableForTests } from '../../src/tools/config.ts';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const PROMPTS_ROOT = path.join(REPO_ROOT, 'src', 'chat', 'prompts');

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const GROUP_ID = 'grp_11111111-1111-1111-1111-111111111111';
const TASK_ID = 'W1-FOUNDATION';
const MAIN_REPO = 'C:/Users/dukky/Documents/Development/GB Todo';
const WORKTREE_DIRECT = 'C:/Users/dukky/.minnow/worktrees/gb-todo/grp_932/task-W1-FOUNDATION';
const WORKTREE_FROM_TASK = 'C:/Users/dukky/.minnow/worktrees/gb-todo/grp_932/task-from-board';

function baseChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: CHAT_ID,
    name: 'Builder task',
    modelId: '',
    modeId: 'build',
    history: [],
    updatedAt: 1,
    memoryEnabled: false,
    workAgentId: 'builder',
    ...overrides,
  };
}

async function loadShippedPromptsRaw(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix = ''): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_example') continue;
        await walk(full, rel);
      } else if (entry.name.endsWith('.md')) {
        out[`./${rel.replace(/\\/g, '/')}`] = await fs.readFile(full, 'utf8');
      }
    }
  }
  await walk(PROMPTS_ROOT);
  return out;
}

describe('buildComposeContext cwd', () => {
  beforeEach(() => {
    resetPromptMetaCache();
    setPromptMetaCacheForTests({ ...DEFAULT_PROMPT_META });
    resetWorkspaceStateForTests();
    setWorkspaceFromServer({
      path: MAIN_REPO,
      label: 'GB Todo',
      isDefault: false,
    });
    setSessionStateForTests(null);
  });

  afterEach(() => {
    resetPromptMetaCache();
    resetWorkspaceStateForTests();
    setSessionStateForTests(null);
    resetConfigFileCacheForTests();
  });

  it('parallel optional lanes have a cold-setup deadline and discard late renderer results', async t => {
    const originalFetch = globalThis.fetch;
    const wasAvailable = isLocalServerAvailable();
    t.after(() => { globalThis.fetch = originalFetch; setLocalServerAvailableForTests(wasAvailable); });
    setLocalServerAvailableForTests(true);
    resetConfigFileCacheForTests();
    let releaseMemory!: (value: Response) => void;
    let releaseCode!: (value: Response) => void;
    const memoryWait = new Promise<Response>(resolve => { releaseMemory = resolve; });
    const codeWait = new Promise<Response>(resolve => { releaseCode = resolve; });
    const seen = new Set<string>();
    globalThis.fetch = async input => {
      const url = String(input); seen.add(url);
      if (url.includes('/api/config/file')) return Response.json({ features: { memoryInjection: true,
        codeMapInjectionDefault: true, contextDocumentsInjectionDefault: false } });
      if (url.includes('/api/memory/status')) return Response.json({ enabled: true });
      if (url.includes('/api/brain/retrieve')) return memoryWait;
      if (url.includes('/api/brain/code/config')) return codeWait;
      return Response.json({});
    };
    const ctx = await buildComposeContext(baseChat({ memoryEnabled: true }), { firstUserSend: true, enrichmentTimeoutMs: 30 });
    assert.ok([...seen].some(url => url.includes('/api/brain/retrieve')));
    assert.ok([...seen].some(url => url.includes('/api/brain/code/config')));
    assert.equal(ctx.memoryBlock, null);
    assert.equal(ctx.codeMapBlock, null);
    assert.match(ctx.enrichmentNotice!, /code-map \(deadline\).*memory \(deadline\)/);
    assert.equal(ctx.chatLinksBlock, null);
    releaseMemory(Response.json({ block: 'LATE OLD MEMORY' }));
    releaseCode(Response.json({ code: { enabled: true } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ctx.memoryBlock, null);
    assert.ok(![...seen].some(url => url.includes('/api/brain/code/repo-map') || url.includes('/api/brain/code/cascade')));
  });

  it('uses chat.worktreeRoot instead of the global workspace', async () => {
    const chat = baseChat({ worktreeRoot: WORKTREE_DIRECT });
    const ctx = await buildComposeContext(chat);
    assert.equal(ctx.cwd, WORKTREE_DIRECT);
    assert.notEqual(ctx.cwd, MAIN_REPO);
  });

  it('a board task chat with no worktreeRoot resolves to the workspace', async () => {
    setSessionStateForTests({
      version: 5,
      activeId: CHAT_ID,
      sidebarCollapsed: false,
      chats: [],
      groups: [
        {
          id: GROUP_ID,
          name: 'Board',
          workspacePath: MAIN_REPO,
          collapsed: false,
          order: 0,
          createdAt: 1,
          orchestrateBoard: {
            planPath: 'plan.md',
            maxConcurrentTasks: 3,
            tasks: [
              {
                id: TASK_ID,
                title: 'Foundation',
                wave: 'W1',
                category: 'build',
                status: 'in_progress',
                worktreePath: WORKTREE_FROM_TASK,
              },
            ],
            waves: [{ id: 'W1', status: 'in_progress' }],
            finalTest: { status: 'pending' },
          },
        },
      ],
    });
    const chat = baseChat({
      boardGroupId: GROUP_ID,
      boardTaskId: TASK_ID,
    });
    const ctx = await buildComposeContext(chat);
    // V1 looked up leftover board-task worktreePath. That engine is gone.
    assert.equal(ctx.cwd, MAIN_REPO);
    assert.notEqual(ctx.cwd, WORKTREE_FROM_TASK);
  });

  it('uses resolveComposeCwd for a plain chat without worktree isolation', async () => {
    const chat = baseChat();
    const ctx = await buildComposeContext(chat);
    assert.equal(ctx.cwd, MAIN_REPO);
  });

  it('passes the disabled Flaticon guidance preference into composition', async () => {
    setPromptMetaCacheForTests({
      ...DEFAULT_PROMPT_META,
      flaticonIconGuidanceEnabled: false,
    });
    const ctx = await buildComposeContext(baseChat());
    assert.equal(ctx.flaticonIconGuidanceEnabled, false);
  });

  it('uses Scratch workspace cwd for chats bound to ~/.minnow/workspace', async () => {
    const desktopWs = 'C:/Users/me/.minnow/workspace';
    const chat = baseChat({ modeId: 'desktop', workspacePath: desktopWs });
    const ctx = await buildComposeContext(chat);
    assert.equal(ctx.cwd, normalizeWorkspacePath(desktopWs));
    assert.notEqual(ctx.cwd, MAIN_REPO);
  });

  it('sets browserActivated from chat history browser tool calls', async () => {
    const fresh = await buildComposeContext(baseChat());
    assert.equal(fresh.browserActivated, false);

    const activated = await buildComposeContext(
      baseChat({
        history: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'browser_snapshot', arguments: '{}' },
              },
            ],
          },
        ],
      }),
    );
    assert.equal(activated.browserActivated, true);
  });

  it('omits save_memory from enabledToolIds on board task chats', async () => {
    const plannerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    setSessionStateForTests({
      version: 5,
      activeId: plannerId,
      sidebarCollapsed: false,
      chats: [
        {
          id: plannerId,
          name: 'Planner',
          modelId: '',
          modeId: 'orchestrate',
          history: [],
          updatedAt: 1,
          boardGroupId: GROUP_ID,
        },
        baseChat({
          boardGroupId: GROUP_ID,
          boardTaskId: TASK_ID,
        }),
      ],
      groups: [
        {
          id: GROUP_ID,
          name: 'Board',
          workspacePath: MAIN_REPO,
          collapsed: false,
          order: 0,
          createdAt: 1,
          plannerChatId: plannerId,
          orchestrateBoard: {
            planPath: 'plan.md',
            maxConcurrentTasks: 3,
            tasks: [
              {
                id: TASK_ID,
                title: 'Foundation',
                wave: 'W1',
                category: 'build',
                status: 'in_progress',
                chatId: CHAT_ID,
              },
            ],
            waves: [{ id: 'W1', status: 'in_progress' }],
            finalTest: { status: 'pending' },
          },
        },
      ],
    });
    const chat = baseChat({
      boardGroupId: GROUP_ID,
      boardTaskId: TASK_ID,
    });
    const ctx = await buildComposeContext(chat);
    assert.ok(!ctx.enabledToolIds.includes('save_memory'));
  });
});

describe('builder prompt cwd rendering', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    registerPromptFilesFromRaw(await loadShippedPromptsRaw());
  });

  it('shows worktree path and relative-cd rule in composed builder prompt', () => {
    const prompt = composeSystemPrompt({
      cwd: WORKTREE_DIRECT,
      modeId: 'build',
      orchestratePlanPath: null,
      expertId: null,
      workAgentId: 'builder',
      workAgentLabel: 'Builder',
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['execute_command', 'save_file'],
      infoPresetId: 'general-assistant',
      planGranularity: 'medium',
      userMessagePreview: 'Scaffold frontend',
    });

    assert.match(prompt, /Working directory: `C:\/Users\/dukky\/\.minnow\/worktrees\/gb-todo\/grp_932\/task-W1-FOUNDATION`/);
    assert.match(prompt, /In an isolated task worktree, do not escape to an absolute project path/);
    assert.doesNotMatch(prompt, /GB Todo/);
  });
});
