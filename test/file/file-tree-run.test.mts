/**
 * Files sidebar Run (MIN-35): runner mapping and per-shell command quoting.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ShellProfile } from '../../src/api/terminal-pty.ts';
import {
  buildRunScriptCommand,
  quoteCmd,
  quotePosix,
  quotePowerShell,
  scriptRunnerForPath,
} from '../../src/ui/file-tree-run.ts';

const pwsh: ShellProfile = { id: 'powershell', label: 'PowerShell 7', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [], platform: 'win32', runtime: 'native' };
const cmd: ShellProfile = { id: 'cmd', label: 'Command Prompt', shell: 'cmd.exe', args: [], platform: 'win32', runtime: 'native' };
const gitBash: ShellProfile = { id: 'git-bash', label: 'Git Bash', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [], platform: 'win32', runtime: 'git-bash' };
const wsl: ShellProfile = { id: 'bash', label: 'WSL Bash', shell: 'wsl.exe', args: [], platform: 'win32', runtime: 'wsl' };
const zsh: ShellProfile = { id: 'zsh', label: 'zsh', shell: '/bin/zsh', args: [], platform: 'darwin', runtime: 'native' };
const linuxBash: ShellProfile = { id: 'bash', label: 'bash', shell: '/bin/bash', args: [], platform: 'linux', runtime: 'native' };

function run(path: string, profile: ShellProfile): string | null {
  const runner = scriptRunnerForPath(path, profile.platform);
  assert.ok(runner, `expected a runner for ${path}`);
  return buildRunScriptCommand(path, runner, profile);
}

describe('scriptRunnerForPath', () => {
  test('maps supported script extensions', () => {
    assert.equal(scriptRunnerForPath('scripts/build.sh')?.id, 'bash');
    assert.equal(scriptRunnerForPath('tool.py')?.id, 'python');
    assert.equal(scriptRunnerForPath('a/b/c.MJS')?.id, 'node');
    assert.equal(scriptRunnerForPath('scripts/gen.ts')?.id, 'tsx');
    assert.equal(scriptRunnerForPath('setup.ps1')?.id, 'powershell');
    assert.equal(scriptRunnerForPath('build.bat', 'win32')?.id, 'batch');
  });

  test('rejects unsupported files', () => {
    for (const path of ['README.md', 'src/main.css', 'Makefile', '.bashrc', 'types/index.d.ts', 'x.d.mts', 'image.png', 'package.json']) {
      assert.equal(scriptRunnerForPath(path), null, path);
    }
  });

  test('hides batch files on non-Windows hosts', () => {
    assert.equal(scriptRunnerForPath('build.cmd', 'darwin'), null);
    assert.equal(scriptRunnerForPath('build.cmd', 'linux'), null);
    assert.equal(scriptRunnerForPath('build.cmd')?.id, 'batch');
  });

  test('rejects names with control characters', () => {
    assert.equal(scriptRunnerForPath('evil\n.sh'), null);
  });
});

describe('shell quoting', () => {
  test('posix single quotes escape embedded quotes', () => {
    assert.equal(quotePosix("it's here"), `'it'\\''s here'`);
    assert.equal(quotePosix('$(rm -rf) `x`'), `'$(rm -rf) \`x\`'`);
  });

  test('PowerShell doubles straight and typographic single quotes', () => {
    assert.equal(quotePowerShell("a'b"), `'a''b'`);
    assert.equal(quotePowerShell('a\u2019b'), `'a\u2019\u2019b'`);
    assert.equal(quotePowerShell('$env:HOME'), `'$env:HOME'`);
  });

  test('cmd places percent signs outside quotes', () => {
    assert.equal(quoteCmd('a b'), '"a b"');
    assert.equal(quoteCmd('100%done'), '"100"^%"done"');
  });
});

describe('buildRunScriptCommand', () => {
  test('paths with spaces are quoted for every shell', () => {
    assert.equal(run('my scripts/build it.sh', linuxBash), `bash './my scripts/build it.sh'`);
    assert.equal(run('my scripts/build it.sh', zsh), `bash './my scripts/build it.sh'`);
    assert.equal(run('my scripts/build it.sh', gitBash), `bash './my scripts/build it.sh'`);
    assert.equal(run('my scripts/build it.sh', wsl), `bash './my scripts/build it.sh'`);
    assert.equal(run('my scripts/build it.sh', pwsh), `bash '.\\my scripts\\build it.sh'`);
    assert.equal(run('my scripts/build it.sh', cmd), `bash ".\\my scripts\\build it.sh"`);
  });

  test('chooses the interpreter per runner and host', () => {
    assert.equal(run('tool.py', pwsh), `python '.\\tool.py'`);
    assert.equal(run('tool.py', linuxBash), `python3 './tool.py'`);
    assert.equal(run('tool.py', wsl), `python3 './tool.py'`);
    assert.equal(run('srv.mjs', zsh), `node './srv.mjs'`);
    assert.equal(run('gen.ts', zsh), `npx tsx './gen.ts'`);
    assert.equal(run('gen.ts', pwsh), `npx.cmd tsx '.\\gen.ts'`);
    assert.equal(run('gen.ts', cmd), `npx tsx ".\\gen.ts"`);
  });

  test('PowerShell scripts and batch files', () => {
    assert.equal(run('a b/setup.ps1', pwsh), `& '.\\a b\\setup.ps1'`);
    assert.equal(run('setup.ps1', cmd), `powershell -NoProfile -File ".\\setup.ps1"`);
    assert.equal(run('setup.ps1', zsh), `pwsh -NoProfile -File './setup.ps1'`);
    assert.equal(run('a b/build.bat', pwsh), `& '.\\a b\\build.bat'`);
    assert.equal(run('a b/build.bat', cmd), `".\\a b\\build.bat"`);
    assert.equal(run('a b/build.bat', gitBash), `'./a b/build.bat'`);
    assert.equal(run('a b/build.bat', wsl), `cmd.exe /c 'a b\\build.bat'`);
  });

  test('a leading dash is never read as an option', () => {
    assert.equal(run('-rf.sh', linuxBash), `bash './-rf.sh'`);
  });

  test('absolute paths are kept as-is', () => {
    assert.equal(run('/srv/app/run.sh', linuxBash), `bash '/srv/app/run.sh'`);
  });

  test('refuses names that cannot be passed safely', () => {
    const runner = scriptRunnerForPath('x.sh')!;
    assert.equal(buildRunScriptCommand('a"b.sh', runner, cmd), null);
    assert.equal(buildRunScriptCommand('a\nb.sh', runner, linuxBash), null);
  });

  test('batch files with % in the path only run from Command Prompt', () => {
    const runner = scriptRunnerForPath('x.bat', 'win32')!;
    assert.equal(buildRunScriptCommand('100%PATH%/x.bat', runner, cmd), `".\\100"^%"PATH"^%"\\x.bat"`);
    assert.equal(buildRunScriptCommand('100%PATH%/x.bat', runner, pwsh), null);
    assert.equal(buildRunScriptCommand('100%PATH%/x.bat', runner, gitBash), null);
    assert.equal(buildRunScriptCommand('100%PATH%/x.bat', runner, wsl), null);
  });
});
