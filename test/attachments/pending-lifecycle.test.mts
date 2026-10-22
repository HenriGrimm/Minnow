/** Composer attachment reads and queue lifecycle. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  addAttachments,
  clearAttachments,
  getPendingAttachments,
  MAX_PENDING_FILE_BYTES,
  MAX_PENDING_FILE_COUNT,
  pushAttachment,
  removeAttachment,
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

describe('pending attachment lifecycle', () => {
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

  test('a file read started before navigation cannot refill the next composer', async () => {
    const file = new window.File(['before switch'], 'old.txt', { type: 'text/plain' });
    const adding = addAttachments([file]);
    clearAttachments();

    await adding;

    assert.deepEqual(getPendingAttachments(), []);
  });
});

describe('pending file reads and aggregate limits', () => {
  let originalDocument: Document;
  let originalFileReader: typeof FileReader;
  const readers: ControlledReader[] = [];

  class ControlledReader {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;
    readAsText(): void { readers.push(this); }
    readAsDataURL(): void { readers.push(this); }
    abort(): void { this.aborted = true; this.onabort?.(); }
    finish(): void { this.result = 'file contents'; this.onload?.(); }
  }

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalFileReader = globalThis.FileReader;
    globalThis.document = new Window().document as unknown as Document;
    globalThis.FileReader = ControlledReader as unknown as typeof FileReader;
    readers.length = 0;
    clearAttachments();
  });

  afterEach(() => {
    clearAttachments();
    globalThis.document = originalDocument;
    globalThis.FileReader = originalFileReader;
  });

  function file(name: string, size = 10): File {
    return { name, size, type: 'text/plain' } as File;
  }

  test('removing a reading chip aborts extraction and late completion cannot restore it', async () => {
    const adding = addAttachments([file('draft.txt')]);
    const pending = getPendingAttachments()[0];
    assert.equal(pending.pendingRead, true);
    assert.equal(readers.length, 1);
    removeAttachment(pending.id);
    assert.equal(readers[0].aborted, true);
    readers[0].finish();
    await adding;
    assert.deepEqual(getPendingAttachments(), []);
  });

  test('clearing the draft aborts every read and a new draft stays empty', async () => {
    const adding = addAttachments([file('a.txt'), file('b.txt')]);
    clearAttachments();
    assert.equal(readers.every((reader) => reader.aborted), true);
    readers.forEach((reader) => reader.finish());
    await adding;
    assert.deepEqual(getPendingAttachments(), []);
  });

  test('a completed read replaces its reservation and keeps the same removable id', async () => {
    const adding = addAttachments([file('ready.txt')]);
    const id = getPendingAttachments()[0].id;
    readers[0].finish();
    await adding;
    assert.equal(getPendingAttachments()[0].id, id);
    assert.equal(getPendingAttachments()[0].kind, 'text');
    assert.equal(getPendingAttachments()[0].pendingRead, undefined);
    removeAttachment(id);
    assert.deepEqual(getPendingAttachments(), []);
  });

  test('limits count and combined bytes before starting extraction', async () => {
    const countFiles = Array.from({ length: MAX_PENDING_FILE_COUNT + 1 }, (_, index) => file(`${index}.txt`));
    const addingCount = addAttachments(countFiles);
    assert.equal(readers.length, MAX_PENDING_FILE_COUNT);
    assert.match(getPendingAttachments().find((item) => item.id === 'attachment-limit')?.error ?? '', /At most 10 files/);
    removeAttachment(getPendingAttachments()[0].id);
    assert.equal(getPendingAttachments().some((item) => item.id === 'attachment-limit'), false);
    clearAttachments();
    await addingCount;

    const tenMb = 10 * 1024 * 1024;
    const addingBytes = addAttachments([file('one.txt', tenMb), file('two.txt', tenMb), file('three.txt', MAX_PENDING_FILE_BYTES - 2 * tenMb + 1)]);
    assert.equal(readers.length, MAX_PENDING_FILE_COUNT + 2);
    assert.match(getPendingAttachments().find((item) => item.id === 'attachment-limit')?.error ?? '', /25MB/);
    clearAttachments();
    await addingBytes;
  });
});
