import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';

export const MTPLX_INSTALL_GUIDANCE = 'Install MTPLX on Apple Silicon with pip install --upgrade mtplx, then refresh. Minnow uses your existing MTPLX installation.';
export const defaultMtplxCacheDir = () => path.join(os.homedir(), '.mtplx', 'models');

export function isMtplxSupported(platform = process.platform, arch = process.arch, release = os.release()) {
  return platform === 'darwin' && arch === 'arm64' && Number.parseInt(release, 10) >= 23;
}

export async function resolveMtplxBinary() {
  try {
    const result = await runProcess(process.platform === 'win32' ? 'where' : 'which', ['mtplx'], { timeout: 3_000 });
    if (result.code === 0 && result.stdout.trim()) return { path: result.stdout.trim().split(/\r?\n/)[0], source: 'path' };
  } catch {}
  for (const [candidate, source] of [
    [path.join(os.homedir(), '.mtplx', 'bin', 'mtplx'), 'user'],
    ['/Applications/MTPLX.app/Contents/Resources/runtime/bin/mtplx', 'app'],
  ]) {
    try {
      await fsp.access(candidate, process.platform === 'win32' ? 0 : 1);
      return { path: candidate, source };
    } catch {}
  }
  return { path: null, source: null };
}

export async function runMtplxJson(args, opts = {}) {
  const binary = opts.binary ?? (await resolveMtplxBinary()).path;
  if (!binary) throw new Error(MTPLX_INSTALL_GUIDANCE);
  const result = await runProcess(binary, args, { timeout: opts.timeout ?? 15_000 });
  if (result.timedOut || (result.code !== 0 && !['inspect', 'status'].includes(args[0]))) throw new Error(result.stderr?.trim() || `MTPLX exited with code ${result.code}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('MTPLX returned invalid JSON'); }
}

let cached = null;
let pending = null;
export async function getMtplxStatus() {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const resolved = await resolveMtplxBinary();
    const supported = isMtplxSupported();
    let version = null, hardware = null, cacheDir = defaultMtplxCacheDir();
    if (resolved.path && supported) {
      const results = await Promise.allSettled([
        runProcess(resolved.path, ['--version'], { timeout: 5_000 }),
        runMtplxJson(['hardware', '--json'], { binary: resolved.path }),
        runMtplxJson(['models', '--json'], { binary: resolved.path }),
      ]);
      if (results[0].status === 'fulfilled' && results[0].value.code === 0) version = results[0].value.stdout.trim();
      if (results[1].status === 'fulfilled') hardware = results[1].value;
      if (results[2].status === 'fulfilled' && typeof results[2].value.cache_dir === 'string') cacheDir = results[2].value.cache_dir;
    }
    const value = { ...resolved, version, hardware, cacheDir, installed: Boolean(resolved.path),
      supported, available: supported, installable: false,
      reason: !supported ? 'MTPLX requires Apple Silicon and macOS 14 or newer.' : !resolved.path ? MTPLX_INSTALL_GUIDANCE : null };
    cached = { at: Date.now(), value };
    return value;
  })();
  try { return await pending; } finally { pending = null; }
}

export async function getMtplxDiagnostics() {
  const result = await runMtplxJson(['status', '--json']);
  return result.diagnostics?.checks ?? result.checks ?? [];
}
