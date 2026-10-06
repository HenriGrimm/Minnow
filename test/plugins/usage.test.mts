import assert from 'node:assert/strict';
import { mock, after, test } from 'node:test';
import type { Chat } from '../../src/types.ts';

const makeChat = (id: string, workspacePath: string) => ({ id, workspacePath, history: [], lastStats: null } as Chat);
const a = makeChat('a', 'C:/repo');
const b = makeChat('b', 'C:/repo');
const other = makeChat('other', 'C:/other');
const state = { activeId: 'a', chats: [a, b, other] };
let workspace = 'C:/repo';
mock.module('../../src/state/sessions.ts', { namedExports: { sessionState: state } });
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => workspace } });
mock.module('../../src/state/view-workspace.ts', { namedExports: { getViewWorkspacePath: () => '' } });
const { getPluginChatUsage, getPluginWorkspaceUsage, subscribePluginChatUsage, subscribePluginWorkspaceUsage } = await import('../../src/plugins/usage.ts');
const { recordTokenUsage, resetTokenLedger } = await import('../../src/usage/token-ledger.ts');
const { notifyPluginContextChanged } = await import('../../src/plugins/events.ts');
const { streamingChatIds } = await import('../../src/app-state.ts');
after(() => { mock.restoreAll(); });
const record = (chat: Chat, total: number) => recordTokenUsage(chat, {
  source: { kind: 'main', modeId: 'build' }, providerId: 'local', modelId: 'model',
  usage: { prompt_tokens: total - 1, completion_tokens: 1 }, costUsd: 0,
  stats: { tokens_per_second: 20 },
});
const flush = () => new Promise(resolve => queueMicrotask(resolve));

test('usage snapshots preserve cumulative totals across capped history and are detached from chat state', () => {
  for (let i = 0; i < 205; i++) record(a, 10);
  assert.equal(a.tokenLedger!.entries.length, 200);
  const snapshot = getPluginChatUsage()!;
  assert.equal(snapshot.totals.totalTokens, 2050);
  assert.equal(snapshot.latest!.stats.tokens_per_second, 20);
  snapshot.totals.totalTokens = 999;
  snapshot.latest!.usage.completion_tokens = 99;
  assert.equal(a.tokenLedger!.totals.totalTokens, 2050);
  assert.equal(a.tokenLedger!.entries.at(-1)!.usage.completion_tokens, 1);
  assert.equal(getPluginChatUsage('other'), null);
  assert.equal(getPluginChatUsage('missing'), null);
});

test('usage subscriptions follow completion, reset, active chat, live stats and workspace switches without double-counting', async () => {
  const chatValues: (number | null)[] = [];
  const workspaceValues: number[] = [];
  const unsubscribe = subscribePluginChatUsage(value => { chatValues.push(value?.totals.totalTokens ?? null); });
  const unsubscribeWorkspace = subscribePluginWorkspaceUsage(value => { workspaceValues.push(value.totals.totalTokens); });
  assert.deepEqual(chatValues, [2050]);
  record(a, 20); record(a, 30);
  await flush();
  assert.deepEqual(chatValues, [2050, 2100]);
  record(b, 40); record(other, 900);
  await flush();
  assert.equal(getPluginWorkspaceUsage().totals.totalTokens, 2140);
  assert.equal(chatValues.length, 2);
  assert.equal(workspaceValues.at(-1), 2140);
  a.lastStats = { tokens_per_second: 50 } as Chat['lastStats'];
  streamingChatIds.add(a.id);
  notifyPluginContextChanged();
  await flush();
  assert.equal(getPluginChatUsage()!.current!.tokens_per_second, 50);
  assert.equal(getPluginChatUsage()!.streaming, true);
  assert.equal(getPluginChatUsage()!.totals.totalTokens, 2100);
  state.activeId = 'b'; notifyPluginContextChanged(); await flush();
  assert.equal(chatValues.at(-1), 40);
  resetTokenLedger(b); await flush();
  assert.equal(chatValues.at(-1), 0);
  workspace = 'C:/other'; notifyPluginContextChanged(); await flush();
  assert.equal(chatValues.at(-1), null);
  assert.equal(workspaceValues.at(-1), 900);
  unsubscribe(); unsubscribeWorkspace();
  const count = chatValues.length;
  record(other, 10); notifyPluginContextChanged(); await flush();
  assert.equal(chatValues.length, count);
  streamingChatIds.clear();
});
