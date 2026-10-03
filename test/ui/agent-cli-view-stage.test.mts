import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initAgentCliView, syncAgentCliView, cliSessionStatus, cliUsageStatus } from '../../src/ui/agent-cli-view.ts';
import { notifyCodeStageViewChanged } from '../../src/ui/main-column-overlay.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

test('CLI status distinguishes request completion, restart recovery and unavailable usage', () => {
  const capture = { providerId: 'claude-code-cli', modelId: 'fixture', output: '', status: 'running' as const, version: 1,
    session: { sessionState: 'idle' as const, continuation: 'resumed' as const, usage: { prompt_tokens: 11,
      completion_tokens: 3, prompt_tokens_details: { uncached_tokens: 2, cached_tokens: 8, cache_creation_tokens: 1 } } } };
  assert.match(cliSessionStatus(capture), /Ready for next message.*Resumed saved conversation/);
  assert.match(cliUsageStatus(capture), /uncached 2, cache read 8, cache write 1, output 3.*cost unavailable/);
  assert.match(cliUsageStatus({ ...capture, session: undefined }), /input unavailable.*output unavailable/);
  assert.match(cliSessionStatus({ ...capture, session: { sessionState: 'active', continuation: 'rebuilt', reason: 'Instructions changed.' } }), /Conversation rebuilt.*Instructions changed/);
});

test('CLI view clears when Dev Servers owns the Code stage and returns with chat', async () => {
  const previousFetch = globalThis.fetch;
  const NativeResponse = Response;
  let outputController: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new NativeResponse(new ReadableStream<Uint8Array>({
    start(controller) { outputController = controller; },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  const { Window } = await import('happy-dom');
  const win = new Window();
  installHappyDomGlobals(win);
  try {
    win.document.body.innerHTML = `
      <div id="mainColumn"><div class="chat-viewport"><main id="chatArea"></main></div></div>
    `;
    const chat = createEmptyChatObject('', 'C:\\workspace\\demo');
    chat.providerId = 'codex-cli';
    chat.modelId = 'gpt-5.5';
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [chat],
    });

    initAgentCliView();
    const button = win.document.querySelector<HTMLButtonElement>('.agent-cli-view-toggle');
    const pane = win.document.querySelector<HTMLElement>('.agent-cli-view');
    const transcript = win.document.getElementById('chatArea');
    assert.ok(button);
    assert.ok(pane);
    assert.ok(transcript);
    assert.equal(button.hidden, false);

    button.click();
    assert.equal(pane.hidden, false);
    assert.equal(transcript.hidden, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    outputController!.enqueue(encoder.encode(`data: ${JSON.stringify({ snapshot: {
      providerId: 'codex-cli', modelId: 'gpt-5.5', output: 'First\n', status: 'running', version: 1,
    } })}\n\n`));
    await new Promise(resolve => setTimeout(resolve, 0));
    const output = win.document.querySelector<HTMLElement>('.agent-cli-view__output')!;
    assert.equal(output.textContent, 'First\n');
    const firstNode = output.firstChild;
    outputController!.enqueue(encoder.encode(`data: ${JSON.stringify({ providerId: 'codex-cli',
      modelId: 'gpt-5.5', status: 'running', version: 2, delta: 'Second\n' })}\n\n`));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(output.textContent, 'First\nSecond\n');
    assert.equal(output.firstChild, firstNode, 'Streaming appends rather than replacing the whole log');

    transcript.classList.add('chat-area--dev-server');
    transcript.innerHTML = '<div id="devServerScreenRoot"></div>';
    syncAgentCliView();
    assert.equal(button.hidden, true);
    assert.equal(pane.hidden, true);
    assert.equal(transcript.hidden, false);

    transcript.classList.remove('chat-area--dev-server');
    transcript.replaceChildren();
    notifyCodeStageViewChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(button.hidden, false);
    assert.equal(pane.hidden, true);
    assert.equal(button.textContent, 'CLI');
  } finally {
    globalThis.fetch = previousFetch;
    setSessionStateForTests(null);
    await teardownHappyDomAsync(win);
  }
});
