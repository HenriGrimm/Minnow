#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKED_APP_MARKER, electronBuilderSigningArgs } from './macos-signing-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOut = path.join(repoRoot, 'release', 'pkg');
const winUnpacked = path.join(defaultOut, 'win-unpacked');

// Fail before asar packing if server imports a src/ file not listed in build.files.

const validate = spawnSync('node', ['scripts/validate-packaged-runtime-files.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (validate.status !== 0) process.exit(validate.status ?? 1);

// Scheduled jobs run this bundle in an installed build. Building it here means
// no package script can ship without it, or with a stale one.
const headlessRunner = spawnSync('node', ['scripts/build-headless-runner.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (headlessRunner.status !== 0) process.exit(headlessRunner.status ?? 1);

spawnSync('node', ['scripts/clean-release.mjs'], { cwd: repoRoot, stdio: 'inherit' });

let outputDir = 'release/pkg';
if (fs.existsSync(winUnpacked)) {
  const alt = `release/pkg-${Date.now()}`;
  console.warn(
    `[package] ${path.relative(repoRoot, winUnpacked)} is still present; writing to ${alt}/ instead.`,
  );
  outputDir = alt;
}

const builderArgs = [
  'electron-builder',
  ...process.argv.slice(2),
  `--config.directories.output=${outputDir}`,
  ...electronBuilderSigningArgs(),
  '--publish',
  'never',
];

// ── macOS target retry ───────────────────────────────────────────────────────

const MAC_TARGET_RETRIES = 3;
const MAC_TARGET_RETRY_DELAY_MS = 20_000;

/**
 * Packed .app bundles that finished signing/notarization (marker left by afterSign).
 * @returns {string[]}
 */
function findPackedMacApps() {
  const outAbs = path.join(repoRoot, outputDir);
  if (!fs.existsSync(outAbs)) return [];
  const apps = [];
  for (const entry of fs.readdirSync(outAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(outAbs, entry.name);
    if (!fs.existsSync(path.join(dir, PACKED_APP_MARKER))) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.app')) apps.push(path.join(dir, name));
    }
  }
  return apps;
}

function clearPackedMacMarkers() {
  for (const appPath of findPackedMacApps()) {
    fs.rmSync(path.join(path.dirname(appPath), PACKED_APP_MARKER), { force: true });
  }
}

/**
 * @param {string[]} args
 */
function runBuilder(args) {
  return spawnSync('npx', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

console.log(`[package] Output: ${outputDir}/`);
if (process.platform === 'darwin') clearPackedMacMarkers();
let result = runBuilder(builderArgs);

// hdiutil on hosted macOS runners intermittently fails `create` with "Device not
// configured". The app is already signed and notarized by then, so rebuild only
// the distributable targets from it instead of repeating the whole pack.
if (process.platform === 'darwin' && result.status !== 0) {
  const packedApps = findPackedMacApps();
  if (packedApps.length === 1) {
    for (let attempt = 1; attempt <= MAC_TARGET_RETRIES && result.status !== 0; attempt += 1) {
      console.warn(
        `[package] macOS targets failed after the app was packed; retrying from ${path.relative(repoRoot, packedApps[0])} in ${MAC_TARGET_RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAC_TARGET_RETRIES})…`,
      );
      spawnSync('sleep', [String(MAC_TARGET_RETRY_DELAY_MS / 1000)]);
      result = runBuilder([...builderArgs, '--prepackaged', packedApps[0]]);
    }
  }
}

process.exit(result.status ?? 1);
