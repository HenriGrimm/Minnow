import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';

function revision(text) {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

test('conditional editor save rejects external edits and preserves their bytes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-editor-revision-'));
  const file = path.join(workspaceRoot, 'draft.txt');
  try {
    await fs.writeFile(file, 'one\r\ntwo\r\n');
    const expected_revision = revision('one\ntwo\n');
    await fs.writeFile(file, 'agent edit\r\n');
    const stale = await executeServerTool('save_file', {
      path: 'draft.txt', content: 'my edit\n', expected_revision,
    }, { workspaceRoot });
    assert.match(String(stale.result ?? stale), /FILE_VERSION_CONFLICT/);
    assert.equal(await fs.readFile(file, 'utf8'), 'agent edit\r\n');

    const saved = await executeServerTool('save_file', {
      path: 'draft.txt', content: 'my edit\n', expected_revision: revision('agent edit\n'),
    }, { workspaceRoot });
    assert.match(String(saved.result ?? saved), /Saved draft.txt/);
    assert.equal(await fs.readFile(file, 'utf8'), 'my edit\r\n');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('two saves from the same loaded revision cannot both overwrite', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-editor-revision-'));
  const file = path.join(workspaceRoot, 'draft.txt');
  try {
    await fs.writeFile(file, 'base');
    const expected_revision = revision('base');
    const outcomes = await Promise.all(['first', 'second'].map((content) =>
      executeServerTool('save_file', { path: 'draft.txt', content, expected_revision }, { workspaceRoot })));
    const messages = outcomes.map((result) => String(result.result ?? result));
    assert.equal(messages.filter((message) => message.includes('Saved draft.txt')).length, 1);
    assert.equal(messages.filter((message) => message.includes('FILE_VERSION_CONFLICT')).length, 1);
    assert.ok(['first', 'second'].includes(await fs.readFile(file, 'utf8')));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
