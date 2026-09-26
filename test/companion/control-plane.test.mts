import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { streamingChatIds } from '../../src/app-state.ts';
import {
  buildCompanionHostSnapshot,
  registerCompanionApproval,
  renderCompanionStateForTests,
  resetCompanionControlPlaneForTests,
} from '../../src/companion/control-plane.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('companion task control surface', () => {
  let win: import('happy-dom').Window;

  before(async () => {
    const { Window } = await import('happy-dom');
    win = new Window({ url: 'http://localhost/#/desktop' });
    installHappyDomGlobals(win);
  });

  after(async () => {
    resetCompanionControlPlaneForTests();
    streamingChatIds.clear();
    setSessionStateForTests(null);
    await teardownHappyDomAsync(win);
  });

  test('projects running, queued, approval, result, and file-change state', () => {
    (window as typeof window & { __MINNOW_SESSION_TOKEN__?: string }).__MINNOW_SESSION_TOKEN__ = 'host-token';
    const chat = createEmptyChatObject('Companion task', 'C:\\workspace');
    chat.id = 'chat-control';
    chat.name = 'Companion task';
    chat.history = [
      { role: 'user', content: 'Implement the companion' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'write-1',
          type: 'function',
          function: { name: 'save_file', arguments: '{"path":"src/companion.ts"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'write-1',
        content: 'Saved',
        codeChange: { additions: 8, deletions: 2, path: 'src/companion.ts', source: 'file-tool' },
      },
      { role: 'assistant', content: 'Implemented the phone control surface.' },
    ];
    chat.pendingMessageQueue = [{ id: 'queued-1', text: 'Run tests', createdAt: 1 }];
    setSessionStateForTests({ version: 6, activeId: chat.id, chats: [chat] });
    streamingChatIds.add(chat.id);
    const unregister = registerCompanionApproval({
      chatId: chat.id,
      toolName: 'save_file',
      title: 'Save file',
      argsJson: '{"path":"src/companion.ts"}',
    }, () => {});

    const snapshot = buildCompanionHostSnapshot();
    assert.equal(snapshot.tasks[0].status, 'needs-input');
    assert.equal(snapshot.tasks[0].queued, 1);
    assert.equal(snapshot.tasks[0].review?.outcome, 'Implemented the phone control surface.');
    assert.equal(snapshot.tasks[0].review?.files[0].path, 'src/companion.ts');
    assert.equal(snapshot.approvals[0].toolName, 'save_file');
    unregister();
  });

  test('renders narrow approval and steering controls without persistent approval', () => {
    document.documentElement.classList.add('minnow-companion');
    renderCompanionStateForTests({
      connected: true,
      publishedAt: Date.now(),
      approvals: [{
        id: 'approval-2',
        chatId: 'chat-2',
        taskTitle: 'Ship task',
        title: 'Run command',
        toolName: 'execute_command',
        description: 'Runs the focused tests',
        argsJson: '{"command":"npm test"}',
        workspaceLabel: 'Minnow',
        createdAt: Date.now(),
      }],
      tasks: [{
        id: 'chat-2',
        title: 'Ship task',
        status: 'running',
        queued: 1,
        updatedAt: Date.now(),
        review: {
          status: 'running',
          outcome: 'Working',
          summary: 'Ran 1 command',
          actions: 1,
          failedActions: 0,
          files: [],
        },
      }],
    });
    (document.getElementById('companionControlToggle') as HTMLButtonElement).click();
    const text = document.getElementById('companionControl')?.textContent ?? '';
    assert.match(text, /1 need input/);
    assert.match(text, /Allow Run command\?/);
    assert.match(text, /Allow once/);
    assert.doesNotMatch(text, /Always allow/);
    assert.match(text, /Steer now/);
    assert.match(text, /Queue next/);
    assert.ok(document.querySelector('.companion-control__message'));
  });
});
