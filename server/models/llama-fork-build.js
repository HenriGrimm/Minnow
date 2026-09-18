/**
 * Install llama.cpp forks: download a fork's ggml-style release assets when it
 * publishes them, otherwise build `llama-server` from source with the user's
 * cmake / compiler / CUDA toolchain. Minnow checks for the toolchain but never
 * installs it.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { killProcessTree } from '../terminal-runner.js';
import {
  assertArchiveDigest,
  binaryFileName,
  clearLlamaBinaryProbeCaches,
  copyExtractedBinaries,
  copyFlattenedExtractContents,
  downloadToFile,
  extractArchive,
  findBinaryInDir,
  findExtractedBinary,
  llamaServerPeArchMismatch,
} from './llama-runtime.js';
import { githubReleaseHeaders, mapApiReleaseAssets, resolveLlamaAssets } from './llama-variant.js';
import {
  backendCmakeFlag,
  getForkBinDir,
  getForkMetaPath,
  getForkRoot,
} from './llama-forks-catalog.js';

/** @typedef {import('./llama-forks-catalog.js').ForkDef} ForkDef */

const BUILD_TIMEOUT_MS = 90 * 60_000;
const LOG_TAIL_LINES = 400;
const EMIT_MS = 250;

// ── Tool discovery ───────────────────────────────────────────────────────────

/**
 * @param {string} cmd
 * @returns {Promise<string | null>}
 */
async function which(cmd) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { code, stdout } = await runProcess(finder, [cmd], { timeout: 5_000 });
    if (code === 0 && stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
  } catch {
    /* not found */
  }
  return null;
}

/** Visual Studio install root with the C++ workload, via vswhere. */
async function findVisualStudio() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  try {
    const { code, stdout } = await runProcess(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      { timeout: 10_000 },
    );
    const root = stdout.trim().split(/\r?\n/)[0];
    return code === 0 && root ? root : null;
  } catch {
    return null;
  }
}

/**
 * cmake on PATH, else the copy Visual Studio ships with.
 * @param {string | null} vsRoot
 */
async function findCmake(vsRoot) {
  const onPath = await which('cmake');
  if (onPath) return onPath;
  if (vsRoot) {
    const bundled = path.join(
      vsRoot,
      'Common7',
      'IDE',
      'CommonExtensions',
      'Microsoft',
      'CMake',
      'CMake',
      'bin',
      'cmake.exe',
    );
    if (fs.existsSync(bundled)) return bundled;
  }
  return null;
}

async function findNvcc() {
  const cudaPath = process.env.CUDA_PATH;
  if (cudaPath) {
    const nvcc = path.join(cudaPath, 'bin', process.platform === 'win32' ? 'nvcc.exe' : 'nvcc');
    if (fs.existsSync(nvcc)) return nvcc;
  }
  const onPath = await which('nvcc');
  if (onPath) return onPath;
  if (process.platform === 'linux' && fs.existsSync('/usr/local/cuda/bin/nvcc')) {
    return '/usr/local/cuda/bin/nvcc';
  }
  return null;
}

async function findCompiler() {
  if (process.platform === 'darwin') {
    try {
      const { code, stdout } = await runProcess('xcrun', ['--find', 'clang++'], { timeout: 10_000 });
      if (code === 0 && stdout.trim()) return stdout.trim();
    } catch {
      /* no Xcode CLT */
    }
    return null;
  }
  return (await which('c++')) ?? (await which('g++')) ?? (await which('clang++'));
}

/**
 * @typedef {{ tool: string, hint: string, url: string }} MissingTool
 * @typedef {{ ok: boolean, missing: MissingTool[], cmake: string | null, nvcc: string | null, compiler: string | null }} BuildPrereqs
 */

/**
 * @param {ForkDef} fork
 * @returns {Promise<BuildPrereqs>}
 */
