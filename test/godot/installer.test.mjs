import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { findGodotExecutable } from '../../server/godot/engine.js';
import {
  __resetGodotInstallerForTests,
  __setGodotInstallerTestHooks,
  checksumForAsset,
  installManagedGodot,
  readManagedGodotInstall,
  selectGodotAsset,
  selectStableGodotRelease,
} from '../../server/godot/installer.js';

describe('managed Godot installer', () => {
  let home;
  let previousHome;
  let previousConfigured;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-godot-installer-'));
    previousHome = process.env.MINNOW_HOME;
    previousConfigured = process.env.MINNOW_GODOT_PATH;
    process.env.MINNOW_HOME = home;
    delete process.env.MINNOW_GODOT_PATH;
    resetMinnowHomeCache();
  });

  afterEach(async () => {
    __resetGodotInstallerForTests();
    if (previousHome == null) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    if (previousConfigured == null) delete process.env.MINNOW_GODOT_PATH;
    else process.env.MINNOW_GODOT_PATH = previousConfigured;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  });

  test('selects the newest stable Godot 4 build and platform archive', () => {
    const release = selectStableGodotRelease([
      { tag_name: '4.8-dev1', prerelease: true },
      { tag_name: '4.6.3-stable' },
      { tag_name: '4.7.2-stable' },
      { tag_name: '3.6.3-stable' },
    ]);
    assert.equal(release.tag_name, '4.7.2-stable');
    const asset = selectGodotAsset([
      { name: 'Godot_v4.7.2-stable_mono_win64.zip', browser_download_url: 'mono' },
      { name: 'Godot_v4.7.2-stable_win64.exe.zip', browser_download_url: 'standard' },
    ], 'win32', 'x64');
    assert.equal(asset.browser_download_url, 'standard');
  });

  test('parses only the checksum for the selected asset', () => {
    const checksum = 'a'.repeat(128);
    assert.equal(checksumForAsset(`${'b'.repeat(128)}  other.zip\n${checksum} *Godot.zip\n`, 'Godot.zip'), checksum);
  });

  test('installs a verified archive and makes it the automatic engine', async () => {
    const archive = Buffer.from('fake verified Godot archive');
    const checksum = createHash('sha512').update(archive).digest('hex');
    const asset = { name: 'Godot_v4.7.2-stable_win64.exe.zip', browser_download_url: 'https://example.test/godot.zip' };
    const sums = { name: 'SHA512-SUMS.txt', browser_download_url: 'https://example.test/sums' };
    __setGodotInstallerTestHooks({
      fetch: async (url) => url.includes('releases?')
        ? { ok: true, json: async () => [{ tag_name: '4.7.2-stable', assets: [asset, sums] }] }
        : { ok: true, text: async () => `${checksum}  ${asset.name}\n` },
      download: async (_url, destination) => fs.writeFile(destination, archive),
      extract: async (_archive, destination) => {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, 'Godot_v4.7.2-stable_win64_console.exe'), 'binary');
      },
    });

    const installed = await installManagedGodot({ platform: 'win32', arch: 'x64' });
    assert.equal(installed.version, '4.7.2-stable');
    assert.equal((await readManagedGodotInstall()).executable, installed.executable);
    const discovered = await findGodotExecutable({ platform: 'win32', homeDir: home, env: {} });
    assert.equal(discovered.source, 'managed');
    assert.equal(discovered.path, installed.executable);
  });
});
