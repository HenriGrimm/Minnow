import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const CHAT_APP_IDS = [
  'chatView',
  'btnChatAppNewChat',
  'btnChatAppRailToggle',
  'chatAppSessionList',
  'chatAppTitle',
  'chatAppArea',
  'chatAppMessageCol',
  'chatAppJumpLatest',
  'chatAppToolApprovalHost',
  'chatAppQuestionHost',
  'chatAppAttachPreview',
  'btnChatAppAttach',
  'chatAppInput',
  'btnChatAppStop',
  'chatAppSendBtn',
  'chatAppContextUsageRing',
  'chatAppContextUsageBreakdown',
  'chatAppFiles',
  'btnChatAppOutputsToggle',
  'chatAppFilesBody',
];

describe('chat app HTML', () => {
  for (const id of CHAT_APP_IDS) {
    test(`#${id} exists in index.html`, () => {
      assert.match(html, new RegExp(`id="${id}"`));
    });
  }

  test('chat view uses chat-app-page shell class', () => {
    assert.match(html, /id="chatView"[^>]*class="[^"]*chat-app-page/);
  });

  test('composer textarea has Message Minnow placeholder', () => {
    assert.match(html, /id="chatAppInput"[^>]*placeholder="Message Minnow…"/);
  });

  test('outputs panel has empty-state copy', () => {
    assert.match(html, /class="chat-app-outputs-empty"[^>]*>Files the assistant creates will appear here\./);
  });

  test('chat view is before appBody', () => {
    const chat = html.indexOf('id="chatView"');
    const app = html.indexOf('id="appBody"');
    assert.ok(chat > 0 && app > chat);
  });

  test('the retired research view is gone from the shell', () => {
    assert.equal(html.indexOf('id="researchView"'), -1);
  });
});
