#!/usr/bin/env node
/**
 * Build tools/minnow-tailnet (the built-in Tailscale node) into
 * resources/bin/<os>-<arch>/, where electron-builder's extraResources picks it
 * up as resources/bin/minnow-tailnet in the packaged app.
 *
 *   node scripts/build-tailnet-sidecar.mjs             # this machine's os/arch
 *   node scripts/build-tailnet-sidecar.mjs --all       # every release target
 *   node scripts/build-tailnet-sidecar.mjs --package   # what a package build on this OS needs
 *
 * Without Go, --package warns and continues locally (Anywhere access then shows
 * "not included in this build") but fails in CI so a release cannot ship without it.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, 'tools', 'minnow-tailnet');
const outRoot = path.join(repoRoot, 'resources', 'bin');

/** electron-builder `${os}`/`${arch}` names → Go GOOS/GOARCH. */
const TARGETS = [
  { os: 'mac', arch: 'arm64', goos: 'darwin', goarch: 'arm64' },
  { os: 'mac', arch: 'x64', goos: 'darwin', goarch: 'amd64' },
  { os: 'win', arch: 'x64', goos: 'windows', goarch: 'amd64' },
  { os: 'win', arch: 'arm64', goos: 'windows', goarch: 'arm64' },
  { os: 'linux', arch: 'x64', goos: 'linux', goarch: 'amd64' },
  { os: 'linux', arch: 'arm64', goos: 'linux', goarch: 'arm64' },
];

function builderOs(platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return 'linux';
}

function log(message) {
  console.log(`[tailnet-sidecar] ${message}`);
}

function hasGo() {
  const result = spawnSync('go', ['version'], { encoding: 'utf8' });
  return result.status === 0;
}

function selectTargets(argv) {
  if (argv.includes('--all')) return TARGETS;
  const os = builderOs();
  if (argv.includes('--package')) return TARGETS.filter((target) => target.os === os);
  return TARGETS.filter((target) => target.os === os && target.arch === process.arch);
}

function build(target) {
  const outDir = path.join(outRoot, `${target.os}-${target.arch}`);
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, target.goos === 'windows' ? 'minnow-tailnet.exe' : 'minnow-tailnet');
  log(`building ${target.os}-${target.arch}`);
  const result = spawnSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, '.'], {
    cwd: sourceDir,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
  });
  if (result.status !== 0) {
    console.error(`[tailnet-sidecar] build failed for ${target.os}-${target.arch}`);
    process.exit(result.status ?? 1);
  }
}

const argv = process.argv.slice(2);
const targets = selectTargets(argv);
// electron-builder needs the folder to exist even when the helper is skipped.
for (const target of targets) fs.mkdirSync(path.join(outRoot, `${target.os}-${target.arch}`), { recursive: true });

if (!hasGo()) {
  const message = 'Go is not installed; skipping the built-in Tailscale helper (Anywhere access will be unavailable).';
  if (argv.includes('--package') && process.env.CI) {
    console.error(`[tailnet-sidecar] ERROR: ${message}`);
    process.exit(1);
  }
  log(message);
  process.exit(0);
}

for (const target of targets) build(target);
log('done');