export async function checkBuildPrereqs(fork) {
  const vsRoot = process.platform === 'win32' ? await findVisualStudio() : null;
  const [cmake, compiler, nvcc] = await Promise.all([
    findCmake(vsRoot),
    process.platform === 'win32' ? Promise.resolve(vsRoot) : findCompiler(),
    fork.backend === 'cuda' ? findNvcc() : Promise.resolve(null),
  ]);

  /** @type {MissingTool[]} */
  const missing = [];
  if (!compiler) {
    missing.push(
      process.platform === 'win32'
        ? {
            tool: 'Visual Studio Build Tools',
            hint: 'Install the "Desktop development with C++" workload.',
            url: 'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
          }
        : process.platform === 'darwin'
          ? {
              tool: 'Xcode Command Line Tools',
              hint: 'Run xcode-select --install.',
              url: 'https://developer.apple.com/xcode/resources/',
            }
          : {
              tool: 'C++ compiler',
              hint: 'Install build-essential (or your distro’s g++).',
              url: 'https://gcc.gnu.org/',
            },
    );
  }
  if (!cmake) {
    missing.push({
      tool: 'CMake',
      hint: 'Install CMake 3.21 or newer and put it on PATH.',
      url: 'https://cmake.org/download/',
    });
  }
  if (fork.backend === 'cuda' && !nvcc) {
    missing.push({
      tool: 'CUDA Toolkit',
      hint:
        process.platform === 'win32'
          ? 'Install the CUDA Toolkit after Visual Studio so its build integration is registered.'
          : 'Install the CUDA Toolkit so nvcc is available.',
      url: 'https://developer.nvidia.com/cuda-downloads',
    });
  }
  return { ok: missing.length === 0, missing, cmake, nvcc, compiler };
}

// ── GPU / CUDA arch ──────────────────────────────────────────────────────────

/**
 * `nvidia-smi --query-gpu=compute_cap` rows → `["86", "120"]`.
 * @param {string} text
 * @returns {string[]}
 */
export function parseComputeCaps(text) {
  const caps = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\.(\d+)$/);
    if (m) caps.add(`${m[1]}${m[2]}`);
  }
  return [...caps].sort((a, b) => Number(a) - Number(b));
}

/** @returns {Promise<string[]>} */
export async function detectCudaComputeCaps() {
  try {
    const { code, stdout } = await runProcess(
      'nvidia-smi',
      ['--query-gpu=compute_cap', '--format=csv,noheader'],
      { timeout: 10_000 },
    );
    return code === 0 ? parseComputeCaps(stdout) : [];
  } catch {
    return [];
  }
}

/**
 * Whether this host can run the fork at all (before any toolchain question).
 * @param {ForkDef} fork
 * @param {{ computeCaps?: string[] }} [probe]
 * @returns {Promise<{ supported: boolean, reason: string | null, computeCaps: string[] }>}
 */
export async function checkForkSupport(fork, probe = {}) {
  if (fork.backend === 'metal' && !(process.platform === 'darwin' && process.arch === 'arm64')) {
    return { supported: false, reason: 'Metal builds need an Apple Silicon Mac.', computeCaps: [] };
  }
  if (fork.backend === 'rocm' && process.platform !== 'linux') {
    return { supported: false, reason: 'ROCm builds need Linux.', computeCaps: [] };
  }
  if (fork.backend !== 'cuda') return { supported: true, reason: null, computeCaps: [] };
  if (process.platform === 'darwin') {
    return { supported: false, reason: 'CUDA builds need an NVIDIA GPU; Macs have none.', computeCaps: [] };
  }
  const computeCaps = probe.computeCaps ?? (await detectCudaComputeCaps());
  if (!computeCaps.length) {
    return { supported: false, reason: 'No NVIDIA GPU detected (nvidia-smi found nothing).', computeCaps };
  }
  if (fork.minCudaSm) {
    const best = Math.max(...computeCaps.map(Number));
    if (best < fork.minCudaSm) {
      const need = `${Math.floor(fork.minCudaSm / 10)}.${fork.minCudaSm % 10}`;
      return {
        supported: false,
        reason: `Needs an NVIDIA GPU with compute capability ${need} or newer (RTX 30-series and up).`,
        computeCaps,
      };
    }
  }
  return { supported: true, reason: null, computeCaps };
}

