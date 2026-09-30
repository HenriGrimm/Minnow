/**
 * Composer pending-attachment lifecycle (MIN-650).
 *
 * The composer strip is emptied when a turn takes ownership of the files; a failed or
 * stopped turn hands them back. These cover the handing-back half, which has to survive
 * the user queueing more files while the turn was still running.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  addAttachments,
  clearAttachments,
  getPendingAttachments,
  pushAttachment,
  restorePendingAttachments,
} from '../../src/attachments/store.ts';
import type { Attachment } from '../../src/attachments/types.ts';

function textAttachment(id: string): Attachment {
  return {
    id,
    name: `${id}.txt`,
    kind: 'text',
    mimeType: 'text/plain',
    size: 12,
    text: 'hello world!',
  };
}

describe('restorePendingAttachments', () => {
  let previousWindow: unknown;
  let previousFileReader: unknown;

  beforeEach(() => {
    previousWindow = globalThis.window;
    previousFileReader = globalThis.FileReader;
    const win = new Window();
    globalThis.window = win as unknown as Window & typeof globalThis.window;
    globalThis.document = win.document as unknown as Document;
    globalThis.FileReader = win.FileReader;
    clearAttachments();
  });

  afterEach(() => {
    clearAttachments();
    globalThis.window = previousWindow as typeof globalThis.window;
    globalThis.FileReader = previousFileReader as typeof globalThis.FileReader;
  });

  test('puts a failed turn\'s attachments back in an empty composer', () => {
    const sent = [textAttachment('a'), textAttachment('b')];
    restorePendingAttachments(sent);
    assert.deepEqual(
      getPendingAttachments().map((a) => a.id),
      ['a', 'b'],
    );
  });

  test('keeps attachments queued while the turn was running', () => {
    const sent = [textAttachment('a')];
    pushAttachment(textAttachment('queued-during-turn'));

    restorePendingAttachments(sent);

    // Restored files lead — they belong to the message the user is about to retry.
    assert.deepEqual(
      getPendingAttachments().map((a) => a.id),
      ['a', 'queued-during-turn'],
    );
  });

  test('does not duplicate an attachment that is already pending', () => {
    const shared = textAttachment('a');
    pushAttachment(shared);

    restorePendingAttachments([shared]);

    assert.deepEqual(
      getPendingAttachments().map((a) => a.id),
      ['a'],
    );
  });

  test('an empty snapshot leaves the composer alone', () => {
    pushAttachment(textAttachment('a'));
    restorePendingAttachments([]);
    assert.equal(getPendingAttachments().length, 1);
  });

  test('a file read started before navigation cannot refill the next composer', async () => {
    const file = new window.File(['before switch'], 'old.txt', { type: 'text/plain' });
    const adding = addAttachments([file]);
    clearAttachments();

    await adding;

    assert.deepEqual(getPendingAttachments(), []);
  });
});
