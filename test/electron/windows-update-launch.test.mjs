import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const launch = fs.readFileSync(path.join(root, 'build/update-launch.nsh'), 'utf8');
const header = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8');

test('Windows updater hooks only the installer launch, preserving the Finish page', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  assert.match(header, /!ifndef BUILD_UNINSTALLER/);
  assert.match(launch, /!macroundef StartApp/);
  assert.match(launch, /UAC_AsUser_Call Function MinnowLaunchAsOriginalUser \$\{UAC_SYNCREGISTERS\}\|\$\{UAC_SYNCINSTDIR\}/);
  assert.match(launch, /Exec '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --updated'/);
  assert.doesNotMatch(launch, /ExecShell "open"/); // no elevated fallback
});

// Real NSIS bytecode exercises the production branch/retry logic, with injected
// launch results instead of UAC prompts, app launches or modal failure dialogs.
// Point MINNOW_TEST_MAKENSIS at electron-builder's cached makensis executable.
const compiler = process.env.MINNOW_TEST_MAKENSIS;
for (const scenario of [
  { name: 'successful user launch', result: 'ok', inner: 0, failures: 0, attempts: 1, failed: false },
  { name: 'legacy success', result: 'fallback', inner: 0, failures: 0, attempts: 1, failed: false },
  { name: 'transient shell failure', result: 'error', inner: 0, failures: 1, attempts: 2, failed: false },
  { name: 'transient missing file', result: 'not_found', inner: 0, failures: 2, attempts: 3, failed: false },
  { name: 'permanent failure', result: 'error', inner: 0, failures: 9, attempts: 3, failed: true },
  { name: 'ambiguous timeout is not retried', result: 'timeout', inner: 0, failures: 9, attempts: 1, failed: true },
  { name: 'elevated assisted update uses original user', result: 'ok', inner: 1, failures: 0, attempts: 1, failed: false },
]) {
  test(`NSIS update relaunch: ${scenario.name}`, { skip: process.platform !== 'win32' || !compiler }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-update-launch-'));
    try {
      // Redirect just the final UI notification, leaving its branch intact.
      fs.writeFileSync(path.join(dir, 'update-launch.nsh'), launch.replace(
        /MessageBox MB_OK\|MB_ICONEXCLAMATION\|MB_TOPMOST .*$/m,
        'StrCpy $failed "yes"',
      ));
      fs.writeFileSync(path.join(dir, 'installer.nsh'), header);
      const output = path.join(dir, 'result.txt');
      const exe = path.join(dir, 'probe.exe');
      const script = `
Unicode true
!include LogicLib.nsh
!define BUILD_RESOURCES_DIR "${dir}"
!define APP_EXECUTABLE_FILENAME "Minnow.exe"
!define UAC_SYNCREGISTERS 1
!define UAC_SYNCINSTDIR 8
!define UAC_IsInnerInstance '$inner == 1'
!define StdUtils.ExecShellAsUser '!insertmacro FakeShell'
!macro FakeShell out file verb args
  IntOp $shellCalls $shellCalls + 1
  Call FakeLaunch
!macroend
!macro UAC_AsUser_Call type name flags
  IntOp $userCalls $userCalls + 1
  Call FakeLaunch
!macroend
!macro StartApp
!macroend
Var inner
Var attempts
Var shellCalls
Var userCalls
Var failed
!include "${path.join(dir, 'installer.nsh')}"
!insertmacro customHeader
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
Function FakeLaunch
  IntOp $attempts $attempts + 1
  StrCpy $0 "ok"
  \${If} $attempts <= ${scenario.failures}
    StrCpy $0 "${scenario.result}"
  \${Else}
    StrCpy $0 "${scenario.result === 'fallback' ? 'fallback' : 'ok'}"
  \${EndIf}
FunctionEnd
Section
  StrCpy $inner ${scenario.inner}
  StrCpy $attempts 0
  StrCpy $shellCalls 0
  StrCpy $userCalls 0
  StrCpy $failed "no"
  StrCpy $0 "saved-zero"
  StrCpy $1 "saved-one"
  !insertmacro StartApp
  FileOpen $2 "${output}" w
  FileWrite $2 "$attempts|$shellCalls|$userCalls|$failed|$0|$1"
  FileClose $2
SectionEnd
`;
      const source = path.join(dir, 'probe.nsi');
      fs.writeFileSync(source, script);
      const compile = spawnSync(compiler, ['/V2', source], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(compile.status, 0, `${compile.error ?? ''}\n${compile.stdout}\n${compile.stderr}`);
      const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
      assert.equal(fs.readFileSync(output, 'utf8'), `${scenario.attempts}|${scenario.inner ? 0 : scenario.attempts}|${scenario.inner ? scenario.attempts : 0}|${scenario.failed ? 'yes' : 'no'}|saved-zero|saved-one`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('NSIS production UAC and StdUtils macros compile for installer and uninstaller', {
  skip: !compiler || !process.env.MINNOW_TEST_NSIS_PLUGINS,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-update-compile-'));
  try {
    const template = path.join(root, 'node_modules/app-builder-lib/templates/nsis/include');
    for (const uninstall of [false, true]) {
      const source = path.join(dir, 'probe.nsi');
      fs.writeFileSync(source, `
Unicode true
!include LogicLib.nsh
!addincludedir "${template}"
!addplugindir "${path.join(process.env.MINNOW_TEST_NSIS_PLUGINS, 'x86-unicode')}"
!include UAC.nsh
!include StdUtils.nsh
!define BUILD_RESOURCES_DIR "${path.join(root, 'build')}"
!define APP_EXECUTABLE_FILENAME "Minnow.exe"
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!macro StartApp
!macroend
!include "${path.join(root, 'build/installer.nsh')}"
!insertmacro customHeader
OutFile "${path.join(dir, 'probe.exe')}"
RequestExecutionLevel user
Section
  !insertmacro StartApp
SectionEnd
`);
      const result = spawnSync(compiler, ['/V2', source], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