// ── cmake argv ───────────────────────────────────────────────────────────────

/**
 * @param {ForkDef} fork
 * @param {{ sourceDir: string, buildDir: string, computeCaps?: string[], jobs?: number, platform?: NodeJS.Platform }} opts
 * @returns {{ configure: string[], build: string[] }}
 */
export function buildCmakeArgs(fork, opts) {
  const platform = opts.platform ?? process.platform;
  const flags = [...(fork.platformCmakeFlags?.[platform] ?? []), ...fork.cmakeFlags];
  const has = (name) => flags.some((f) => f.startsWith(`-D${name}=`) || f.startsWith(`-D${name}:`));
  const backendFlag = backendCmakeFlag(fork.backend);
  if (backendFlag && !has(backendFlag.slice(2).split('=')[0])) flags.unshift(backendFlag);
  if (fork.backend === 'cuda' && !has('CMAKE_CUDA_ARCHITECTURES')) {
    const caps = opts.computeCaps?.length ? opts.computeCaps.join(';') : 'native';
    flags.push(`-DCMAKE_CUDA_ARCHITECTURES=${caps}`);
  }
  for (const [name, value] of [
    ['CMAKE_BUILD_TYPE', 'Release'],
    ['LLAMA_BUILD_TESTS', 'OFF'],
    ['LLAMA_BUILD_EXAMPLES', 'OFF'],
    ['LLAMA_CURL', 'OFF'],
    ['BUILD_SHARED_LIBS', 'OFF'],
  ]) {
    if (!has(name)) flags.push(`-D${name}=${value}`);
  }
  const jobs = Math.max(1, Math.trunc(opts.jobs ?? (os.availableParallelism?.() ?? os.cpus().length)));
  return {
    configure: ['-S', opts.sourceDir, '-B', opts.buildDir, ...flags],
    build: [
      '--build',
      opts.buildDir,
      '--config',
      'Release',
      '--target',
      'llama-server',
      '--parallel',
      String(jobs),
    ],
  };
}

/**
 * Best-effort percent from a cmake build line (`[ 45%]` Makefiles, `[12/340]` Ninja).
 * @param {string} line
 * @returns {number | null}
 */
export function parseBuildProgress(line) {
  const pct = line.match(/^\[\s*(\d{1,3})%\]/);
  if (pct) return Math.min(100, Number(pct[1]));
  const ninja = line.match(/^\[(\d+)\/(\d+)\]/);
  if (ninja && Number(ninja[2]) > 0) return Math.round((Number(ninja[1]) / Number(ninja[2])) * 100);
  return null;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/** @type {Map<string, { at: number, value: unknown }>} */
const githubCache = new Map();
const GITHUB_CACHE_MS = 30 * 60_000;

/**
 * @param {string} url
 */
async function githubJson(url) {
  const hit = githubCache.get(url);
  if (hit && Date.now() - hit.at < GITHUB_CACHE_MS) return hit.value;
  const res = await fetch(url, { headers: githubReleaseHeaders() });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${url.replace('https://api.github.com', '')}`);
  const value = await res.json();
  githubCache.set(url, { at: Date.now(), value });
  return value;
}

/**
 * @param {string} repo
 * @param {string} ref
 * @returns {Promise<string>}
 */
export async function resolveCommit(repo, ref) {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const body = /** @type {{ sha?: string }} */ (
    await githubJson(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)
  );
  if (!body?.sha) throw new Error(`Could not resolve ${repo}@${ref}`);
  return body.sha;
}

/**
 * Commits on `branch` that `sha` does not have, or null when GitHub is unreachable.
 * @param {string} repo
 * @param {string} sha
 * @param {string} branch
 * @returns {Promise<number | null>}
 */
export async function commitsBehind(repo, sha, branch) {
  try {
    const body = /** @type {{ ahead_by?: number }} */ (
      await githubJson(
        `https://api.github.com/repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}`,
      )
    );
    return typeof body?.ahead_by === 'number' ? body.ahead_by : null;
  } catch {
    return null;
  }
}

