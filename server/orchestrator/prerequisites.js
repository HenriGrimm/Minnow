/** Validated, read-only recovery probes. Never execute a model-supplied command. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { detectAgentCli, verifyAgentCliAuth } from '../models/agent-cli-detect.js';
import { getProviderRuntime } from '../providers/store.js';
import { probeBrowserCapability } from '../browser-driver/index.js';
import { resolveVerificationEnv } from './verification-env.js';

export function normalizePrerequisites(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error('prerequisites must contain at most 16 read-only checks');
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid prerequisite');
    if (item.kind === 'file' && typeof item.path === 'string' && item.path.length <= 1024 && !path.isAbsolute(item.path) && !/^[a-z]:|(^|[\\/])(?:\.\.|\.git)([\\/]|$)|\0/i.test(item.path)) return { kind: 'file', path: item.path };
    if (item.kind === 'executable' && typeof item.name === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(item.name)) return { kind: 'executable', name: item.name };
    if (item.kind === 'service' && Number.isSafeInteger(item.port) && item.port > 0 && item.port <= 65535) return { kind: 'service', port: item.port };
    if (item.kind === 'browser') return { kind: 'browser' };
    if (item.kind === 'agent_cli' && typeof item.providerId === 'string' && item.providerId.length <= 100) return { kind: 'agent_cli', providerId: item.providerId, auth: item.auth === true };
    throw new Error('Prerequisite must be a workspace-relative file, executable name, loopback service port, browser or configured agent_cli provider');
  });
}

export async function prerequisitesReady(value, cwd) {
  const items = normalizePrerequisites(value);
  if (!items.length) return false;
  let executableEnv;
  for (const item of items) {
    if (item.kind === 'file') {
      const root = await fs.realpath(cwd);
      const file = await fs.realpath(path.resolve(root, item.path)).catch(() => null);
      const relative = file && path.relative(root, file);
      if (!file || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    } else if (item.kind === 'executable') {
      executableEnv ??= await resolveVerificationEnv(cwd);
      const pathKey = Object.keys(executableEnv).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
      const extensions = process.platform === 'win32' ? (executableEnv.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [];
      let found = false;
      for (const directory of (executableEnv[pathKey] || '').split(path.delimiter)) {
        const resolved = path.resolve(cwd, directory);
        for (const extension of ['', ...extensions]) {
          try {
            const file = path.join(resolved, `${item.name}${extension}`);
            if (!(await fs.stat(file)).isFile()) continue;
            await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            found = true;
            break;
          } catch {}
        }
        if (found) break;
      }
      if (!found) return false;
    } else if (item.kind === 'service') {
      const ready = await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: item.port });
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.setTimeout(1500, () => done(false));
        socket.once('error', () => done(false));
        socket.once('connect', () => done(true));
      });
      if (!ready) return false;
    } else if (item.kind === 'browser') {
      if (!(await probeBrowserCapability()).available) return false;
    } else {
      const { profile, secrets } = await getProviderRuntime(item.providerId);
      if (profile.apiKind !== 'agent-cli-v1') return false;
      const options = { binPath: profile.agentCli.binPath, cliToken: secrets.cliToken, fresh: true };
      const status = await (item.auth ? verifyAgentCliAuth : detectAgentCli)(profile.agentCli.kind, options);
      if (!status.installed || item.auth && !['signed-in', 'authenticated', 'token'].includes(status.authStatus)) return false;
    }
  }
  return true;
}

export function prerequisiteError(message, prerequisites, category = 'prerequisite') {
  return Object.assign(new Error(message), { failure: { category, prerequisites: normalizePrerequisites(prerequisites) } });
}
