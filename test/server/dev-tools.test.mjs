import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { archiveSpec, createDevToolsInstaller, devToolsPath, expectedChecksum } from '../../server/system/dev-tools.js';
import { handleSystemRequest } from '../../server/system/middleware.js';
import { setRequestIngress } from '../../server/network/ingress.js';

const result = (code = 0) => ({ code, stdout: '', stderr: '', timedOut: false });
async function fixture(t, existing = []) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dev-tools-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installed = new Set(existing);
  const calls = [];
  const downloads = [];
  let corrupt = false;
  const payload = Buffer.from('archive fixture');
  const hash = createHash('sha256').update(payload).digest('hex');
  const service = createDevToolsInstaller({ platform: 'darwin', arch: 'arm64', home: () => home, sleep: async () => {},
    fetch: async url => {
      downloads.push(url);
      if (url.endsWith('.txt')) return new Response(['node', 'github'].map(tool => `${hash}  ${archiveSpec(tool, 'arm64').file}`).join('\n'));
      return new Response(corrupt ? 'corrupt' : payload);
    },
    run: async (bin, args, options) => {
      calls.push({ bin, args, options });
      assert.ok(options.signal, 'installer work has its own timeout, not a request-disconnect signal');
      if (bin === '/usr/bin/xcrun') return result(installed.has('git') ? 0 : 1);
      if (bin === '/usr/bin/xcode-select') { installed.add('git'); return result(); }
      if (bin === '/usr/bin/tar' || bin === '/usr/bin/ditto') {
        const tool = bin.endsWith('tar') ? 'node' : 'github';
        await fs.mkdir(path.join(options.cwd, archiveSpec(tool, 'arm64').folder, 'bin'), { recursive: true });
        installed.add(tool === 'node' ? 'node' : 'gh');
        if (tool === 'node') installed.add('npm');
        return result();
      }
      if (bin === 'npm' && args[0] === 'install') {
        installed.add(args.at(-1).includes('claude') ? 'claude' : 'codex');
        return result();
      }
      if (path.isAbsolute(bin)) return result();
      return result(installed.has(bin) ? 0 : 1);
    },
  });
  async function finish(tool) {
    for (let i = 0; i < 1000 && service.status(tool).state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.notEqual(service.status(tool).state, 'running');
    return service.status(tool);
  }
  return { home, service, calls, downloads, finish, corrupt: value => { corrupt = value; } };
}

test('clean Mac installs Node/npm, selected agents, GitHub CLI and opens Apple Git setup without Homebrew', async t => {
  const h = await fixture(t);
  assert.equal(h.service.start('claude').state, 'running');
  h.service.start('claude'); // duplicate joins the same job
  h.service.start('codex');
  h.service.start('github');
  for (const tool of ['claude', 'codex', 'github']) assert.equal((await h.finish(tool)).state, 'ready');
  assert.equal(h.calls.filter(call => call.bin === '/usr/bin/tar').length, 1);
  assert.equal(h.calls.filter(call => call.bin === '/usr/bin/ditto').length, 1);
  assert.equal(h.calls.filter(call => call.bin === '/usr/bin/xcode-select').length, 1);
  const npm = h.calls.filter(call => call.args[0] === 'install');
  assert.equal(npm.length, 2);
  assert.ok(npm.every(call => call.args.includes(path.join(h.home, 'runtimes', 'dev-tools', 'npm'))));
  assert.ok(h.calls.every(call => !['brew', 'sudo'].includes(call.bin)));
  assert.ok(devToolsPath(h.home, '/usr/bin').includes(path.join(h.home, 'runtimes', 'dev-tools', 'node', 'bin')));
  assert.deepEqual((await fs.readdir(path.join(h.home, 'runtimes', 'dev-tools'))).sort(), ['github', 'node']);
});

test('healthy existing tools are reused with no downloads or system installs', async t => {
  const h = await fixture(t, ['node', 'npm', 'claude', 'git', 'gh']);
  h.service.start('claude');
  h.service.start('github');
  assert.equal((await h.finish('github')).state, 'ready');
  assert.equal(h.downloads.length, 0);
  assert.equal(h.calls.some(call => call.args[0] === 'install' || call.bin.endsWith('xcode-select')), false);
});

test('checksum failure never extracts or publishes the archive and can be retried', async t => {
  const h = await fixture(t, ['git']);
  h.corrupt(true);
  h.service.start('github');
  assert.match((await h.finish('github')).error, /SHA-256/);
  assert.equal(h.calls.some(call => call.bin.endsWith('ditto')), false);
  assert.deepEqual(await fs.readdir(path.join(h.home, 'runtimes', 'dev-tools')), []);
  h.corrupt(false);
  h.service.start('github');
  assert.equal((await h.finish('github')).state, 'ready');
});

test('official assets map Apple silicon and Intel architectures and require exact checksums', () => {
  assert.match(archiveSpec('node', 'x64').file, /darwin-x64\.tar\.gz$/);
  assert.match(archiveSpec('github', 'x64').file, /macOS_amd64\.zip$/);
  assert.match(archiveSpec('github', 'arm64').file, /macOS_arm64\.zip$/);
  assert.throws(() => archiveSpec('node', 'ia32'), /Apple silicon or Intel/);
  assert.throws(() => expectedChecksum('0'.repeat(64) + '  wrong.zip', 'right.zip'), /Missing SHA-256/);
  assert.throws(() => createDevToolsInstaller({ platform: 'win32' }).start('github'), /macOS/);
  assert.throws(() => createDevToolsInstaller({ platform: 'darwin' }).start('anything'), /Unknown/);
});

test('tool setup rejects remote ingress and non-host identities before starting installation', async () => {
  for (const [ingress, auth] of [['lan', 'host'], ['tailnet', 'host'], ['loopback', 'device']]) {
    const req = { method: 'POST', minnowAuth: { kind: auth } };
    setRequestIngress(req, ingress);
    const res = { statusCode: 0, setHeader() {}, end(body) { this.body = body; } };
    assert.equal(await handleSystemRequest(req, res, '/api/system/dev-tools/github'), true);
    assert.equal(res.statusCode, 403);
  }
});
