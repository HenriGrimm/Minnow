/**
 * Background execute_command, read_command_log, list_running_commands, stop_command.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { initWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';
import { rmTestHome, setTestHome } from '../config/test-helpers.js';
import {
  createBackgroundRun,
  createRun,
  getRun,
  listActiveRuns,
  readCommandLogSnapshot,
  stopActiveRun,
} from '../../server/terminal-runner.js';
import { toolStopBackgroundCommand } from '../../server/dev-server/manager.js';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { listWslDistros, windowsPathToWslPath } from '../../server/terminal/wsl.js';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
/** Long-running command (platform-specific). */
function longRunningCommand() {
  if (process.platform === 'win32') {
    return 'powershell -NoProfile -Command "Start-Sleep -Seconds 120"';
  }
  return 'sleep 120';
}

function wslLiveReady() {
  if (process.platform !== 'win32') return false;
  try {
    const probeList = spawnSync('wsl.exe', ['-l', '-q'], { timeout: 10_000, encoding: 'utf8' });
    if (probeList.status !== 0) return false;
    const probe = spawnSync(
      'wsl.exe',
      ['--cd', windowsPathToWslPath(repoRoot), '--', 'bash', '-lc', 'test -n "$HOME"'],
      { timeout: 10_000 },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

function wslShellProfile() {
  const { defaultDistro } = listWslDistros();
  return {
    id: defaultDistro ? `wsl:${defaultDistro}` : 'bash',
    label: defaultDistro ? `WSL ${defaultDistro}` : 'WSL',
    shell: 'wsl.exe',
    args: [],
    platform: 'win32',
    runtime: 'wsl',
    distro: defaultDistro ?? undefined,
  };
}

describe('execute_command background lifecycle', () => {
  let homeDir;

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-exec-bg');
    await ensureMinnowLayout();
    await initWorkspaceRoot();
    await setWorkspaceRoot(repoRoot);
  });

  after(async () => {
    await rmTestHome(homeDir);
  });

  it('background spawn returns quickly and stop_command ends the process', async () => {
    const isWin = process.platform === 'win32';
    const command = isWin
      ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 120"'
      : 'sleep 120';

    const started = await createBackgroundRun({
      command,
      cwd: repoRoot,
      shell: isWin,
      source: 'agent',
      logSubdir: 'terminal',
    });

    assert.ok(started.runId);
    const listed = listActiveRuns({ source: 'agent' });
    assert.ok(listed.some((r) => r.runId === started.runId));

    const snapshot = await readCommandLogSnapshot(started.runId);
    assert.equal(snapshot.finished, false);

    const stopped = await stopActiveRun(started.runId);
    assert.equal(stopped.ok, true);

    const after = await readCommandLogSnapshot(started.runId);
    assert.equal(after.finished, true);
  });

  it('applies the required shell sandbox to both agent background entry points', async () => {
    for (const tool of ['execute_command', 'start_background_command']) {
      const { result } = await executeServerTool(tool, {
        command: 'echo sandbox-check', background: true, cwd: '.', allow_unsandboxed: true,
      }, { workspaceRoot: repoRoot, shellSandboxMode: 'require' });
      if (result.startsWith('Error:')) {
        assert.match(result, /shell sandbox is required but unavailable/i);
      } else {
        const started = JSON.parse(result);
        try {
          assert.ok(started.pid);
          assert.equal(getRun(started.runId)?.sandbox?.applied, true);
        } finally {
          await stopActiveRun(started.runId);
        }
      }
    }
  });

  it('honors a stop requested while a foreground command is still starting', async () => {
    const started = await createRun({
      command: longRunningCommand(),
      cwd: repoRoot,
      shell: process.platform === 'win32',
      source: 'agent',
      timeoutMs: 120_000,
    });

    assert.equal(getRun(started.runId)?.child, null);
    const stopped = await stopActiveRun(started.runId);
    assert.equal(stopped.ok, true);
    assert.equal(getRun(started.runId)?.finished, true);
    assert.equal(getRun(started.runId)?.stoppedByUser, true);
  });

  it('executeServerTool background + read_command_log + list_running_commands', async () => {
    const startOut = await executeServerTool('execute_command', {
      command: longRunningCommand(),
      background: true,
      cwd: '.',
    });
    assert.ok(!startOut.result.startsWith('Error'));
    const payload = JSON.parse(startOut.result);
    assert.equal(payload.ok, true);
    assert.equal(payload.background, true);
    assert.ok(payload.runId);

    const listOut = await executeServerTool('list_running_commands', {});
    const listPayload = JSON.parse(listOut.result);
    const listed = listPayload.runs.find((r) => r.runId === payload.runId);
    assert.ok(listed, 'background run should appear in list_running_commands');

    const logOut = await executeServerTool('read_command_log', {
      run_id: payload.runId,
    });
    const logPayload = JSON.parse(logOut.result);
    assert.equal(logPayload.runId, payload.runId);

    const stopOut = await executeServerTool('stop_command', { run_id: payload.runId });
    const stopPayload = JSON.parse(stopOut.result);
    assert.equal(stopPayload.ok, true);
  });

  it('stop_background_command still stops terminal background runs', async () => {
    const isWin = process.platform === 'win32';
    const command = isWin
      ? 'powershell -NoProfile -Command "Start-Sleep -Seconds 90"'
      : 'sleep 90';

    const started = await createBackgroundRun({
      command,
      cwd: repoRoot,
      shell: isWin,
      source: 'agent',
      logSubdir: 'terminal',
    });

    const out = await toolStopBackgroundCommand({ run_id: started.runId });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.runId, started.runId);
  });

  it('WSL background one-shot preserves $HOME expansion', { skip: !wslLiveReady() }, async () => {
    const started = await createBackgroundRun({
      command: 'echo $HOME',
      cwd: repoRoot,
      shell: false,
      source: 'agent',
      logSubdir: 'terminal',
      shellProfile: wslShellProfile(),
    });

    await new Promise((r) => setTimeout(r, 2000));
    const snapshot = await readCommandLogSnapshot(started.runId);
    await stopActiveRun(started.runId);

    const combined = String(snapshot.output ?? '').trim();
    assert.ok(
      combined.startsWith('/'),
      `expected WSL home in log, got: ${combined.slice(0, 120)}`,
    );
  });
});
