import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { applyAgentCliCaptureEnv, wellKnownAgentCliPaths } from '../generations/agent-cli/resolve-bin.js';
import { renameFileWithRetry } from '../runtime/atomic-file.js';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** Match the vendor's versioned install, preserving self-update for custom launchers. */
export function windowsCursorVersionsDir(bin) {
  const [launcher] = wellKnownAgentCliPaths('cursor-agent');
  if (!bin.resolvedBinPath) return null;
  const root = path.dirname(launcher);
  const resolved = path.resolve(bin.resolvedBinPath).toLowerCase();
  if (![launcher, path.join(root, 'agent.cmd')].some(file => file.toLowerCase() === resolved)) return null;
  const versions = path.join(root, 'versions');
  const payload = path.dirname(bin.resolvedCommand);
  if (path.dirname(payload).toLowerCase() !== versions.toLowerCase()
    || path.basename(bin.resolvedCommand).toLowerCase() !== 'node.exe'
    || bin.resolvedArgsPrefix?.[0]?.toLowerCase() !== path.join(payload, 'index.js').toLowerCase()) return null;
  return versions;
}

export async function installWindowsCursorRelease(versionsDir, version, { request, run, signal, parseVersion }) {
  const architecture = os.machine().toLowerCase();
  const arch = { arm64: 'arm64', aarch64: 'arm64', x64: 'x64', x86_64: 'x64', amd64: 'x64' }[architecture];
  if (!arch) throw new Error('Cursor Agent does not provide a Windows package for this architecture.');
  const url = `https://downloads.cursor.com/lab/${version}/windows/${arch}/agent-cli-package.zip`;
  const cwd = await fs.mkdtemp(path.join(versionsDir, '.minnow-update-'));
  try {
    const archive = path.join(cwd, 'agent-cli-package.zip');
    let response;
    try { response = await request(url, { signal, redirect: 'error' }); }
    catch { throw new Error('Could not download the Windows package. Check your connection and retry.'); }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Could not download the Windows package. Check your connection and retry.');
    }
    let bytes = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES) callback(new Error('The Windows package exceeded the download size limit.'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(response.body, limit, createWriteStream(archive, { flags: 'wx' }), { signal });
    } catch (error) {
      if (bytes > MAX_ARCHIVE_BYTES) throw error;
      if (error?.code && error.syscall) throw error;
      throw new Error('Could not save the complete Windows package. Retry the update.');
    }

    const systemDir = process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', systemDir, 'tar.exe');
    const unpacked = await run(tar, ['-xf', archive, 'dist-package'], { cwd, ignoreStdin: true, signal, timeout: 185_000 }).catch(() => null);
    if (unpacked?.code !== 0) throw new Error('Could not unpack the Windows package. Retry the update.');
    const payload = path.join(cwd, 'dist-package');
    const node = path.join(payload, 'node.exe');
    const entry = path.join(payload, 'index.js');
    const verified = await run(node, [entry, '--version'], {
      cwd, env: applyAgentCliCaptureEnv(process.env, node), ignoreStdin: true, signal, timeout: 10_000,
    }).catch(() => null);
    if (verified?.code !== 0 || parseVersion(verified.stdout) !== version) {
      throw new Error('The downloaded Windows package could not report the expected version.');
    }
    // A version directory becomes visible to both launchers only after verification.
    // A competing updater can install the same directory first. The caller rechecks it.
    signal.throwIfAborted();
    await renameFileWithRetry(payload, path.join(versionsDir, version));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
