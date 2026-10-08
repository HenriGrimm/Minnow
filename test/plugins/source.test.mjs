import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import { parsePluginGitHubUrl, readPluginSource } from '../../server/plugins/source.js';

const commit = 'a'.repeat(40);
const manifest = { apiVersion: 1, id: 'remote-demo', name: 'Remote demo', description: 'A remote plugin', version: '1.0.0', ui: { entry: 'ui.mjs' } };
const contents = { 'plugin.json': JSON.stringify(manifest), 'ui.mjs': 'export default () => {};', 'icon.png': Buffer.from([0, 255, 128, 42]) };

function mockGitHub(t, { prefix = '', changeTree, failRaw = false, oversizedRaw = false } = {}) {
  t.mock.method(dns, 'lookup', async () => [{ address: '140.82.112.3', family: 4 }]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url.includes('/commits/')) {
      assert.equal(options.headers.Accept, 'application/vnd.github.sha');
      return new Response(commit);
    }
    if (url.includes('/git/trees/')) {
      const tree = Object.entries(contents).map(([name, content]) => ({ path: prefix + name, type: 'blob', mode: '100644', size: Buffer.byteLength(content) }));
      if (prefix) tree.push({ path: 'unrelated/big.txt', type: 'blob', mode: '100644', size: 99_000_000 });
      return Response.json(changeTree ? changeTree({ tree }) : { tree });
    }
    if (failRaw) return new Response('Unavailable', { status: 404 });
    if (oversizedRaw) return new Response(Buffer.alloc(8 * 1024 * 1024 + 1));
    return new Response(contents[url.split('/').at(-1)]);
  });
  return calls;
}

test('GitHub sources accept repo and tree URLs and reject ambiguous or unsafe inputs', () => {
  assert.deepEqual(parsePluginGitHubUrl('https://github.com/owner/repo.git/'), { repo: 'owner/repo', ref: 'HEAD', subpath: '' });
  assert.deepEqual(parsePluginGitHubUrl('https://github.com/owner/repo/tree/main/plugins/demo'), { repo: 'owner/repo', ref: 'main', subpath: 'plugins/demo' });
  assert.equal(parsePluginGitHubUrl('https://github.com/owner/repo/tree/feature%2Fplugin').ref, 'feature/plugin');
  for (const url of ['http://github.com/owner/repo', 'https://example.com/owner/repo', 'https://github.com@localhost/owner/repo', 'https://user:secret@github.com/owner/repo', 'https://github.com/owner/repo/issues', 'https://github.com/owner/repo/tree', 'https://github.com/owner/repo/tree/main/folder%2F..%2Fescape', 'https://github.com/owner/repo?token=secret']) {
    assert.throws(() => parsePluginGitHubUrl(url), undefined, url);
  }
});

test('root repository imports preserve binary files and fetch only the reviewed commit', async t => {
  const calls = mockGitHub(t);
  const result = await readPluginSource('https://github.com/owner/repo', { commit });
  assert.equal(result.manifest.id, manifest.id);
  assert.equal(result.commit, commit);
  assert.equal(calls.some(url => url.includes('/commits/')), false);
  assert.deepEqual(result.files.find(file => file.name === 'icon.png').bytes, contents['icon.png']);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test('subfolder imports resolve the branch once and exclude unrelated repository files', async t => {
  const calls = mockGitHub(t, { prefix: 'plugins/demo/' });
  const result = await readPluginSource('https://github.com/owner/repo/tree/main/plugins/demo');
  assert.equal(result.files.length, 3);
  assert.equal(result.commit, commit);
  assert.ok(calls.some(url => url.endsWith('/commits/main')));
  assert.ok(calls.some(url => url.endsWith('/plugins/demo/plugin.json')));
});

test('remote imports reject missing manifests, incomplete trees, traversal, links and package limits', async t => {
  for (const [name, changeTree, message] of [
    ['missing manifest', () => ({ tree: [] }), /No plugin.json/],
    ['truncated tree', data => ({ ...data, truncated: true }), /incomplete/],
    ['symlink', data => { data.tree[1].mode = '120000'; return data; }, /Links/],
    ['submodule', data => { data.tree[1].type = 'commit'; return data; }, /submodules/],
    ['traversal', data => { data.tree[1].path = '../outside'; return data; }, /Invalid package-relative/],
    ['size', data => { data.tree[1].size = 8 * 1024 * 1024; return data; }, /8 MiB/],
    ['file count', data => { data.tree.push(...Array.from({ length: 256 }, (_, i) => ({ path: `extra-${i}`, type: 'blob', mode: '100644', size: 0 }))); return data; }, /256 files/],
  ]) await t.test(name, async child => {
    mockGitHub(child, { changeTree });
    await assert.rejects(readPluginSource('https://github.com/owner/repo'), message);
  });
});

test('remote downloads surface failures and enforce actual streamed bytes', async t => {
  await t.test('unavailable repository file', async child => {
    mockGitHub(child, { failRaw: true });
    await assert.rejects(readPluginSource('https://github.com/owner/repo'), /GitHub download failed.*404/);
  });
  await t.test('lying file size', async child => {
    mockGitHub(child, { oversizedRaw: true });
    await assert.rejects(readPluginSource('https://github.com/owner/repo'), /size limit/);
  });
});
