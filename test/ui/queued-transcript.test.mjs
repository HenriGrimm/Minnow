import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { appendChatTranscriptNode } = await import(
  '../../src/ui/chat-mount.ts'
);

describe('appendChatTranscriptNode', () => {
  test('appends normally when nothing is queued', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;

    const mount = document.createElement('div');
    const node = document.createElement('div');
    appendChatTranscriptNode(node, mount);
    assert.equal(mount.firstElementChild, node);
  });
});
