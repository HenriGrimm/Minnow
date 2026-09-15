import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createVenv, pipSpawnOptions, runProcess } from '../servers/provisioner.js';
import { ensureStandalonePython } from '../servers/searxng.js';
import { detectHardware } from '../system/hardware.js';
import { getVoiceMetaPath, getVoiceRoot, getVoiceVenvDir } from './paths.js';

const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu124';
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

/**
 * @param {boolean} cudaAvailable
 * @returns {{ label: string, variant: 'cpu' | 'cuda', args: string[] }}
 */
export function buildTorchPackage(cudaAvailable) {
  const index = cudaAvailable ? TORCH_CUDA_INDEX : TORCH_CPU_INDEX;
  if (cudaAvailable) {
    return {
      label: 'torch + torchaudio (CUDA 12.4)',
      variant: 'cuda',
      args: ['torch', 'torchaudio', '--index-url', index],
    };
  }
  return {
    label: 'torch + torchaudio (CPU)',
    variant: 'cpu',
    args: ['torch', 'torchaudio', '--index-url', index],
  };
}

/**
 * @param {Awaited<ReturnType<typeof detectHardware>> | null | undefined} hw
 * @returns {boolean}
 */
export function isCudaHardware(hw) {
  return hw?.backend === 'cuda';
}

/**
 * @returns {Promise<boolean>}
 */
