/**
 * Main-column overlay class cleanup and chat DOM suppression.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  isCodeStageOverlayMounted,
  isCodeStageViewHidingChatSidebar,
  isMainColumnOverlaySuppressingChatDom,
  stripMainColumnOverlayClasses,
} from '../../src/ui/main-column-overlay.ts';

let activeWindow: Window | undefined;

function setupDom(): void {
  activeWindow?.close();
  const window = new Window();
  activeWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;

  document.body.innerHTML = `
    <div id="mainColumn" class="main-column main-column--code-overview">
      <div class="chat-viewport">
        <main id="chatArea" class="chat-area chat-area--code-overview chat-area--code-brain-map"></main>
      </div>
    </div>
  `;
}

describe('main-column-overlay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    activeWindow?.close();
    activeWindow = undefined;
  });

  test('stripMainColumnOverlayClasses removes overlay modifiers from chat area and main column', () => {
    setupDom();
    stripMainColumnOverlayClasses();

    const area = document.getElementById('chatArea');
    const main = document.getElementById('mainColumn');
    assert.ok(area);
    assert.ok(main);
    assert.equal(area!.classList.contains('chat-area--code-overview'), false);
    assert.equal(area!.classList.contains('chat-area--code-brain-map'), false);
    assert.equal(main!.classList.contains('main-column--code-overview'), false);
  });

  test('isMainColumnOverlaySuppressingChatDom is true when overview root is mounted', () => {
    setupDom();
    stripMainColumnOverlayClasses();

    const root = document.createElement('div');
    root.id = 'codeOverviewRoot';
    document.getElementById('chatArea')!.appendChild(root);

    assert.equal(isMainColumnOverlaySuppressingChatDom(), true);
  });

  test('isMainColumnOverlaySuppressingChatDom is false after strip with no overlay roots', () => {
    setupDom();
    stripMainColumnOverlayClasses();
    assert.equal(isMainColumnOverlaySuppressingChatDom(), false);
  });

  test('isMainColumnOverlaySuppressingChatDom is true when dev server screen root is mounted', () => {
    setupDom();
    stripMainColumnOverlayClasses();
    const root = document.createElement('div');
    root.id = 'devServerScreenRoot';
    document.getElementById('chatArea')!.appendChild(root);
    assert.equal(isMainColumnOverlaySuppressingChatDom(), true);
  });

  test('isCodeStageOverlayMounted is true when overview root is mounted even without classes', () => {
    setupDom();
    stripMainColumnOverlayClasses();
    const root = document.createElement('div');
    root.id = 'codeOverviewRoot';
    document.getElementById('chatArea')!.appendChild(root);
    assert.equal(isCodeStageOverlayMounted(), true);
  });

  test('V2 Boards root hides the chat sidebar as a stage overlay', () => {
    setupDom();
    stripMainColumnOverlayClasses();
    const root = document.createElement('div');
    root.id = 'orchestratorBoardsRoot';
    document.getElementById('chatArea')!.appendChild(root);
    assert.equal(isCodeStageViewHidingChatSidebar(), true);
    assert.equal(isCodeStageOverlayMounted(), true);
  });

  test('orchestrate board page hides the chat sidebar without blocking kanban refresh', () => {
    setupDom();
    stripMainColumnOverlayClasses();
    const page = document.createElement('div');
    page.id = 'orchestrateBoardPage';
    document.getElementById('chatArea')!.appendChild(page);
    assert.equal(isCodeStageViewHidingChatSidebar(), true);
    // Board refresh keys off overlay roots, not the board page itself.
    assert.equal(isCodeStageOverlayMounted(), false);
  });

  test('stripMainColumnOverlayClasses removes chat-area--dev-server', () => {
    setupDom();
    const area = document.getElementById('chatArea')!;
    const main = document.getElementById('mainColumn')!;
    area.classList.add('chat-area--dev-server');
    main.classList.add('main-column--dev-server');
    stripMainColumnOverlayClasses();
    assert.equal(area.classList.contains('chat-area--dev-server'), false);
    assert.equal(main.classList.contains('main-column--dev-server'), false);
  });
});
