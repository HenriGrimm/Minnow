import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageEditDraft } from '../../src/chat/message-edit-draft.ts';
import { buildHistoryUserContent } from '../../src/chat/build-api-messages.ts';
import { parseHistoryUserContent } from '../../src/chat/user-message-parts.ts';

test('editing an attached file restores only the prompt and preserves the file snapshot on resend', () => {
  const body = '1: # Design\n2: café\n3: Keep the composer compact.';
  const original = `read this\n\n<file name="DESIGN.md">\n${body}\n</file>`;
  const draft = messageEditDraft(original);
  assert.equal(draft.text, 'read this');
  assert.equal(draft.attachments.length, 1);
  assert.equal(draft.attachments[0].name, 'DESIGN.md');
  assert.equal(draft.attachments[0].text, body);
  assert.equal(draft.attachments[0].size, new TextEncoder().encode(body).length);

  const resent = parseHistoryUserContent(buildHistoryUserContent('summarize this', draft.attachments));
  assert.equal(resent.text, 'summarize this');
  assert.deepEqual(resent.files, [{ name: 'DESIGN.md', body }]);
});

test('removing one restored file excludes its contents from the edited send', () => {
  const draft = messageEditDraft('Compare\n\n<file name="a.txt">\nfirst\n</file>\n\n<file name="b.pdf">\nsecond\n</file>');
  assert.equal(draft.text, 'Compare');
  assert.notEqual(draft.attachments[0].id, draft.attachments[1].id);
  assert.equal(draft.attachments[1].kind, 'pdf');
  const kept = draft.attachments.filter((attachment) => attachment.name !== 'a.txt');
  const resent = parseHistoryUserContent(buildHistoryUserContent(draft.text, kept));
  assert.deepEqual(resent.files, [{ name: 'b.pdf', body: 'second' }]);
});

test('attachment-only edits can resend without adding prompt text', () => {
  const original = '<file name="notes.txt">\nnotes\n</file>';
  const draft = messageEditDraft(original);
  assert.equal(draft.text, '');
  assert.equal(buildHistoryUserContent(draft.text, draft.attachments), original);
});

test('file edits retain slash skills and existing non-file context', () => {
  const draft = messageEditDraft('review\n\n<file name="a.txt">\n[skill: unrelated]\n</file>\n\n[image: screenshot.png]\n\n[skill: code-review]');
  assert.equal(draft.text.trim(), '/code-review review\n\n[image: screenshot.png]');
  assert.equal(draft.attachments[0].text, '[skill: unrelated]');
  assert.deepEqual(messageEditDraft('Hello'), { text: 'Hello', attachments: [] });
});
