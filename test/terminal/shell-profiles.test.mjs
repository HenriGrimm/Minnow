import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetWslShellProfileCache,
  resolveProfiles,
  resolvePtySpawnForProfile,
  getShellProfileById,
  describeShellProfileRuntime,
} from '../../server/terminal/shell-profiles.js';

describe('shell-profiles', () => {
  it('win32 includes powershell and cmd', () => {
    const profiles = resolveProfiles('win32', { wsl: false, gitBashPath: null });
    const ids = profiles.map((p) => p.id);
    assert.ok(ids.includes('powershell'));
    assert.ok(ids.includes('cmd'));
    assert.equal(ids.includes('zsh'), false);
    assert.equal(ids.includes('git-bash'), false);
  });

  it('darwin includes zsh and bash', () => {
    const profiles = resolveProfiles('darwin', {});
    const ids = profiles.map((p) => p.id);
    assert.ok(ids.includes('zsh'));
    assert.ok(ids.includes('bash'));
    const zsh = profiles.find((p) => p.id === 'zsh');
    assert.deepEqual(zsh?.args, ['-il']);
  });

  it('linux includes bash', () => {
    const profiles = resolveProfiles('linux', { systemShell: '/bin/bash' });
    assert.equal(profiles[0].id, 'bash');
    assert.deepEqual(profiles[0].args, ['-il']);
  });

  it('includes a nonstandard Unix login shell alongside explicit shell choices', () => {
    const profiles = resolveProfiles('linux', { systemShell: '/usr/bin/fish' });
    assert.equal(profiles.find((p) => p.id === 'system')?.shell, '/usr/bin/fish');
    assert.ok(profiles.some((p) => p.id === 'bash'));
    const mac = resolveProfiles('darwin', { systemShell: '/bin/zsh' });
    assert.equal(mac.some((p) => p.id === 'system'), false);
  });

  it('win32 adds per-distro WSL profiles when wsl option true', () => {
    resetWslShellProfileCache();
    const profiles = resolveProfiles('win32', {
      wsl: true,
      wslDistros: ['Ubuntu', 'Debian'],
      wslDefaultDistro: 'Ubuntu',
      gitBashPath: null,
    });
    assert.ok(profiles.some((p) => p.id === 'wsl:Ubuntu' && p.runtime === 'wsl'));
    assert.ok(profiles.some((p) => p.id === 'wsl:Debian'));
    assert.ok(profiles.some((p) => p.id === 'bash' && p.shell === 'wsl.exe'));
  });

  it('resolvePtySpawnForProfile maps cwd into wsl --cd', () => {
    const profile = getShellProfileById('wsl:Ubuntu') ??
      resolveProfiles('win32', {
        wsl: true,
        wslDistros: ['Ubuntu'],
        wslDefaultDistro: 'Ubuntu',
      }).find((p) => p.id === 'wsl:Ubuntu');
    assert.ok(profile);
    const spawn = resolvePtySpawnForProfile(profile, 'C:\\Users\\dev\\repo');
    assert.equal(spawn.shell, 'wsl.exe');
    assert.ok(spawn.args.includes('--cd'));
    assert.ok(spawn.args.includes('/mnt/c/Users/dev/repo'));
  });

  it('win32 adds git-bash after cmd without colliding with WSL bash', () => {
    resetWslShellProfileCache();
    const profiles = resolveProfiles('win32', {
      wsl: true,
      wslDistros: ['Ubuntu'],
      wslDefaultDistro: 'Ubuntu',
      gitBashPath: 'C:\\Git\\bin\\bash.exe',
    });
    const gitBash = profiles.find((p) => p.id === 'git-bash');
    const wslBash = profiles.find((p) => p.id === 'bash');
    assert.ok(gitBash);
    assert.equal(gitBash?.runtime, 'git-bash');
    assert.equal(gitBash?.shell, 'C:\\Git\\bin\\bash.exe');
    assert.deepEqual(gitBash?.args, ['--login', '-i']);
    assert.ok(wslBash);
    assert.equal(wslBash?.runtime, 'wsl');
    assert.equal(wslBash?.shell, 'wsl.exe');
    assert.equal(describeShellProfileRuntime(gitBash).runtime, 'git-bash');
  });

  it('resolvePtySpawnForProfile uses Windows cwd for git-bash', () => {
    const profiles = resolveProfiles('win32', {
      wsl: false,
      gitBashPath: 'C:\\Git\\bin\\bash.exe',
    });
    const profile = profiles.find((p) => p.id === 'git-bash');
    assert.ok(profile);
    const spawn = resolvePtySpawnForProfile(profile, 'C:\\Users\\dev\\repo');
    assert.equal(spawn.shell, 'C:\\Git\\bin\\bash.exe');
    assert.deepEqual(spawn.args, ['--login', '-i']);
    assert.equal(spawn.cwd, 'C:\\Users\\dev\\repo');
  });
});