async function probeCudaHardware() {
  try {
    const hw = await detectHardware();
    return isCudaHardware(hw);
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown> | null} meta
 * @returns {boolean}
 */
function metaHasCpuTorch(meta) {
  if (meta?.torchVariant === 'cpu') return true;
  const packages = meta?.installedPackages;
  if (!Array.isArray(packages)) return false;
  return packages.some((label) => typeof label === 'string' && label.includes('torch (CPU)'));
}

/**
 * @param {string} venvPython
 * @param {boolean} cudaAvailable
 * @param {Record<string, unknown> | null} meta
 * @param {(message: string) => void} [onProgress]
 */
async function maybeUninstallCpuTorch(venvPython, cudaAvailable, meta, onProgress) {
  if (!cudaAvailable || !metaHasCpuTorch(meta)) return;
  onProgress?.('Removing CPU-only PyTorch before installing CUDA build');
  try {
    await runProcess(
      venvPython,
      ['-m', 'pip', 'uninstall', '-y', 'torch', 'torchaudio'],
      pipSpawnOptions(),
    );
  } catch {
  }
}

/**
 * @param {string} venvDir
 * @returns {string | null}
 */
export function resolveQwenTtsPackageDir(venvDir) {
  const winRoot = path.join(venvDir, 'Lib', 'site-packages', 'qwen_tts');
  if (fs.existsSync(winRoot)) return winRoot;

  const libDir = path.join(venvDir, 'lib');
  if (!fs.existsSync(libDir)) return null;

  for (const name of fs.readdirSync(libDir)) {
    if (!name.startsWith('python')) continue;
    const candidate = path.join(libDir, name, 'site-packages', 'qwen_tts');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {string} venvDir
 * @returns {Promise<number>}
 */
export async function patchQwenTtsPadTokenIdInVenv(venvDir) {
  const root = resolveQwenTtsPackageDir(venvDir);
  if (!root) return 0;

  const modelingPath = path.join(root, 'core', 'models', 'modeling_qwen3_tts.py');
  try {
    const text = await fsp.readFile(modelingPath, 'utf8');
    const needle = 'self.padding_idx = config.pad_token_id';
    const replacement = 'self.padding_idx = getattr(config, "pad_token_id", None)';
    if (!text.includes(needle)) return 0;
    await fsp.writeFile(modelingPath, text.replaceAll(needle, replacement), 'utf8');
    return 1;
  } catch {
    return 0;
  }
}

/**
 * @param {string} venvPython
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<number>}
 */
export async function patchQwenTtsPadTokenId(venvPython, onProgress) {
  onProgress?.('Patching qwen-tts pad_token_id compatibility');
  const venvDir = path.resolve(venvPython, '..', '..');
  return patchQwenTtsPadTokenIdInVenv(venvDir);
}

/**
 * @param {string} venvDir
 * @returns {Promise<number>}
 */
export async function patchQwenTtsCheckModelInputsInVenv(venvDir) {
  const root = resolveQwenTtsPackageDir(venvDir);
  if (!root) return 0;

  let patched = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.py')) continue;
      const text = await fsp.readFile(full, 'utf8');
      if (!text.includes('@check_model_inputs')) continue;
      const next = text.replaceAll(/@check_model_inputs(?!\(\))/g, '@check_model_inputs()');
      if (next === text) continue;
      await fsp.writeFile(full, next, 'utf8');
      patched += 1;
    }
  }
  await walk(root);
  return patched;
}

/**
 * @param {string} venvPython
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<number>}
 */
export async function patchQwenTtsCheckModelInputs(venvPython, onProgress) {
  onProgress?.('Patching qwen-tts check_model_inputs decorator for transformers 4.57.3');
  const venvDir = path.resolve(venvPython, '..', '..');
  return patchQwenTtsCheckModelInputsInVenv(venvDir);
}

/**
 * @param {string} venvPython
 * @param {boolean} cudaAvailable
 * @param {(message: string) => void} [onProgress]
 */
async function pinTorchStack(venvPython, cudaAvailable, onProgress) {
  const index = cudaAvailable ? TORCH_CUDA_INDEX : TORCH_CPU_INDEX;
  const label = cudaAvailable
    ? 'torch + torchaudio (CUDA 12.4 pin)'
    : 'torch + torchaudio (CPU pin)';
  onProgress?.(`Pinning ${label}`);
  await runProcess(
    venvPython,
    [
      '-m',
      'pip',
      'install',
      '--no-input',
      '--force-reinstall',
      'torch',
      'torchaudio',
      '--index-url',
      index,
    ],
    pipSpawnOptions(),
  );
}

/**
 * @param {boolean} cudaAvailable
 * @returns {Array<{ label: string, args: string[] }>}
 */
function corePackagesFor(cudaAvailable) {
  const torchPkg = buildTorchPackage(cudaAvailable);
  return [
    { label: torchPkg.label, args: torchPkg.args },
    { label: 'transformers==4.57.3', args: ['transformers==4.57.3'] },
    { label: 'faster-whisper', args: ['faster-whisper'] },
    { label: 'accelerate', args: ['accelerate'] },
    { label: 'soundfile', args: ['soundfile'] },
  ];
}

const QWEN_TTS_STREAMING_SPEC =
  'git+https://github.com/xxddccaa/Qwen3-TTS-streaming.git';

/**
 * Worker env `MINNOW_TTS_USE_COMPILE` is opt-in (default false). Compilation and
 * CUDA graphs require a usable Triton stack; compiler errors fall back to eager.
 * Applied in `server/voice/python/worker.py` on TTS load.
 */
const OPTIONAL_PACKAGES = [
  { label: 'qwen-tts (streaming fork)', args: [QWEN_TTS_STREAMING_SPEC] },
  { label: 'imageio-ffmpeg', args: ['imageio-ffmpeg'] },
];

/**
 * @param {string} venvDir
 * @returns {string}
 */
function venvPythonPath(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
}

async function readMeta() {
  try {
    const raw = await fsp.readFile(getVoiceMetaPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} meta
 */
async function writeMeta(meta) {
  await fsp.mkdir(getVoiceRoot(), { recursive: true });
  await fsp.writeFile(getVoiceMetaPath(), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} venvPython
 * @param {(message: string) => void} [onProgress]
 */
async function ensurePip(venvPython, onProgress) {
  onProgress?.('Upgrading pip');
  const spawnOpts = pipSpawnOptions();
  await runProcess(venvPython, ['-m', 'ensurepip', '--upgrade'], spawnOpts);
  await runProcess(
    venvPython,
    ['-m', 'pip', 'install', '--upgrade', '--no-input', 'pip', 'wheel', 'setuptools'],
    spawnOpts,
  );
}

/**
 * @param {string} venvPython
 * @param {{ label: string, args: string[], optional?: boolean }} pkg
 * @param {(message: string) => void} [onProgress]
 */
async function pipInstallPackage(venvPython, pkg, onProgress) {
  onProgress?.(`Installing ${pkg.label}`);
  try {
    await runProcess(
      venvPython,
      ['-m', 'pip', 'install', '--no-input', ...pkg.args],
      pipSpawnOptions(pkg.spawnOptions ?? {}),
    );
  } catch (err) {
    if (pkg.optional) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.(`Skipped optional ${pkg.label}: ${message}`);
      return false;
    }
    throw err;
  }
  return true;
}

/**
 * @param {string} venvPython
 * @param {boolean} cudaAvailable
 * @param {(message: string) => void} [onProgress]
 * @returns {Promise<boolean>}
 */
async function maybeInstallFlashAttn(venvPython, cudaAvailable, onProgress) {
  if (!cudaAvailable) return false;
  onProgress?.('Installing flash-attn (optional, CUDA only)');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  if (process.platform === 'win32') {
    env.MAX_JOBS = '4';
  }
  try {
    await runProcess(
      venvPython,
      ['-m', 'pip', 'install', '--no-input', 'flash-attn', '--no-build-isolation'],
      pipSpawnOptions({ env }),
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.(`Skipped optional flash-attn: ${message}`);
    return false;
  }
}

/**
 * @param {(message: string) => void} [onProgress]
 */
export async function provision(onProgress) {
  const progress = (msg) => onProgress?.(msg);
  await fsp.mkdir(getVoiceRoot(), { recursive: true });

  progress('Detecting GPU');
  const cudaAvailable = await probeCudaHardware();
  const torchPkg = buildTorchPackage(cudaAvailable);

  progress('Ensuring Python runtime');
  const pythonExe = await ensureStandalonePython(progress);

  const venvDir = getVoiceVenvDir();
  const venvPython = venvPythonPath(venvDir);
  if (!fs.existsSync(venvPython)) {
    progress('Creating virtual environment');
    await createVenv(pythonExe, venvDir);
  }

  await ensurePip(venvPython, progress);

  const prevMeta = await readMeta();
  await maybeUninstallCpuTorch(venvPython, cudaAvailable, prevMeta, progress);

  const installedPackages = [];
  const skippedPackages = [];

  for (const pkg of corePackagesFor(cudaAvailable)) {
    const ok = await pipInstallPackage(venvPython, pkg, progress);
    if (ok) installedPackages.push(pkg.label);
  }

  for (const pkg of OPTIONAL_PACKAGES) {
    const ok = await pipInstallPackage(venvPython, { ...pkg, optional: true }, progress);
    if (ok) installedPackages.push(pkg.label);
    else skippedPackages.push(pkg.label);
  }

  await patchQwenTtsCheckModelInputs(venvPython, progress);
  await patchQwenTtsPadTokenId(venvPython, progress);

  if (await maybeInstallFlashAttn(venvPython, cudaAvailable, progress)) {
    installedPackages.push('flash-attn');
  } else if (cudaAvailable) {
    skippedPackages.push('flash-attn');
  }

  try {
    await pinTorchStack(venvPython, cudaAvailable, progress);
    const pinLabel = cudaAvailable
      ? 'torch + torchaudio (CUDA 12.4 pin)'
      : 'torch + torchaudio (CPU pin)';
    if (!installedPackages.includes(pinLabel)) {
      installedPackages.push(pinLabel);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to pin matching torch/torchaudio: ${message}`);
  }

  const prev = await readMeta();
  const meta = {
    kind: 'python-venv',
    installedAt: new Date().toISOString(),
    pythonExe,
    venvPython,
    installedPackages,
    skippedPackages,
    torchVariant: torchPkg.variant,
    port: prev?.port ?? null,
    pid: prev?.pid ?? null,
  };
  await writeMeta(meta);
  return meta;
}

/** @returns {Promise<{ installed: boolean, installedAt: string | null, installedPackages: string[], skippedPackages: string[], torchVariant: 'cpu' | 'cuda' | null }>} */
export async function getInstallStatus() {
  const venvPython = venvPythonPath(getVoiceVenvDir());
  const meta = await readMeta();
  const installed = fs.existsSync(venvPython) && Boolean(meta?.installedAt);
  const torchVariant =
    meta?.torchVariant === 'cuda' || meta?.torchVariant === 'cpu' ? meta.torchVariant : null;
  return {
    installed,
    installedAt: meta?.installedAt ?? null,
    installedPackages: Array.isArray(meta?.installedPackages) ? meta.installedPackages : [],
    skippedPackages: Array.isArray(meta?.skippedPackages) ? meta.skippedPackages : [],
    torchVariant,
  };
}

/**
 * @returns {Promise<string>}
 */
export async function getVenvPython() {
  const venvPython = venvPythonPath(getVoiceVenvDir());
  if (!fs.existsSync(venvPython)) {
    throw new Error('Voice runtime is not installed');
  }
  return venvPython;
}

/**
 * @param {Record<string, unknown>} patch
 */
export async function patchMeta(patch) {
  const prev = (await readMeta()) ?? {};
  await writeMeta({ ...prev, ...patch });
}
