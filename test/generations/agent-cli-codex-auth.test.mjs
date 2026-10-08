import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCodexAuth } from '../../server/generations/agent-cli/codex-auth.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'auth.json');
  await fs.writeFile(source, 'original-login');
  const homes = [path.join(root, 'first'), path.join(root, 'second')];
  await Promise.all(homes.map(home => fs.mkdir(home)));
  const sync = await Promise.all(homes.map(home => prepareCodexAuth(home, { codexAuthPath: source })));
  await Promise.all(homes.map((home, index) => fs.writeFile(path.join(home, 'auth.json'), `refresh-${index}`)));
  return { root, source, homes, sync };
}

test('concurrent Codex refreshes serialize compare-and-replace without overwriting the winner', async t => {
  const { root, source, sync } = await fixture(t);
  const readFile = fs.readFile.bind(fs);
  let reading = 0, peak = 0;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file !== source) return readFile(file, ...args);
    reading++; peak = Math.max(peak, reading);
    try {
      const result = await readFile(file, ...args);
      // Give a competing sync time to read the same old credentials.
      await new Promise(resolve => setTimeout(resolve, 30));
      return result;
    } finally { reading--; }
  });
  await Promise.all(sync.map(save => save()));
  assert.equal(peak, 1);
  assert.equal(await readFile(source, 'utf8'), 'refresh-0');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('minnow-sync')), []);
  await fs.writeFile(source, 'new-sign-in');
  await Promise.all(sync.map(save => save()));
  assert.equal(await readFile(source, 'utf8'), 'new-sign-in');
});

test('a failed Codex credential replacement releases the lock and removes its temporary file', async t => {
  const { root, source, sync } = await fixture(t);
  const rename = fs.rename.bind(fs);
  let fail = true;
  t.mock.method(fs, 'rename', async (...args) => {
    if (fail) { fail = false; throw Object.assign(new Error('fixture write failure'), { code: 'EACCES' }); }
    return rename(...args);
  });
  await assert.rejects(sync[0](), { code: 'EACCES' });
  await sync[1]();
  assert.equal(await fs.readFile(source, 'utf8'), 'refresh-1');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes('minnow-sync')), []);
});
