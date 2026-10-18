import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { createTurnChanges } from '../../src/ui/chat-turn-changes.ts';
import { setSharedChatHost } from '../../src/ui/shared-chat-host-state.ts';

const viewerPaths: string[] = [];
mock.module('../../src/ui/file-viewer.ts', { namedExports: { openFileInViewer: async (path: string) => { viewerPaths.push(path); } } });

test('Open plan in an issue conversation opens its details preview; ordinary Code cards retain the viewer', async () => {
  const win = new Window();
  installHappyDomGlobals(win, { fetch: (async () => new Response('---\nplanType: build\n---\n# Build')) as typeof fetch });
  const chat = seedMinimalSession('planner'); chat.modeId = 'plan';
  const path = 'documentation/plans/clicked-plan.md';
  chat.history = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'save', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: 'save', content: `Saved ${path}`, codeChange: { path, additions: 10, deletions: 0, diffLines: [] } },
  ];
  const shell = document.createElement('section');
  const transcript = document.createElement('div'); shell.append(transcript); document.body.append(shell);
  const opened: string[] = [];
  setSharedChatHost({ chatId: chat.id, shell, transcript, openPlan: path => opened.push(path) });
  const card = createTurnChanges(chat, 0, 1)!; transcript.append(card);
  const open = [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open plan')!;
  try {
    open.click();
    assert.deepEqual(opened, [path]);
    assert.deepEqual(viewerPaths, []);
    const codeCard = createTurnChanges(chat, 0, 1)!; document.body.append(codeCard);
    [...codeCard.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open plan')!.click();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(opened, [path], 'the details route only handles cards in its own transcript');
    assert.deepEqual(viewerPaths, [path]);
    setSharedChatHost(null);
    open.click(); await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(viewerPaths, [path, path]);
  } finally { setSharedChatHost(null); await teardownHappyDomAsync(win); }
});