/**
 * Default branch for a custom fork with no ref.
 * @param {string} repo
 */
async function defaultBranch(repo) {
  const body = /** @type {{ default_branch?: string }} */ (
    await githubJson(`https://api.github.com/repos/${repo}`)
  );
  return body?.default_branch || 'master';
}

/**
 * ggml-style release assets for a custom fork, when it publishes them.
 * @param {ForkDef} fork
 */
async function findForkReleaseAssets(fork) {
  if (fork.origin !== 'custom' || fork.source !== 'github' || !fork.repo) return null;
  const url = fork.ref
    ? `https://api.github.com/repos/${fork.repo}/releases/tags/${encodeURIComponent(fork.ref)}`
    : `https://api.github.com/repos/${fork.repo}/releases/latest`;
  let release;
  try {
    release = /** @type {{ tag_name?: string }} */ (await githubJson(url));
  } catch {
    return null;
  }
  const tag = release?.tag_name;
  if (!tag) return null;
  const assets = mapApiReleaseAssets(release);
  const variants =
    fork.backend === 'cuda' ? ['cuda-12.4', 'cuda-13'] : fork.backend === 'cpu' ? ['cpu'] : [fork.backend];
  for (const variant of variants) {
    try {
      const picked = resolveLlamaAssets({ variant: /** @type {any} */ (variant), tag, assets });
      return { tag, assets, ...picked };
    } catch {
      /* try the next variant */
    }
  }
  return null;
}

// ── Build job ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ForkBuildJob
 * @property {string} engineId
 * @property {'checking' | 'downloading' | 'configuring' | 'building' | 'installing' | 'completed' | 'failed' | 'cancelled'} phase
 * @property {number} percent
 * @property {string} message
 * @property {string | null} error
 * @property {string[]} logTail
 * @property {string | null} sha
 * @property {number} startedAt
 */

/** @type {ForkBuildJob | null} */
let job = null;
/** @type {Set<(job: ForkBuildJob) => void>} */
const listeners = new Set();
let lastEmitAt = 0;
/** @type {{ cancelled: boolean, child: import('node:child_process').ChildProcess | null } | null} */
let active = null;

function emit(force = false) {
  if (!job) return;
  const now = Date.now();
  if (!force && now - lastEmitAt < EMIT_MS) return;
  lastEmitAt = now;
  for (const listener of listeners) {
    try {
      listener(job);
    } catch {
      /* listener errors never break the build */
    }
  }
}

/** @param {Partial<ForkBuildJob>} patch */
function patchJob(patch, force = false) {
  if (!job) return;
  job = { ...job, ...patch };
  emit(force || patch.phase !== undefined);
}

/** @param {string} text */
function appendLog(text) {
  if (!job) return;
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return;
  const logTail = [...job.logTail, ...lines].slice(-LOG_TAIL_LINES);
  let percent = job.percent;
  if (job.phase === 'building') {
    for (const line of lines) {
      const p = parseBuildProgress(line);
      if (p != null) percent = 20 + Math.round(p * 0.75);
    }
  }
  job = { ...job, logTail, percent };
  emit();
}

/** @returns {ForkBuildJob | null} */
export function getForkBuildJob() {
  return job;
}

/**
 * @param {(job: ForkBuildJob) => void} listener
 * @returns {() => void}
 */
