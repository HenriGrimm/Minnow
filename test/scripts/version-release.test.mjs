import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReleaseVersion } from '../../scripts/prepare-version-release.mjs';
import { verifyReleaseAssets } from '../../scripts/verify-release-assets.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('stable release accepts an optional v prefix and ignores nightly tags', () => {
  assert.deepEqual(validateReleaseVersion('v0.1.7', ['v0.1.6', 'v0.1.7-beta.20261001.1.1']), {
    version: '0.1.7', tag: 'v0.1.7',
  });
  assert.equal(validateReleaseVersion('1.0.0', []).version, '1.0.0');
});

test('stable release rejects malformed versions and shell input', () => {
  for (const value of ['', '1.2', '01.2.3', '1.2.3-beta.1', '1.2.3+build', '1.2.3\n', '$(whoami)', undefined]) {
    assert.throws(() => validateReleaseVersion(value, []), /Enter a stable version/);
  }
});

test('stable release rejects duplicates and downgrades across all existing tags', () => {
  for (const value of ['0.1.6', '0.1.5', '0.9.0', '1.0.0']) {
    assert.throws(() => validateReleaseVersion(value, ['v0.1.6', 'v1.0.0']), /must be newer/);
  }
  assert.equal(validateReleaseVersion('0.10.0', ['v0.9.9']).version, '0.10.0');
  assert.equal(validateReleaseVersion('1.0.0', ['v0.99.99']).version, '1.0.0');
});

function releaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('installer fixture');
  const hash = createHash('sha512').update(bytes).digest('base64');
  for (const [feed, extensions] of [
    ['latest.yml', ['exe']], ['latest-linux.yml', ['AppImage']], ['latest-mac.yml', ['dmg', 'zip']],
  ]) {
    let yaml = 'version: 0.1.7\nfiles:\n';
    for (const extension of extensions) {
      const name = `Minnow-0.1.7.${extension}`;
      fs.writeFileSync(path.join(directory, name), bytes);
      yaml += `  - url: ${name}\n    sha512: ${hash}\n    size: ${bytes.length}\n`;
    }
    fs.writeFileSync(path.join(directory, feed), yaml);
  }
  return directory;
}

test('release verifies every platform feed and installer checksum', async (t) => {
  await verifyReleaseAssets(releaseFixture(t), '0.1.7');
});

test('release blocks missing feeds, installers, and incorrect versions', async (t) => {
  const directory = releaseFixture(t);
  await assert.rejects(verifyReleaseAssets(directory, '0.1.8'), /expected version/);
  fs.unlinkSync(path.join(directory, 'Minnow-0.1.7.zip'));
  await assert.rejects(verifyReleaseAssets(directory, '0.1.7'), /installer missing/);
  fs.unlinkSync(path.join(directory, 'latest.yml'));
  await assert.rejects(verifyReleaseAssets(directory, '0.1.7'), /ENOENT/);
});

test('release blocks corrupt installers even when the file size is unchanged', async (t) => {
  const directory = releaseFixture(t);
  fs.writeFileSync(path.join(directory, 'Minnow-0.1.7.exe'), 'Installer fixture');
  await assert.rejects(verifyReleaseAssets(directory, '0.1.7'), /SHA-512 mismatch/);
});

test('release blocks empty update feeds', async (t) => {
  const directory = releaseFixture(t);
  fs.writeFileSync(path.join(directory, 'latest.yml'), 'version: 0.1.7\nfiles: []\n');
  await assert.rejects(verifyReleaseAssets(directory, '0.1.7'), /no update files/);
});
