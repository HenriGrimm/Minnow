import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import type { Chat } from '../../src/types.ts';
import type { GitOpResult } from '../../src/state/git-api.ts';

let active: Chat;
let utility: { modelId: string; providerId: string };
let recordedPaths: string[];
let stageResult: GitOpResult;
let diffResult: GitOpResult;
let commitResult: GitOpResult;
let streaming: boolean;
let beforeStage: () => Promise<void>;
let emit: (handlers: any) => void;
const calls: { op: string; input?: any }[] = [];
const requests: { providerId: string; body: any; options: any }[] = [];
const errors: string[] = [];
const snapshot = { headSha: 'a'.repeat(40), branch: 'refs/heads/feature', treeSha: 'b'.repeat(40) };

mock.module('../../src/ui/toast.ts', { namedExports: { showToast: (text: string) => calls.push({ op: 'toast', input: text }) } });
mock.module('../../src/ui/status.ts', { namedExports: { setStatus: (state: string, text: string) => { if (state === 'err') errors.push(text); } } });
mock.module('../../src/chat/streaming-state.ts', { namedExports: { isChatStreaming: () => streaming } });
mock.module('../../src/skills/parse-slash.ts', { namedExports: { formatHistoryWithSkillTag: (text: string) => text } });
mock.module('../../src/chat/build-api-messages.ts', { namedExports: { buildHistoryUserContent: (text: string) => text } });
mock.module('../../src/chat/run-turn-chat.ts', { namedExports: { runChatTurn: async () => { calls.push({ op: 'chat-turn' }); } } });
mock.module('../../src/state/sessions.ts', { namedExports: {
  getActiveChat: () => active, touchChat: (chat: Chat) => calls.push({ op: 'touch', input: chat.id }), saveSessionsNow: () => {},
} });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => '/workspace' } });
mock.module('../../src/state/git-workspace.ts', { namedExports: { isWorkspaceGitRepo: async () => true } });
mock.module('../../src/state/git-api.ts', { namedExports: {
  gitStage: async (input: any) => { calls.push({ op: 'stage', input }); await beforeStage(); return stageResult; },
  gitDiff: async (input: any) => { calls.push({ op: 'diff', input }); return diffResult; },
  gitCommit: async (input: any) => { calls.push({ op: 'commit', input }); return commitResult; },
} });
mock.module('../../src/models/selection.ts', { namedExports: {
  resolveEffectiveChatModelBinding: (chat: Chat) => ({ providerId: chat.providerId, modelId: chat.modelId }),
  readPersistedDefaultModelValue: () => '',
} });
mock.module('../../src/usage/code-change-ledger.ts', { namedExports: {
  getPerFileChangeSummary: () => recordedPaths.map(path => ({ path })), hasCodeChangeTotals: () => true,
} });
mock.module('../../src/ui/chat-turn-changes.ts', { namedExports: { findPrimaryTurnChangesCard: () => document.querySelector('section') } });
mock.module('../../src/ui/git-panel.ts', { namedExports: { refreshGitPanel: async () => { calls.push({ op: 'refresh-panel' }); } } });
mock.module('../../src/ui/sidebar-git-state.ts', { namedExports: { refreshSidebarGitFacts: () => { calls.push({ op: 'refresh-sidebar' }); } } });
mock.module('../../src/app-state.ts', { namedExports: { modelCache: new Map() } });
mock.module('../../src/config/editor-ai-completion.ts', { namedExports: {
  loadEditorAiCompletionConfig: async () => ({ enabled: false, useChatModel: true, temperature: 0.2, maxTokens: 1024 }),
} });
mock.module('../../src/config/git-commit-message-meta.ts', { namedExports: { loadGitCommitMessageConfig: async () => ({ useGitmoji: false }) } });
mock.module('../../src/config/utility-model-meta.ts', { namedExports: {
  loadUtilityModelConfig: async () => utility, utilityModelOverride: (config: typeof utility) => config.modelId ? config : null,
} });
mock.module('../../src/providers/store.ts', { namedExports: {
  resolveProvider: async (id = 'default-provider') => ({ id, apiKind: 'openai-v1', baseUrl: 'http://localhost:1234/v1' }),
} });
mock.module('../../src/models/library-request-binding.ts', { namedExports: {
  LIBRARY_MODEL_NOT_LOADED_MESSAGE: 'Library model is not loaded',
  resolveLibraryRequestBinding: async (providerId: string, modelId: string) => ({ kind: 'ready', providerId, modelId }),
} });
mock.module('../../src/models/model-select-library.ts', { namedExports: { LIBRARY_MODEL_PROVIDER_ID: 'minnow-library' } });
mock.module('../../src/providers/model-capabilities.ts', { namedExports: { catalogCapabilitiesFromRow: () => undefined } });
mock.module('../../src/api/chat.ts', { namedExports: { extractStreamDelta: () => '', extractMessageText: () => '' } });
mock.module('../../src/api/ensure-chat-model-loaded.ts', { namedExports: { ensureChatModelLoadedForTurn: async () => {} } });
mock.module('../../src/api/generations.ts', { namedExports: {
  createGeneration: async (providerId: string, body: any, options: any) => {
    requests.push({ providerId, body, options });
    return { generationId: 'utility-generation' };
  },
  subscribeToGeneration: (_id: string, handlers: any) => { queueMicrotask(() => emit(handlers)); return () => {}; },
  cancelGeneration: async () => {}, formatGenerationErrorMessage: (text: string) => text,
} });

