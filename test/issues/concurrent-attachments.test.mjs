import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIssueAttachmentsMiddleware } from '../../server/issues/attachments-routes.js';

test('same-name issue uploads retain every payload and sequential suffixes', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-issue-files-'));
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previous;
    await fs.rm(home, { force: true, recursive: true });
  });
  const server = http.createServer(createIssueAttachmentsMiddleware());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/issues/attachments';
  async function upload(value) {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({
      issueId: 'MIN-1', name: 'note.txt', data: Buffer.from(value).toString('base64'),
    }) });
    assert.equal(r.status, 200);
    return (await r.json()).attachment;
  }
  assert.equal((await upload('original')).name, 'note.txt');
  const uploads = await Promise.all(Array.from({ length: 16 }, (_, index) => upload(String(index))));
  assert.equal(new Set(uploads.map(x => x.key)).size, 16);
  for (const [index, attachment] of uploads.entries()) {
    const r = await fetch(url + '?key=' + encodeURIComponent(attachment.key));
    assert.equal(await r.text(), String(index));
  }
  assert.equal(await (await fetch(url + '?key=MIN-1/note.txt')).text(), 'original');
});
