import os from 'node:os';
import { runProcess } from '../process-runner.js';
import { resolveOneShotSpawn } from '../terminal/one-shot-spawn.js';
import { resolveExecuteShellProfile } from '../terminal/shell-config.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { getRequestAbortSignal } from '../runtime/request-work.js';

const CONNECTIONS = {
  fly: { bins: ['fly', 'flyctl'], check: 'auth whoami' },
  supabase: { bins: ['supabase'], check: 'projects list --output json' },
  clerk: { bins: ['clerk'], check: 'whoami --mode agent --json' },
};

async function runInShell(command, shellProfile) {
  // Use the agent's shell profile, but keep account checks outside the project.
  const cwd = os.homedir();
  const target = resolveOneShotSpawn({
    command: shellProfile?.runtime === 'wsl' ? `cd ~ && ${command}` : command,
    shellProfile,
    cwd,
  });
  const timeout = AbortSignal.timeout(7000);
  const requestSignal = getRequestAbortSignal();
  return runProcess(target.command, target.args, {
    cwd: target.cwd ?? cwd,
    env: target.env,
    shell: target.shell,
    ignoreStdin: true,
    signal: requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout,
  });
}

function commandMissing(result) {
  return result.code === 127 || result.code === 9009 || /is not recognized as an internal or external command/i.test(result.stderr);
}

function signedOut(result) {
  return /not (?:logged in|signed in|authenticated)|unauthenticated|no access token|access token not provided|login required|must be authenticated|\b(?:auth_required|not_logged_in|session_expired)\b/i
    .test(`${result.stdout}\n${result.stderr}`);
}

function authenticationState(id, result) {
  if (result.code !== 0) return signedOut(result) ? 'signed-out' : 'unverified';
  if (id !== 'clerk') return 'connected';
  // Clerk's accountless identity also exits successfully, with a null email.
  const identity = JSON.parse(result.stdout);
  if (typeof identity?.email === 'string' && identity.email.trim()) return 'connected';
  return identity?.email === null ? 'signed-out' : 'unverified';
}

/** Only expose state and the fixed CLI name. CLI output can contain account data. */
export async function probeExternalConnection(id, run = runInShell, shellProfile = null) {
  const { bins, check } = CONNECTIONS[id];
  let unavailable = false;
  for (const bin of bins) {
    try {
      const version = await run(`${bin} --version`, shellProfile);
      if (version.code === 0) {
        try {
          const result = await run(`${bin} ${check}`, shellProfile);
          return { state: authenticationState(id, result), bin };
        } catch {
          return { state: 'unverified', bin };
        }
      }
      if (!commandMissing(version)) unavailable = true;
    } catch {
      unavailable = true;
    }
    if (getRequestAbortSignal()?.aborted) break;
  }
  return { state: unavailable ? 'unavailable' : 'missing' };
}

export async function listExternalConnections() {
  const shellProfile = await resolveExecuteShellProfile(getEffectiveWorkspaceRoot());
  const entries = await Promise.all(Object.keys(CONNECTIONS).map(async (id) =>
    [id, await probeExternalConnection(id, runInShell, shellProfile)],
  ));
  return {
    platform: shellProfile?.runtime === 'wsl' ? 'linux' : process.platform,
    shellProfileId: shellProfile?.id,
    connections: Object.fromEntries(entries),
  };
}
