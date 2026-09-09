#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const renameScript = path.join(repoRoot, 'scripts', 'rename-preload-mjs.mjs');

/**
 * Unpackaged `electron electron/dist/main.js` has no nearby package.json, so
 * Electron reads the FileVersion rcedit stamped on electron.exe (often stale).
 * Write a tiny stub next to main.js so app.getVersion() matches the repo.
 */
export function writeElectronDistPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const distDir = path.join(repoRoot, 'electron', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const stub = {
    name: typeof pkg.name === 'string' ? pkg.name : 'minnow',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    private: true,
    main: 'main.js',
  };
  fs.writeFileSync(path.join(distDir, 'package.json'), `${JSON.stringify(stub, null, 2)}\n`);
}

/**
 * @param {{ stdio?: 'inherit' | 'pipe' | 'ignore' }} [options]
 */
export function buildElectronMain(options = {}) {
  const stdio = options.stdio ?? 'inherit';

  if (!fs.existsSync(tscBin)) {
    throw new Error('TypeScript is not installed. Run: npm install');
  }

  const compile = spawnSync(process.execPath, [tscBin, '-p', 'electron/tsconfig.json'], {
    cwd: repoRoot,
    stdio,
    env: process.env,
  });
  if (compile.status !== 0) {
    throw new Error(`Electron compile failed (exit ${compile.status ?? 'unknown'})`);
  }

  const rename = spawnSync(process.execPath, [renameScript], {
    cwd: repoRoot,
    stdio,
    env: process.env,
  });
  if (rename.status !== 0) {
    throw new Error(`Electron preload rename failed (exit ${rename.status ?? 'unknown'})`);
  }

  writeElectronDistPackageJson();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    buildElectronMain();
  } catch (err) {
    console.error('[build-electron]', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