const actions = await import('../../src/ui/code-change-strip-actions.ts');
let win: Window;
const chat = (id: string) => ({ id, history: [], modeId: 'build', providerId: `${id}-provider`, modelId: `${id}-model`, worktreeRoot: `/${id}-worktree`, codeChangeTotals: { additions: 1, deletions: 0 } }) as Chat;
const button = () => document.querySelector<HTMLButtonElement>('#btnCodeChangeCommit')!;
const settle = () => win.happyDOM.whenAsyncComplete();

beforeEach(async () => {
  win = new Window();
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  document.body.innerHTML = '<section><div id="codeChangeStripActions"><button id="btnCodeChangeCommit">Commit</button><button id="btnCodeChangeCreatePr">Create PR</button></div></section>';
  active = chat('source');
  utility = { providerId: 'utility-provider', modelId: 'utility-model' };
  recordedPaths = ['chat.txt'];
  stageResult = { ok: true, stagedPaths: recordedPaths };
  diffResult = { ok: true, patch: 'diff --git a/chat.txt b/chat.txt\n+staged change', files: [{ path: 'chat.txt', status: 'M' }, { path: 'already-staged.txt', status: 'A' }], commitSnapshot: snapshot };
  commitResult = { ok: true, sha: 'c'.repeat(40) };
  streaming = false;
  beforeStage = async () => {};
  emit = handlers => {
    handlers.onChunk({ choices: [{ delta: { content: 'fix(chat): commit staged changes' } }] });
    handlers.onEnd({ status: 'complete' });
  };
  calls.length = requests.length = errors.length = 0;
  actions.invalidateCodeChangeStripActionsGitCache();
  actions.initCodeChangeStripActions();
  await settle();
});

afterEach(async () => { await win.happyDOM.close(); });

test('Commit generates with the utility model and commits the staged index without a chat turn', async () => {
  const source = active;
  button().click();
  await settle();
  assert.equal(errors.length, 0);
  assert.deepEqual(calls.filter(call => ['stage', 'diff', 'commit'].includes(call.op)), [
    { op: 'stage', input: { paths: ['chat.txt'], cwd: '/source-worktree' } },
    { op: 'diff', input: { cached: true, forCommit: true, cwd: '/source-worktree' } },
    { op: 'commit', input: { cwd: '/source-worktree', message: 'fix(chat): commit staged changes', stagedOnly: true, expectedSnapshot: snapshot } },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].providerId, 'utility-provider');
  assert.equal(requests[0].body.model, 'utility-model');
  assert.deepEqual(requests[0].options, { persist: false, fallbackRole: 'utility' });
  assert.equal(requests[0].body.tools, undefined);
  assert.match(requests[0].body.messages[1].content, /staged changes only/);
  assert.match(requests[0].body.messages[1].content, /already-staged.txt/);
  assert.equal(calls.some(call => call.op === 'chat-turn'), false);
  assert.deepEqual(source.history, []);
  assert.equal(source.codeChangeShipHandled, true);
  assert.equal(button().hidden, true);
  assert.equal(calls.some(call => call.op === 'refresh-panel'), true);
  assert.equal(calls.some(call => call.op === 'refresh-sidebar'), true);
});

