#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertRealDirectory(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new Error(`Expected a real release directory at ${directory}. Check the output path before packaging.`);
  }
  return Boolean(stat);
}

function unpackedApplications(root) {
  const release = path.join(root, 'release');
  if (!assertRealDirectory(release)) return [];
  const pkg = path.join(release, 'pkg');
  if (!assertRealDirectory(pkg)) return [];
  return fs.readdirSync(pkg)
    .filter(name => /^(?:(?:win|linux)(?:-[\w-]+)?-unpacked|mac(?:-(?:x64|arm64|universal))?)$/.test(name))
    .map(name => path.join(pkg, name));
}

function runningExecutables() {
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).flatMap(pid => {
      try { return [fs.readlinkSync(`/proc/${pid}/exe`)]; }
      catch { return []; } // Other users' protected processes and processes that have exited.
    });
  }
  const output = process.platform === 'win32'
    // Process.Path can hang while inspecting protected/native processes. CIM
    // supplies executable paths without opening each process's modules.
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object -ExpandProperty ExecutablePath'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    : execFileSync('ps', ['-ww', '-axo', 'comm='], { encoding: 'utf8' });
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function ensureClosed(directories) {
  if (!directories.length) return;
  const executables = runningExecutables().filter(exe => path.isAbsolute(exe)).map(exe => {
    try { return fs.realpathSync.native(exe); }
    catch { return exe; }
  });
  for (const directory of directories) {
    assertRealDirectory(directory);
    const physical = fs.realpathSync.native(directory);
    if (executables.some(exe => {
      const relative = path.relative(physical, exe);
      return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    })) {
      throw new Error(`An app is running from ${directory}. Close that copy and retry packaging.`);
    }
  }
}

/** Builder and release verification use the same stable release/pkg path. */
export function assertReleaseOutputReady(root = repoRoot) {
  ensureClosed(unpackedApplications(root));
}

function removeOutput(directory) {
  assertRealDirectory(directory);
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (err) {
    throw new Error(`Could not clean ${directory}. Close the app or file handles using this output and retry. ${err.message}`);
  }
}

/** Keep the existing Windows packaging cleanup scoped to the builder's own output. */
export function prepareReleaseOutput(root = repoRoot) {
  const directories = unpackedApplications(root);
  ensureClosed(directories);
  const winUnpacked = directories.find(dir => path.basename(dir) === 'win-unpacked');
  if (winUnpacked && process.platform === 'win32') removeOutput(winUnpacked);
}

/** An explicit cleanup also covers other platform targets and the old unpacked path. */
export function cleanRelease(root = repoRoot) {
  const directories = unpackedApplications(root);
  const legacy = path.join(root, 'release', 'win-unpacked');
  if (assertRealDirectory(legacy)) directories.push(legacy);
  ensureClosed(directories);
  for (const directory of directories) removeOutput(directory);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--check') assertReleaseOutputReady();
    else if (!process.argv[2]) cleanRelease();
    else throw new Error('Usage: node scripts/clean-release.mjs [--check]');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