export function subscribeForkBuild(listener) {
  if (job) listener(job);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isForkBuildRunning() {
  return Boolean(active);
}

/** Stop the running build; the job ends as `cancelled`. */
export function cancelForkBuild() {
  if (!active) return false;
  active.cancelled = true;
  if (active.child) killProcessTree(active.child);
  return true;
}

export function resetForkBuildForTests() {
  job = null;
  active = null;
  listeners.clear();
  githubCache.clear();
}

class BuildCancelled extends Error {}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {(line: string) => void} log
 */
async function runStep(command, args, cwd, log) {
  if (active?.cancelled) throw new BuildCancelled('Build cancelled');
  log(`$ ${path.basename(command)} ${args.join(' ')}`);
  const result = await runProcess(command, args, {
    cwd,
    timeout: BUILD_TIMEOUT_MS,
    onStdout: log,
    onStderr: log,
    onSpawn: (child) => {
      if (active) active.child = child;
    },
    killTree: killProcessTree,
  });
  if (active) active.child = null;
  if (active?.cancelled) throw new BuildCancelled('Build cancelled');
  if (result.code !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.code}`);
  }
}

/**
 * Replace the fork's `bin/` with the files next to a freshly built/extracted llama-server.
 * @param {string} forkId
 * @param {string} searchDir
 * @param {string | null} companionDir
 */
async function installBinaries(forkId, searchDir, companionDir) {
  const binDir = getForkBinDir(forkId);
  const staging = `${binDir}.new`;
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  if (companionDir) await copyFlattenedExtractContents(companionDir, staging);
  await copyExtractedBinaries(searchDir, staging);
  const installed = findBinaryInDir(staging);
  if (!installed) throw new Error('llama-server is missing from the build output');
  if (llamaServerPeArchMismatch(installed)) {
    throw new Error('The built llama-server does not match this machine’s CPU architecture');
  }
  await fsp.rm(binDir, { recursive: true, force: true });
  await fsp.rename(staging, binDir);
  return path.join(binDir, path.basename(installed));
}

/**
 * Build (or download) a fork into `llama-forks/<id>/bin`. One at a time.
 * @param {ForkDef} fork
 * @param {{ target?: 'pinned' | 'head' }} [opts]
 * @returns {Promise<ForkBuildJob>} resolves once the job has started
 */
export async function startForkBuild(fork, opts = {}) {
  if (fork.source === 'local') throw new Error('Local forks use an existing binary; there is nothing to build');
  if (active) throw new Error('Another llama.cpp build is already running');
  active = { cancelled: false, child: null };
  job = {
    engineId: fork.id,
    phase: 'checking',
    percent: 0,
    message: 'Checking this machine',
    error: null,
    logTail: [],
    sha: null,
    startedAt: Date.now(),
  };
  emit(true);
  void runForkBuild(fork, opts.target ?? 'pinned');
  return job;
}

/**
 * @param {ForkDef} fork
 * @param {'pinned' | 'head'} target
 */
async function runForkBuild(fork, target) {
  const root = getForkRoot(fork.id);
  const workDir = path.join(root, 'work');
  const logDir = path.join(root, 'build-logs');
  const logPath = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  /** @type {string[]} */
  const fullLog = [];
  const log = (text) => {
    const chunk = String(text);
    fullLog.push(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    appendLog(chunk);
  };
  /** @type {Partial<ForkBuildJob>} */
  let final;

  try {
    await fsp.mkdir(logDir, { recursive: true });
    const repo = /** @type {string} */ (fork.repo);
    const support = await checkForkSupport(fork);
    if (!support.supported) throw new Error(support.reason ?? 'Not supported on this machine');

    const release = await findForkReleaseAssets(fork);
    if (release) {
      await installFromRelease(fork, release, workDir, log);
    } else {
      const prereqs = await checkBuildPrereqs(fork);
      if (!prereqs.ok) {
        throw new Error(`Missing build tools: ${prereqs.missing.map((m) => m.tool).join(', ')}`);
      }
      const branch = fork.branch ?? fork.ref ?? (await defaultBranch(repo));
      const ref = target === 'pinned' && fork.pinnedSha ? fork.pinnedSha : fork.ref ?? branch;
      const sha = await resolveCommit(repo, ref);
      patchJob({ sha });
      await buildFromSource(fork, { repo, sha, workDir, computeCaps: support.computeCaps, prereqs, log });
      await writeForkMeta(fork, { commitSha: sha, ref, branch, installKind: 'source' });
    }

    clearLlamaBinaryProbeCaches();
    final = { phase: 'completed', percent: 100, message: `${fork.label} is ready`, error: null };
  } catch (err) {
    const cancelled = err instanceof BuildCancelled || active?.cancelled;
    const message = cancelled ? 'Build cancelled' : err instanceof Error ? err.message : String(err);
    log(message);
    final = { phase: cancelled ? 'cancelled' : 'failed', message, error: cancelled ? null : message };
  }

  // Persist the log and free the slot before announcing the end, so a Rebuild
  // clicked on the terminal event is never refused as "already running".
  await fsp.writeFile(logPath, fullLog.join(''), 'utf8').catch(() => {});
  if (process.env.MINNOW_KEEP_FORK_BUILD !== '1') {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  active = null;
  patchJob(final, true);
}

/**
 * @param {ForkDef} fork
 * @param {{ repo: string, sha: string, workDir: string, computeCaps: string[], prereqs: BuildPrereqs, log: (t: string) => void }} ctx
 */
async function buildFromSource(fork, ctx) {
  const { repo, sha, workDir, computeCaps, prereqs, log } = ctx;
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });

  patchJob({ phase: 'downloading', percent: 2, message: `Downloading ${repo}@${sha.slice(0, 7)}` });
  const archive = path.join(workDir, 'source.tar.gz');
  await downloadToFile(`https://codeload.github.com/${repo}/tar.gz/${sha}`, archive, (pct) => {
    patchJob({ percent: Math.min(10, Math.round(pct / 10)) });
  });
  if (active?.cancelled) throw new BuildCancelled('Build cancelled');
  const srcRoot = path.join(workDir, 'src');
  await extractArchive(archive, srcRoot);
  const [top] = (await fsp.readdir(srcRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (!top) throw new Error('Source archive was empty');
  const sourceDir = path.join(srcRoot, top.name);
  const buildDir = path.join(workDir, 'build');
  await applySourcePatches(fork, sourceDir, log);

  const cmake = /** @type {string} */ (prereqs.cmake);
  const { configure, build } = buildCmakeArgs(fork, { sourceDir, buildDir, computeCaps });
  patchJob({ phase: 'configuring', percent: 12, message: 'Configuring with CMake' });
  await runStep(cmake, configure, workDir, log);
  patchJob({ phase: 'building', percent: 20, message: 'Compiling llama-server (this can take 10–40 minutes)' });
  await runStep(cmake, build, workDir, log);

  patchJob({ phase: 'installing', percent: 96, message: 'Installing' });
  const found = await findExtractedBinary(buildDir);
  if (!found) throw new Error(`Build finished but ${binaryFileName()} was not produced`);
  const cudaRuntimeDir = await stageCudaRuntimeDlls(fork, prereqs, workDir);
  await installBinaries(fork.id, path.dirname(found), cudaRuntimeDir);
}

/**
 * Apply an approved fork's host-specific source fixes. A fix whose text is gone
 * (the fork fixed it, or "Build latest" moved past it) is logged and skipped.
 * @param {ForkDef} fork
 * @param {string} sourceDir
 * @param {(t: string) => void} log
 * @param {NodeJS.Platform} [platform]
 */
export async function applySourcePatches(fork, sourceDir, log, platform = process.platform) {
  const patches = fork.origin === 'approved' ? (fork.sourcePatches?.[platform] ?? []) : [];
  for (const patch of patches) {
    const file = path.join(sourceDir, ...patch.file.split('/'));
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      log(`patch skipped (${patch.file} not found): ${patch.why}`);
      continue;
    }
    // Tarballs from codeload keep the repo's line endings; match on LF, restore CRLF if that is what the file uses.
    const crlf = text.includes('\r\n');
    let next = crlf ? text.replace(/\r\n/g, '\n') : text;
    /** @type {string | null} */
    let miss = null;
    for (const edit of patch.edits) {
      const at = next.indexOf(edit.find);
      if (at < 0 || next.indexOf(edit.find, at + 1) >= 0) {
        miss = at < 0 ? 'text not found' : 'text not unique';
        break;
      }
      next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
    }
    if (miss) {
      log(`patch skipped (${miss} in ${patch.file}): ${patch.why}`);
      continue;
    }
    await fsp.writeFile(file, crlf ? next.replace(/\n/g, '\r\n') : next, 'utf8');
    log(`patched ${patch.file}: ${patch.why}`);
  }
}

