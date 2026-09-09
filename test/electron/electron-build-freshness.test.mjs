import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isElectronBuildFresh } from '../../scripts/spawn-electron.mjs';
import { writeElectronDistPackageJson } from '../../scripts/build-electron.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainTs = path.join(repoRoot, 'electron', 'main.ts');
const mainJs = path.join(repoRoot, 'electron', 'dist', 'main.js');

// Regression guard for MIN-262: launching against a stale electron/dist/ ran a
// main process without the crash handlers, so crashes produced no log. The dev
// launcher must rebuild when any electron source is newer than the compiled
// output — an existence-only check is not enough.
describe('electron build freshness', () => {
  test('detects a source newer than compiled output', { skip: !fs.existsSync(mainJs) }, () => {
    const orig = fs.statSync(mainTs);
    try {
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(mainTs, future, future);
      assert.equal(
        isElectronBuildFresh(),
        false,
        'a source newer than dist/main.js must mark the build stale',
      );
    } finally {
      // Restore mtime so we do not force a needless rebuild on the next launch.
      fs.utimesSync(mainTs, orig.atime, orig.mtime);
    }
  });

  test('dist package.json stub tracks the repo version', () => {
    writeElectronDistPackageJson();
    const stub = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'electron', 'dist', 'package.json'), 'utf8'),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(stub.version, pkg.version);
    assert.equal(stub.main, 'main.js');
  });
});
