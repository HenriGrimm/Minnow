import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import { parsePluginGitHubUrl, readPluginSource } from '../../server/plugins/source.js';
import { readGitHubArchive } from '../../server/plugins/github-archive.js';
import { githubArchive, paxRecord } from './github-fixture.mjs';

const commit = 'a'.repeat(40);
const manifest = { apiVersion: 1, id: 'remote-demo', name: 'Remote demo', description: 'A remote plugin', version: '1.0.0', ui: { entry: 'ui.mjs' } };
const contents = { 'plugin.json': JSON.stringify(manifest), 'ui.mjs': 'export default () => {};', 'icon.png': Buffer.from([0, 255, 128, 42]) };
const pluginFiles = (prefix = '') => Object.entries(contents).map(([name, bytes]) => ({ name: prefix + name, bytes }));

function mockGitHub(t, { entries = pluginFiles(), status = 200, archive, archiveCommit = commit } = {}) {
  t.mock.method(dns, 'lookup', async () => [{ address: '140.82.112.3', family: 4 }]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.ok(url.startsWith('https://codeload.github.com/'));
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(archive ?? githubArchive(entries, { commit: archiveCommit }), { status });
  });
  return calls;
}

test('GitHub sources accept repo and tree URLs and reject ambiguous or unsafe inputs', () => {
  assert.deepEqual(parsePluginGitHubUrl('https://github.com/owner/repo.git/'), { repo: 'owner/repo', ref: 'HEAD', subpath: '' });
  assert.deepEqual(parsePluginGitHubUrl('https://github.com/owner/repo/tree/main/plugins/demo'), { repo: 'owner/repo', ref: 'main', subpath: 'plugins/demo' });
  assert.equal(parsePluginGitHubUrl('https://github.com/owner/repo/tree/feature%2Fplugin').ref, 'feature/plugin');
  for (const url of ['http://github.com/owner/repo', 'https://example.com/owner/repo', 'https://github.com@localhost/owner/repo', 'https://user:secret@github.com/owner/repo', 'https://github.com/owner/repo/issues', 'https://github.com/owner/repo/tree', 'https://github.com/owner/repo/tree/main/folder%2F..%2Fescape', 'https://github.com/owner/repo?token=secret']) assert.throws(() => parsePluginGitHubUrl(url), undefined, url);
});

test('root imports preserve binary files and use a commit-pinned archive without REST API calls', async t => {
  const calls = mockGitHub(t);
  const result = await readPluginSource('https://github.com/owner/repo', { commit });
  assert.equal(result.manifest.id, manifest.id);
  assert.equal(result.commit, commit);
  assert.deepEqual(calls, [`https://codeload.github.com/owner/repo/tar.gz/${commit}`]);
  assert.deepEqual(result.files.find(file => file.name === 'icon.png').bytes, contents['icon.png']);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test('repository URLs discover a single nested plugin and retain its folder for install and reload', async t => {
  const calls = mockGitHub(t, { entries: [...pluginFiles('plugins/token-idle/'), { name: 'README.md', bytes: 'Repository overview' }] });
  const result = await readPluginSource('https://github.com/owner/repo');
  assert.equal(result.files.length, 3);
  assert.equal(result.source, 'https://github.com/owner/repo/tree/HEAD/plugins/token-idle');
  assert.equal(result.commit, commit);
  const pinned = await readPluginSource(result.source, { commit: result.commit });
  assert.equal(pinned.digest, result.digest);
  assert.deepEqual(calls, ['https://codeload.github.com/owner/repo/tar.gz/HEAD', `https://codeload.github.com/owner/repo/tar.gz/${commit}`]);
});

test('explicit subfolders exclude unrelated files and disambiguate repositories with multiple plugins', async t => {
  mockGitHub(t, { entries: [...pluginFiles('plugins/demo/'), ...pluginFiles('plugins/other/')] });
  await assert.rejects(readPluginSource('https://github.com/owner/repo'), /multiple plugins/);
  const result = await readPluginSource('https://github.com/owner/repo/tree/main/plugins/demo');
  assert.equal(result.files.length, 3);
  assert.equal(result.commit, commit);
});

test('imports reject missing manifests, traversal, links, special files and package limits', async t => {
  for (const [name, entries, message] of [
    ['missing manifest', [], /No plugin.json/],
    ['symlink', [...pluginFiles(), { name: 'link', type: '2' }], /Links/],
    ['hard link', [...pluginFiles(), { name: 'link', type: '1' }], /Links/],
    ['special file', [...pluginFiles(), { name: 'fifo', type: '6' }], /special files/],
    ['traversal', [...pluginFiles(), { name: '../outside' }], /Invalid package-relative/],
    ['duplicate', [...pluginFiles(), pluginFiles()[0]], /Duplicate/],
    ['size', [...pluginFiles(), { name: 'big', bytes: Buffer.alloc(8 * 1024 * 1024) }], /8 MiB/],
    ['file count', [...pluginFiles(), ...Array.from({ length: 256 }, (_, i) => ({ name: `extra-${i}` }))], /256 files/],
  ]) await t.test(name, async child => {
    mockGitHub(child, { entries });
    await assert.rejects(readPluginSource('https://github.com/owner/repo'), message);
  });
});

test('downloads report failures, bound compressed bytes and verify reviewed commits', async t => {
  await t.test('unavailable archive', async child => {
    mockGitHub(child, { status: 404 });
    await assert.rejects(readPluginSource('https://github.com/owner/repo'), /archive download failed.*404/);
  });
  await t.test('compressed size limit', async child => {
    mockGitHub(child, { archive: Buffer.alloc(16 * 1024 * 1024 + 1) });
    await assert.rejects(readPluginSource('https://github.com/owner/repo'), /download size limit/);
  });
  await t.test('reviewed commit mismatch', async child => {
    mockGitHub(child, { archiveCommit: 'b'.repeat(40) });
    await assert.rejects(readPluginSource('https://github.com/owner/repo', { commit }), /does not match/);
  });
});

test('archive parsing validates checksums, metadata, completeness and decompressed size', () => {
  assert.throws(() => readGitHubArchive(Buffer.from('not gzip')), /Invalid GitHub source archive/);
  assert.throws(() => readGitHubArchive(githubArchive(pluginFiles(), { omitMetadata: true })), /missing commit metadata/);
  assert.throws(() => readGitHubArchive(githubArchive(pluginFiles(), { transform: bytes => { bytes[0] ^= 1; return bytes; } })), /checksum/);
  assert.throws(() => readGitHubArchive(githubArchive(pluginFiles(), { transform: bytes => bytes.subarray(0, -1024) })), /Truncated/);
  assert.throws(() => readGitHubArchive(githubArchive([{ name: 'big', bytes: Buffer.alloc(64 * 1024 * 1024) }])), /exceeds 64 MiB/);
  const longPath = 'plugins/' + 'long-folder-'.repeat(12) + '/ui.mjs';
  const archive = githubArchive([{ name: 'extended', type: 'x', bytes: paxRecord('path', `repository-HEAD/${longPath}`) }, { name: 'placeholder', bytes: 'export default () => {};' }]);
  assert.equal(readGitHubArchive(archive).entries[0].name, longPath);
});
