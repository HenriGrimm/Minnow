import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';

export const MTPLX_INSTALL_GUIDANCE = 'Install MTPLX using its Mac app, Homebrew, or pip, then refresh. Minnow uses the installed MTPLX runtime to start local servers.';
export const defaultMtplxCacheDir = () => path.join(os.homedir(), '.mtplx', 'models');

export function isMtplxSupported(platform = process.platform, arch = process.arch, release = os.release()) {
  return platform === 'darwin' && arch === 'arm64' && Number.parseInt(release, 10) >= 23;
}

async function executable(candidate) {
  try {
    await fsp.access(candidate, process.platform === 'win32' ? 0 : 1);
    return true;
  } catch { return false; }
}

async function usesAppRuntime(candidate, appRuntime, appPath) {
  try {
    const real = await fsp.realpath(candidate);
    if (real === appRuntime || (appPath && real.startsWith(appPath + path.sep))) return true;
    // The Mac app installs a small shell launcher under ~/.mtplx/bin.
    if ((await fsp.stat(real)).size > 4096) return false;
    const script = await fsp.readFile(real, 'utf8');
    return script.startsWith('#!') && script.includes(`exec '${appRuntime}'`);
  } catch { return false; }
}

export async function discoverMtplxInstallations(home = os.homedir(), applications = '/Applications') {
  const userBinary = path.join(home, '.mtplx', 'bin', 'mtplx');
  const appRuntime = path.join(home, 'Library', 'Application Support', 'MTPLX', 'runtime-venv', 'bin', 'mtplx');
  let appPath = null;
  for (const folder of [applications, path.join(home, 'Applications')]) {
    const candidate = path.join(folder, 'MTPLX.app');
    if (await fsp.access(path.join(candidate, 'Contents', 'Info.plist')).then(() => true, () => false)) {
      appPath = candidate;
      break;
    }
  }
  let pathBinary = null;
  try {
    const result = await runProcess(process.platform === 'win32' ? 'where' : 'which', ['mtplx'], { timeout: 3_000 });
    if (result.code === 0 && result.stdout.trim()) pathBinary = result.stdout.trim().split(/\r?\n/)[0];
  } catch {}
  const candidates = [[pathBinary, 'path'], [userBinary, 'user'], [appRuntime, 'app']];
  if (appPath) candidates.push([path.join(appPath, 'Contents', 'Resources', 'runtime', 'bin', 'mtplx'), 'app']);
  const selected = [];
  for (const [candidate, source] of candidates) {
    if (!candidate || selected.some((entry) => entry.path === candidate) || (source !== 'path' && !await executable(candidate))) continue;
    const fromApp = source === 'app' || await usesAppRuntime(candidate, appRuntime, appPath);
    selected.push({ path: candidate, source: fromApp ? 'app' : source });
  }
  return { candidates: selected, appPath };
}

export async function runMtplxJson(args, opts = {}) {
  const binary = opts.binary ?? (await getMtplxStatus()).path;
  if (!binary) throw new Error(MTPLX_INSTALL_GUIDANCE);
  const result = await runProcess(binary, args, { timeout: opts.timeout ?? 15_000 });
  const describesUnsupportedModel = args[0] === 'inspect' || (args[0] === 'tune' && args.includes('--dry-run'));
  if (result.timedOut || (result.code !== 0 && !describesUnsupportedModel && args[0] !== 'status')) throw new Error(result.stderr?.trim() || `MTPLX exited with code ${result.code}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('MTPLX returned invalid JSON'); }
}

let cached = null;
let pending = null;
export async function getMtplxStatus() {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const { candidates, appPath } = await discoverMtplxInstallations();
    const supported = isMtplxSupported();
    let resolved = supported ? null : candidates[0];
    let version = null, hardware = null, cacheDir = defaultMtplxCacheDir();
    let launchEffortLevels;
    let appVersion = null;
    if (appPath && supported) {
      const result = await runProcess('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')], { timeout: 3_000 }).catch(() => null);
      if (result?.code === 0) appVersion = result.stdout.trim() || null;
    }
    if (supported) {
      for (const candidate of candidates) {
        const result = await runProcess(candidate.path, ['--version'], { timeout: 5_000 }).catch(() => null);
        if (result?.code !== 0 || !result.stdout.trim()) continue;
        resolved = candidate;
        version = result.stdout.trim().replace(/^mtplx\s+/i, '');
        break;
      }
    }
    if (resolved && supported) {
      const results = await Promise.allSettled([
        runMtplxJson(['hardware', '--json'], { binary: resolved.path }),
        runMtplxJson(['models', '--json'], { binary: resolved.path }),
        runProcess(resolved.path, ['serve', '--help'], { timeout: 5_000 }),
      ]);
      if (results[0].status === 'fulfilled') hardware = results[0].value;
      if (results[1].status === 'fulfilled' && typeof results[1].value?.cache_dir === 'string') cacheDir = results[1].value.cache_dir;
      if (results[2].status === 'fulfilled' && results[2].value.code === 0) {
        launchEffortLevels = results[2].value.stdout.match(/--reasoning-effort\s+\{([^}]+)\}/)?.[1].split(',').map((level) => level.trim()) ?? [];
      }
    }
    const value = { path: null, source: null, ...resolved, version, hardware, cacheDir, appPath, appVersion, launchEffortLevels, installed: Boolean(resolved),
      supported, available: supported, installable: false,
      reason: !supported ? 'MTPLX requires Apple Silicon and macOS 14 or newer.' :
        !resolved && appPath ? 'Open the MTPLX Mac app to finish setting up its runtime, then refresh.' : !resolved ? MTPLX_INSTALL_GUIDANCE : null };
    cached = { at: Date.now(), value };
    return value;
  })();
  try { return await pending; } finally { pending = null; }
}

export async function getMtplxDiagnostics() {
  const result = await runMtplxJson(['status', '--json']);
  return result.diagnostics?.checks ?? result.checks ?? [];
}

/** Explicit user refresh must see external installs/upgrades, not the minute cache. */
export async function refreshMtplxStatus() {
  if (pending) await pending;
  cached = null;
  return getMtplxStatus();
}