test('switching chats while staging preserves the originating worktree and fallback model', async () => {
  utility = { modelId: '', providerId: '' };
  const source = active;
  beforeStage = async () => { active = chat('other'); };
  button().click();
  await settle();
  assert.equal(requests[0].providerId, 'source-provider');
  assert.equal(requests[0].body.model, 'source-model');
  assert.equal(calls.find(call => call.op === 'commit')?.input.cwd, '/source-worktree');
  assert.equal(source.codeChangeShipHandled, true);
  assert.equal(active.codeChangeShipHandled, undefined);
  assert.equal(button().hidden, false);
});

test('repeated clicks and rerenders during generation only create one commit', async () => {
  let finish!: () => void;
  emit = handlers => {
    finish = () => {
      handlers.onChunk({ choices: [{ delta: { content: 'fix: staged changes' } }] });
      handlers.onEnd({ status: 'complete' });
    };
  };
  button().click();
  await settle();
  assert.match(button().textContent!, /Generating commit message/);
  actions.syncCodeChangeStripActionsVisibility();
  button().click();
  await settle();
  assert.equal(button().hidden, false);
  assert.equal(button().disabled, true);
  assert.equal(document.querySelector<HTMLElement>('#codeChangeStripActions')!.hidden, false);
  assert.equal(requests.length, 1);
  finish();
  await settle();
  assert.equal(calls.filter(call => call.op === 'commit').length, 1);
});

test('work started in the originating chat during generation remains available to commit', async () => {
  emit = handlers => {
    active.history.push({ role: 'user', content: 'Make another change' });
    handlers.onChunk({ choices: [{ delta: { content: 'fix: staged changes' } }] });
    handlers.onEnd({ status: 'complete' });
  };
  button().click();
  await settle();
  assert.equal(calls.filter(call => call.op === 'commit').length, 1);
  assert.equal(calls.some(call => call.op === 'chat-turn'), false);
  assert.equal(active.codeChangeShipHandled, undefined);
  assert.equal(button().hidden, false);
});

for (const failure of ['stage', 'empty stage', 'empty diff', 'old server', 'generation', 'empty message', 'analysis', 'truncated', 'commit']) {
  test(`${failure} failure keeps Commit retryable without adding a chat turn`, async () => {
    if (failure === 'stage') stageResult = { ok: false, error: 'Stage failed' };
    if (failure === 'empty stage') stageResult = { ok: true, stagedPaths: [] };
    if (failure === 'empty diff') diffResult = { ok: true, files: [], patch: '', commitSnapshot: snapshot };
    if (failure === 'old server') diffResult = { ok: true, patch: 'old response' };
    if (failure === 'generation') emit = handlers => handlers.onEnd({ status: 'error', errorMessage: 'Utility model unavailable' });
    if (failure === 'empty message') emit = handlers => handlers.onEnd({ status: 'complete' });
    if (failure === 'analysis') emit = handlers => {
      handlers.onChunk({ choices: [{ delta: { content: '1. **Identify Key Changes**\n- Updated the file' } }] });
      handlers.onEnd({ status: 'complete' });
    };
    if (failure === 'truncated') emit = handlers => {
      handlers.onChunk({ choices: [{ delta: { content: 'fix(chat): incomplete' }, finish_reason: 'length' }] });
      handlers.onEnd({ status: 'complete' });
    };
    if (failure === 'commit') commitResult = { ok: false, error: 'Hook failed' };
    button().click();
    await settle();
    assert.equal(errors.length, 1);
    assert.equal(active.codeChangeShipHandled, undefined);
    assert.equal(button().disabled, false);
    assert.equal(button().hidden, false);
    assert.equal(calls.some(call => call.op === 'chat-turn'), false);
    assert.equal(calls.filter(call => call.op === 'commit').length, failure === 'commit' ? 1 : 0);
  });
}

for (const modeId of ['plan', 'super-plan']) {
  test(`${modeId} prevents commit generation and git writes`, async () => {
    active.modeId = modeId;
    button().click();
    await settle();
    assert.match(errors[0], /Plan mode/);
    assert.equal(requests.length, 0);
    assert.equal(calls.some(call => ['stage', 'diff', 'commit', 'chat-turn'].includes(call.op)), false);
  });
}
