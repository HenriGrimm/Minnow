#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildElectronMain, writeElectronDistPackageJson } from './build-electron.mjs';
import { resolveMinnowPort } from '../server/constants/minnow-port.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function electronPackageDir() {
  return path.join(repoRoot, 'node_modules', 'electron');
}

function electronBinaryPath() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

function electronDistBinaryPath() {
  const electronDir = electronPackageDir();
  if (process.platform === 'win32') {
    return path.join(electronDir, 'dist', 'electron.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  }
  return path.join(electronDir, 'dist', 'electron');
}

function electronInstallError() {
  const electronDir = electronPackageDir();
  if (!fs.existsSync(electronDir)) {
    const productionHint =
      process.env.NODE_ENV === 'production' ? ' or `npm install electron` if using `--omit=dev`' : '';
    return new Error(`Electron is not installed. Run: npm install${productionHint}`);
  }

  return new Error(
    'Electron binary not downloaded. Run: npm install (re-runs postinstall) or `node scripts/ensure-electron.mjs`',
  );
}

function mainJsPath() {
  return path.join(repoRoot, 'electron', 'dist', 'main.js');
}

function preloadMjsPath() {
  return path.join(repoRoot, 'electron', 'dist', 'preload.mjs');
}

function electronOutputsExist() {
  return fs.existsSync(mainJsPath()) && fs.existsSync(preloadMjsPath());
}

function electronSourceFiles() {
  const electronDir = path.join(repoRoot, 'electron');
  try {
    return fs
      .readdirSync(electronDir, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith('.ts') || e.name === 'tsconfig.json'))
      .map((e) => path.join(electronDir, e.name));
  } catch {
    return [];
  }
}

function newestMtimeMs(files) {
  let newest = 0;
  for (const file of files) {
    try {
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs > newest) newest = mtimeMs;
    } catch {
    }
  }
  return newest;
}

export function isElectronBuildFresh() {
  if (!electronOutputsExist()) return false;
  let outMtime;
  try {
    outMtime = Math.min(
      fs.statSync(mainJsPath()).mtimeMs,
      fs.statSync(preloadMjsPath()).mtimeMs,
    );
  } catch {
    return false;
  }
  return newestMtimeMs(electronSourceFiles()) <= outMtime;
}

export async function ensureElectronBuild() {
  if (isElectronBuildFresh()) return;
  const reason = electronOutputsExist() ? 'sources changed' : 'first run';
  console.log(`[electron] Compiling main process (${reason})…`);
  await Promise.resolve().then(() => buildElectronMain());
  if (!electronOutputsExist()) {
    throw new Error('Electron build incomplete. Run npm run electron:build.');
  }
}

/**
 * @param {{ port?: number | string, devUrl?: string, dev?: boolean, foreground?: boolean }} options
 * @returns {import('node:child_process').ChildProcess | null}
 */
export async function spawnElectronShell(options = {}) {
  const port = String(options.port ?? resolveMinnowPort());
  const devUrl = (options.devUrl ?? `http://localhost:${port}/`).replace(/\/?$/, '/');
  const dev = options.dev !== false;
  const foreground = options.foreground === true;

  const electronBin = electronBinaryPath();
  const electronDist = electronDistBinaryPath();
  if (!electronBin || !fs.existsSync(electronBin) || !fs.existsSync(electronDist)) {
    throw electronInstallError();
  }

  await ensureElectronBuild();
  writeElectronDistPackageJson();

  const mainJs = mainJsPath();
  const env = {
    ...process.env,
    PORT: port,
    MINNOW_DEV_URL: devUrl,
    MINNOW_ELECTRON: '1',
    MINNOW_ELECTRON_DEV: dev ? '1' : '0',
  };

  const args = [mainJs];
  const child = spawn(electronBin, args, {
    cwd: repoRoot,
    env,
    stdio: foreground ? 'inherit' : 'ignore',
    detached: !foreground,
    windowsHide: false,
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

  if (!foreground) {
    child.unref();
  }

  return child;
}
