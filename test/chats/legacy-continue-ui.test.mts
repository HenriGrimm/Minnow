import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { continueLegacyAgentChat } from '../../src/chat/legacy-chat-continue.ts';
import { getAgentConversationsCapabilitySync, setAgentConversationsCapabilityForTests } from '../../src/config/agent-conversations-enabled.ts';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { adoptSubAgentRunForTests, resetSubAgentOrchestrator, setSubAgentApiFetchForTests, setSubAgentOpenStreamForTests } from '../../src/agents/orchestrator.ts';
import { openSubAgentDrawer, closeSubAgentDrawer } from '../../src/ui/sub-agent-drawer.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage });
globalThis.requestAnimationFrame = callback => { callback(0); return 0; };
const capability = (creationEnabled: boolean) => ({ version: 1, capability: 'agentConversationsV1', creationEnabled, recoveryEnabled: true, reason: creationEnabled ? 'development_opt_in' : 'not_released' });
function run(overrides: Partial<SubAgentRun> = {}): SubAgentRun {
  return { runId: 'legacy-run', type: 'explore', task: 'Original assignment', status: 'completed', summary: 'Original result', error: null, messages: [{ role: 'assistant', content: 'Saved response' }], toolTurns: 0,
    startedAt: '2026-10-30T10:00:00Z', endedAt: '2026-10-30T10:01:00Z', cancelled: false, parentChatId: 'parent', parentTurnId: 'old-turn', ...overrides };
}
function setup(enabled = true): void {
  document.body.innerHTML = '<div id="mainColumn"></div>'; sessionStorage.clear(); setAgentConversationsCapabilityForTests(capability(enabled));
  const parent = createEmptyChatObject('model'); parent.id = 'parent'; parent.subAgentRuns = []; parent.composerDraft = 'Keep draft';
  setSessionStateForTests({ ...defaultSessionState(), chats: [parent], activeId: parent.id });
  setSubAgentApiFetchForTests(async () => Response.json({ ok: true, events: [], state: { runs: [] } })); setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
}
const receipt = { childChatId: 'continued-chat', sourceParentChatId: 'parent', sourceRunId: 'legacy-run', revision: 3, link: '#/app/code/chat?chatId=continued-chat', context: { partial: true, source: 'saved_snapshot', capped: true, truncated: true }, replayed: false };
afterEach(() => { closeSubAgentDrawer(); resetSubAgentOrchestrator(); setSubAgentApiFetchForTests(null); setSubAgentOpenStreamForTests(null); setAgentConversationsCapabilityForTests(); resetSessionPersistenceForTests(); setSessionStateForTests(null); globalThis.fetch = originalFetch; document.body.replaceChildren(); });

test('legacy Continue retries a lost acknowledgement with protocol1 and one stable human intent; no history is supplied by the browser', async () => {
  setup(); const calls: any[] = [];
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers }); if (calls.length === 1) throw new TypeError('Lost receipt'); return Response.json({ receipt }); }) as typeof fetch;
  const saved = await continueLegacyAgentChat('parent', 'legacy-run'); assert.equal(saved.childChatId, 'continued-chat'); assert.equal(calls.length, 2);
  assert.equal(calls[0].body.clientRequestId, calls[1].body.clientRequestId); assert.deepEqual(Object.keys(calls[0].body), ['clientRequestId']);
  assert.equal(calls[0].headers['X-Minnow-Chat-Protocol'], '1'); assert.equal(calls[0].url, '/api/chats/parent/legacy/legacy-run/continue');
});

test('the historical drawer exposes explicit partial-context Continue only for a finished legacy run', async () => {
  setup(); globalThis.fetch = (async () => Response.json({ error: { message: 'Current model is unavailable' } }, { status: 409 })) as typeof fetch;
  adoptSubAgentRunForTests(run()); await openSubAgentDrawer('legacy-run', 'parent');
  const button = [...document.querySelectorAll<HTMLButtonElement>('.sub-agent-overlay__footer button')].find(node => node.textContent === 'Continue as chat')!;
  assert.ok(button); assert.match(document.querySelector('.sub-agent-overlay__footer')!.textContent!, /partial saved context/); button.click();
  for (let i = 0; i < 50 && !document.querySelector('.sub-agent-overlay__continuation-note')?.textContent?.includes('unavailable'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(document.querySelector('.sub-agent-overlay__continuation-note')!.textContent!, /Current model is unavailable/);
  assert.equal(document.querySelector('.sub-agent-overlay__prompt-text')!.textContent, 'Original assignment');
  assert.equal([...document.querySelectorAll<HTMLButtonElement>('.sub-agent-overlay__footer button')].find(node => node.textContent === 'Continue as chat')!.disabled, false);
});

test('disabled creation keeps the legacy reader and hides new continuation controls', async () => {
  setup(false); adoptSubAgentRunForTests(run()); await openSubAgentDrawer('legacy-run', 'parent');
  assert.equal(getAgentConversationsCapabilitySync()!.creationEnabled, false); assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === 'Continue as chat'), false);
  assert.match(document.querySelector('.sub-agent-overlay__body')!.textContent!, /Saved response/);
});

test('managed and native child tasks do not duplicate themselves in the legacy drawer switcher', async () => {
  setup(); adoptSubAgentRunForTests(run()); adoptSubAgentRunForTests(run({ runId: 'managed-run', childChatId: 'managed-child' }));
  await openSubAgentDrawer('legacy-run', 'parent'); assert.equal(document.querySelectorAll('.sub-agent-overlay__chip').length, 1);
});