/**
 * Windows CUDA builds link cudart/cuBLAS dynamically. Copy those DLLs next to
 * llama-server so it still starts if the toolkit's bin/ drops off PATH.
 * @param {ForkDef} fork
 * @param {BuildPrereqs} prereqs
 * @param {string} workDir
 * @returns {Promise<string | null>}
 */
async function stageCudaRuntimeDlls(fork, prereqs, workDir) {
  if (process.platform !== 'win32' || fork.backend !== 'cuda' || !prereqs.nvcc) return null;
  const cudaBin = path.dirname(prereqs.nvcc);
  let names;
  try {
    names = (await fsp.readdir(cudaBin)).filter((n) => /^(cudart|cublas|cublasLt)64_\d+\.dll$/i.test(n));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const staging = path.join(workDir, 'cuda-runtime');
  await fsp.mkdir(staging, { recursive: true });
  for (const name of names) await fsp.copyFile(path.join(cudaBin, name), path.join(staging, name));
  return staging;
}

/**
 * @param {ForkDef} fork
 * @param {{ tag: string, assets: Array<{ name: string, browser_download_url: string, digest?: string }>, mainZip: string, companionZip?: string, assetNames: string[] }} release
 * @param {string} workDir
 * @param {(t: string) => void} log
 */
async function installFromRelease(fork, release, workDir, log) {
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  const byName = new Map(release.assets.map((a) => [a.name, a]));

  /** @param {string} name */
  const fetchAsset = async (name) => {
    const asset = byName.get(name);
    if (!asset) throw new Error(`Release asset ${name} disappeared`);
    const dest = path.join(workDir, name);
    log(`Downloading ${name}`);
    await downloadToFile(asset.browser_download_url, dest, (pct) => patchJob({ percent: Math.round(pct * 0.8) }));
    await assertArchiveDigest(dest, asset.digest);
    const out = path.join(workDir, `${name}.d`);
    await extractArchive(dest, out);
    return out;
  };

  patchJob({ phase: 'downloading', percent: 2, message: `Downloading ${fork.label} ${release.tag}` });
  const companionDir = release.companionZip ? await fetchAsset(release.companionZip) : null;
  const mainDir = await fetchAsset(release.mainZip);
  if (active?.cancelled) throw new BuildCancelled('Build cancelled');

  patchJob({ phase: 'installing', percent: 90, message: 'Installing' });
  await installBinaries(fork.id, mainDir, companionDir);
  await writeForkMeta(fork, { version: release.tag, assetNames: release.assetNames, installKind: 'release' });
}

/**
 * @param {ForkDef} fork
 * @param {Record<string, unknown>} fields
 */
async function writeForkMeta(fork, fields) {
  const binary = findBinaryInDir(getForkBinDir(fork.id));
  const meta = {
    forkId: fork.id,
    repo: fork.repo ?? null,
    cmakeFlags: fork.cmakeFlags,
    backend: fork.backend,
    builtAt: new Date().toISOString(),
    binaryPath: binary,
    ...fields,
  };
  await fsp.writeFile(getForkMetaPath(fork.id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * Remove a fork's installed files (never a local fork's own binary).
 * @param {string} forkId
 */
export async function uninstallFork(forkId) {
  if (job?.engineId === forkId && active) throw new Error('Cancel the running build first');
  await fsp.rm(getForkRoot(forkId), { recursive: true, force: true });
  clearLlamaBinaryProbeCaches();
}
