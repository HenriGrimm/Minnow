import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeExternalEditDraft } from '../../src/ui/file-viewer-external-conflict.ts';
import { viewerDocumentRevision } from '../../src/ui/file-viewer-revision.ts';

test('merge draft keeps both changed versions for manual reconciliation', () => {
  const merged = mergeExternalEditDraft('base\n', 'local\n', 'external\n');
  assert.match(merged, /<<<<<<< Your draft\nlocal/);
  assert.match(merged, /\|\|\|\|\|\|\| Loaded version\nbase/);
  assert.match(merged, /=======\nexternal/);
  assert.equal(mergeExternalEditDraft('base', 'base', 'external'), 'external');
  assert.equal(mergeExternalEditDraft('base', 'local', 'base'), 'local');
});

test('loaded revision ignores only editor line-ending normalization', async () => {
  assert.equal(await viewerDocumentRevision('one\r\ntwo\r\n'),
    await viewerDocumentRevision('one\ntwo\n'));
  assert.notEqual(await viewerDocumentRevision('one\ntwo\n'),
    await viewerDocumentRevision('one\nother\n'));
});
