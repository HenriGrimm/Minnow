import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { captureEditorFocusRequest } from '../../src/ui/editor-focus-request.ts';

test('explicit editor open keeps focus intent until the user focuses another surface', async () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<button>Open file</button><textarea></textarea>';
  const button = doc.querySelector('button')!;
  button.focus();
  const ownsFocus = captureEditorFocusRequest(doc);
  await Promise.resolve();
  assert.equal(ownsFocus(), true);
  doc.querySelector('textarea')!.focus();
  assert.equal(ownsFocus(), false);
  button.focus();
  assert.equal(ownsFocus(), false, 'returning to the old control does not revive stale intent');
  await win.happyDOM.abort();
});

test('replacing a focused editor permits restoring focus, unless the composer took focus meanwhile', async () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<textarea id="editor"></textarea><textarea id="composer"></textarea>';
  const editor = doc.getElementById('editor') as HTMLTextAreaElement;
  editor.focus();
  const ownsFocus = captureEditorFocusRequest(doc);
  editor.remove();
  assert.equal(ownsFocus(), true);
  (doc.getElementById('composer') as HTMLTextAreaElement).focus();
  assert.equal(ownsFocus(), false);
  await win.happyDOM.abort();
});
