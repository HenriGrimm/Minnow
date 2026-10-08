import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import type { ReefRun } from '../../src/reef/types.ts';

test('Reef renders shared Markdown, thinking and tool UI while preserving disclosures and Code state', async () => {
  const dom = new Window();
  globalThis.window = dom as unknown as Window & typeof globalThis;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement;
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = dom.localStorage;
  const { mountReefAgentStream } = await import('../../src/ui/reef-agent-stream.ts');
  const host = document.createElement('div'); document.body.append(host);
  const codeEmpty = document.createElement('div'); codeEmpty.id = 'emptyState'; document.body.append(codeEmpty);
  const view = mountReefAgentStream(host);
  const run: ReefRun = {
    id: 'run', prompt: 'Build', state: 'building', progress: 20, createdAt: Date.now(), log: '', attempt: 0, chatIds: ['planner', 'builder'],
    agentSessions: [
      { chatId: 'planner', phase: 'plan', state: 'complete', rounds: [{ id: 'plan:0', text: '**Plan:** implement a timer.', reasoning: 'Keep it simple.', tools: [], complete: true }] },
      { chatId: 'builder', phase: 'build', state: 'running', activity: 'thinking', rounds: [{ id: 'build:0', text: 'Writing `main.ts`.', reasoning: 'Consider keyboard access.', tools: [
        { id: 'one', name: 'read_file', args: { path: 'README.md' } },
        { id: 'two', name: 'save_file', args: { path: 'src/main.ts', content: 'const timer = 1;' } },
      ] }] },
    ],
  };
  try {
    view.update(run, true);
    assert.ok(codeEmpty.isConnected, 'standalone tool rows must not remove Code empty state');
    assert.equal(host.querySelector('strong')!.textContent, 'Plan:');
    assert.equal(host.querySelector('code')!.textContent, 'main.ts');
    assert.match(host.textContent!, /Planner · Complete/); assert.match(host.textContent!, /Builder · Working/);
    const builder = host.querySelector<HTMLElement>('[data-chat-id="builder"]')!;
    const thoughtButton = builder.querySelector<HTMLButtonElement>('.thoughts-toggle')!;
    thoughtButton.click(); thoughtButton.focus();
    const tool = builder.querySelector<HTMLElement>('[data-reef-tool-id="one"]')!;
    const details = tool.querySelector<HTMLDetailsElement>('details')!; details.open = true;
    run.agentSessions![1].rounds[0].reasoning += ' Support pause and reset.';
    view.update(run, true);
    assert.equal(builder.querySelector('.thoughts-toggle'), thoughtButton);
    assert.equal(document.activeElement, thoughtButton);
    assert.equal(thoughtButton.getAttribute('aria-expanded'), 'true');
    assert.match(builder.querySelector('.thoughts-content')!.textContent!, /Support pause and reset/);
    assert.equal(builder.querySelector('[data-reef-tool-id="one"]'), tool); assert.equal(details.open, true);
    run.agentSessions![1].rounds[0].tools[0].result = 'Read README';
    run.agentSessions![1].rounds[0].tools[1].result = 'Permission denied';
    run.agentSessions![1].rounds[0].tools[1].isError = true;
    run.agentSessions![1].state = 'failed'; run.agentSessions![1].error = 'context budget exceeded';
    view.update(run, false);
    assert.ok(tool.classList.contains('tool-call-msg--ok'));
    assert.ok(builder.querySelector('[data-reef-tool-id="two"]')!.classList.contains('tool-call-msg--fail'));
    assert.equal(builder.querySelector('.stream-status'), null);
    assert.equal(builder.querySelector('.tool-call-spinner'), null);
    assert.match(builder.textContent!, /context budget exceeded/);
    assert.equal(builder.querySelector('.thoughts-caret--pulse'), null);
    assert.equal(builder.querySelector<HTMLButtonElement>('button.tool-call-target')!.disabled, true);
    // Snapshot replay reconstructs the same reasoning and tool statuses after app navigation.
    view.dispose(); const replay = mountReefAgentStream(host); replay.update(structuredClone(run), false);
    assert.equal(host.querySelectorAll('.tool-call-msg').length, 2);
    assert.match(host.textContent!, /Planner · Complete/); assert.match(host.textContent!, /Builder · Stopped/);
    replay.dispose();
  } finally { view.dispose(); globalThis.localStorage = previousStorage; await dom.happyDOM.abort(); }
});
