/**
 * gh CLI resolution — Finder-launched macOS apps lack Homebrew on PATH.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { augmentUnixPath, resolveGhCommand } from '../../server/git/gh-cli.js';

const unixOnly = process.platform === 'win32' ? { skip: 'unix PATH semantics' } : {};

describe('augmentUnixPath', unixOnly, () => {
  test('appends missing dirs after existing entries without duplicates', () => {
    const result = augmentUnixPath('/usr/bin:/bin:/opt/homebrew/bin', ['/opt/homebrew/bin', '/usr/local/bin']);
    assert.equal(result, '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  });
});

describe('resolveGhCommand', () => {
  test('stays bare on Windows', () => {
    assert.equal(resolveGhCommand({ platform: 'win32', pathEnv: '', extraDirs: [] }), 'gh');
  });

  test('finds gh in a well-known dir missing from the launchd PATH', unixOnly, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-cli-'));
    try {
      const bin = path.join(dir, 'gh');
      fs.writeFileSync(bin, '#!/bin/sh\n');
      fs.chmodSync(bin, 0o755);
      assert.equal(
        resolveGhCommand({ platform: 'darwin', pathEnv: '/usr/bin:/bin', extraDirs: [dir] }),
        bin,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to bare gh when nothing is found', unixOnly, () => {
    assert.equal(
      resolveGhCommand({ platform: 'darwin', pathEnv: '', extraDirs: ['/definitely/not/here'] }),
      'gh',
    );
  });
});
