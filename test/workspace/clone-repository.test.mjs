import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { cloneWorkspaceRepository } from '../../server/workspace/clone.js';
import { getWorkspaceInfo } from '../../server/workspace/root.js';
import { parseRemoteRepository, validateRemoteFolderName } from '../../src/lib/remote-repository.mjs';

const git = promisify(execFile);
const remote = 'https://minnow-clone.invalid/sample.git';

test('remote links suggest names and reject local paths, credentials and executable transports', () => {
  for (const url of ['https://example.com/team/my-app.git', 'git@example.com:team/my-app.git', 'ssh://git@example.com:2222/team/my-app.git']) {
    assert.equal(parseRemoteRepository(url).name, 'my-app');
  }
  assert.equal(parseRemoteRepository(' https://example.com/team/my%20app.git/ ').name, 'my app');
  for (const url of ['', '--upload-pack=evil', '/local/repo', 'C:\\repo', 'file:///local/repo', 'ext::evil', 'https://token@example.com/repo', 'ssh://git:secret@example.com/repo', 'https://example.com/repo?token=secret', 'https://example.com/repo\n--evil']) {
    assert.throws(() => parseRemoteRepository(url));
  }
  for (const name of ['../escape', '.', '..', 'bad/name', 'bad\\name', 'con.txt', 'NUL', 'bad.', 'bad\u0000name']) {
    assert.ok(validateRemoteFolderName(name), name);
  }
});

describe('workspace clone', { concurrency: false }, () => {
  let scratch;
  let projects;
  const oldEnv = {};
  before(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-clone-test-'));
    projects = path.join(scratch, 'projects');
    await fs.mkdir(projects);
    const source = path.join(scratch, 'sample.git');
    await fs.mkdir(source);
    await git('git', ['init', source]);
    await fs.writeFile(path.join(source, 'README.md'), '# Clone fixture\n');
    await git('git', ['-C', source, 'add', 'README.md']);
    await git('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Fixture']);
    // Real Git clone, with only this fake remote host mapped onto the local fixture.
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) oldEnv[key] = process.env[key];
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.${scratch.replace(/\\/g, '/')}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://minnow-clone.invalid/';
  });
  after(async () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });

  test('clones files and history into the chosen folder without switching workspace', async () => {
    const beforePath = getWorkspaceInfo().path;
    const result = await cloneWorkspaceRepository(projects, 'chosen-folder', remote);
    assert.equal(result.path, path.join(projects, 'chosen-folder'));
    assert.match(await fs.readFile(path.join(result.path, 'README.md'), 'utf8'), /^# Clone fixture\r?\n$/);
    assert.equal((await git('git', ['-C', result.path, 'log', '-1', '--format=%s'])).stdout.trim(), 'Fixture');
    assert.equal((await git('git', ['-C', result.path, 'config', '--get', 'remote.origin.url'])).stdout.trim(), remote);
    assert.equal(getWorkspaceInfo().path, beforePath);
  });

  test('uses the repository name when no folder name is supplied', async () => {
    const result = await cloneWorkspaceRepository(projects, undefined, remote);
    assert.equal(result.name, 'sample');
  });

  test('never overwrites or removes an existing folder', async () => {
    const existing = path.join(projects, 'existing');
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, 'keep.txt'), 'keep');
    await assert.rejects(cloneWorkspaceRepository(projects, 'existing', remote), /already exists/);
    assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
  });

  test('cleans up a failed clone and permits retry into the same folder', async () => {
    await assert.rejects(cloneWorkspaceRepository(projects, 'retry', 'https://minnow-clone.invalid/missing.git'));
    await assert.rejects(fs.stat(path.join(projects, 'retry')), { code: 'ENOENT' });
    await cloneWorkspaceRepository(projects, 'retry', remote);
    assert.match(await fs.readFile(path.join(projects, 'retry', 'README.md'), 'utf8'), /^# Clone fixture\r?\n$/);
  });

  test('invalid links, folder names and parents create no folders', async () => {
    const entries = await fs.readdir(projects);
    await assert.rejects(cloneWorkspaceRepository(projects, '../escape', remote));
    await assert.rejects(cloneWorkspaceRepository(projects, 'invalid', 'ext::evil'));
    await assert.rejects(cloneWorkspaceRepository('relative', 'invalid', remote), /absolute/);
    assert.deepEqual(await fs.readdir(projects), entries);
  });
});
