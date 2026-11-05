/**
 * Brain page path sandbox — traversal rejection (highest priority).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  BrainPathError,
  assertSafeRelativePagePath,
  getBrainPagesDir,
  resolvePagePath,
} from '../../server/brain/paths.js';
import { ensureBrainLayout } from '../../server/brain/store.js';

let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-brain-paths-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await ensureBrainLayout();
});

after(async () => {
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function expectPathError(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      await result;
    }
    assert.fail('expected BrainPathError');
  } catch (err) {
    assert.ok(err instanceof BrainPathError, `expected BrainPathError, got ${err}`);
  }
}

describe('brain path sandbox', () => {
  test('accepts a valid nested relative path', async () => {
    const resolved = await resolvePagePath('facts/note.md');
    assert.ok(resolved.endsWith(path.join('pages', 'facts', 'note.md')));
  });

  test('accepts nested project paths under pages root', async () => {
    const resolved = await resolvePagePath('projects/nested/page.md');
    const normalized = resolved.replace(/\\/g, '/');
    assert.ok(normalized.endsWith('projects/nested/page.md'));
  });

  test('rejects absolute paths', async () => {
    const abs = path.join(getBrainPagesDir(), 'facts', 'evil.md');
    await expectPathError(() => resolvePagePath(abs));
    await expectPathError(() => assertSafeRelativePagePath(abs));
  });

  test('rejects parent directory segments', async () => {
    await expectPathError(() => resolvePagePath('../secrets.md'));
    await expectPathError(() => resolvePagePath('facts/../../outside.md'));
    await expectPathError(() => assertSafeRelativePagePath('..\\escape.md'));
  });

  test('rejects leading slash or backslash', async () => {
    await expectPathError(() => resolvePagePath('/facts/note.md'));
    await expectPathError(() => resolvePagePath('\\facts\\note.md'));
  });

  test('rejects drive letters on Windows-style paths', async () => {
    await expectPathError(() => resolvePagePath('C:/facts/note.md'));
    await expectPathError(() => resolvePagePath('D:\\facts\\note.md'));
  });

  test('rejects null bytes', async () => {
    await expectPathError(() => resolvePagePath('facts/note\0.md'));
  });

  test('rejects non-.md extensions', async () => {
    await expectPathError(() => resolvePagePath('facts/note.txt'));
    await expectPathError(() => resolvePagePath('facts/note'));
  });

  test('refuses a missing page under a directory junction before creating anything', async () => {
    const outside = path.join(homeDir, 'outside-dir');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(getBrainPagesDir(), 'linked'), 'junction');
    const { createPage } = await import('../../server/brain/store.js');
    await expectPathError(() => createPage({ relPath: 'linked/new.md', title: 'Escape', body: 'outside' }));
    assert.deepEqual(await fs.readdir(outside), []);
  });

  test('rejects symlink that escapes the pages root', async () => {
    const pagesDir = getBrainPagesDir();
    const outside = path.join(homeDir, 'outside-secret.md');
    await fs.writeFile(outside, '# outside\n', 'utf8');
    const linkPath = path.join(pagesDir, 'escape-link.md');
    try {
      await fs.symlink(outside, linkPath);
    } catch (err) {
      if (err && typeof err === 'object' && (err.code === 'EPERM' || err.code === 'ENOENT')) {
        return;
      }
      throw err;
    }
    await expectPathError(() => resolvePagePath('escape-link.md'));
  });
});
