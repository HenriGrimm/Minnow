import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureHfHubCacheDir, resolveHfHubCacheDir } from '../models/cached.js';
import { resolveHfTokenAsync } from '../models/hf-client.js';
import {
  getServerDir,
  getServerMetaPath,
  getServerVenvDir,
} from './paths.js';
import { ensureHealthyVenv, isVenvHealthy, pipInstall, venvPythonExe } from './provisioner.js';
import { ensureStandalonePython } from './searxng.js';

const SERVER_ID = 'mlx-lm';

export const MLX_LM_VERSION = '0.31.3';

export const MLX_UNSUPPORTED_MESSAGE =
  'MLX runs only on Apple Silicon Macs (macOS 13 or later). Use GGUF weights with llama.cpp on this machine.';

export function isMlxSupported() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
  const major = Number.parseInt(os.release().split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 22;
}

/** @returns {Promise<Record<string, unknown> | null>} */
async function readMeta() {
  try {
    return JSON.parse(await fsp.readFile(getServerMetaPath(SERVER_ID), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} meta */
async function writeMeta(meta) {
  await fsp.mkdir(getServerDir(SERVER_ID), { recursive: true });
  await fsp.writeFile(getServerMetaPath(SERVER_ID), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

/** @param {string} root */
async function dirSizeBytes(root) {
  let total = 0;
  /** @param {string} dir */
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
        }
      }
    }
  }
  await walk(root);
  return total;
}

/**
 * @param {(message: string) => void} [onProgress]
 */
export async function provision(onProgress) {
  if (!isMlxSupported()) {
    throw new Error(MLX_UNSUPPORTED_MESSAGE);
  }
  const progress = (/** @type {string} */ msg) => onProgress?.(msg);
  await fsp.mkdir(getServerDir(SERVER_ID), { recursive: true });

  progress('Ensuring Python runtime');
  const pythonExe = await ensureStandalonePython(progress);

  const venvDir = getServerVenvDir(SERVER_ID);
  await ensureHealthyVenv(pythonExe, venvDir, progress);

  const venvPython = venvPythonExe(venvDir);
  progress(`Installing mlx-lm ${MLX_LM_VERSION} (this pulls transformers and mlx)`);
  await pipInstall(venvPython, `mlx-lm==${MLX_LM_VERSION}`, progress);

  const sizeBytes = await dirSizeBytes(getServerDir(SERVER_ID));
  await writeMeta({
    kind: 'python-venv',
    version: MLX_LM_VERSION,
    sizeBytes,
    installedAt: new Date().toISOString(),
  });

  return { version: MLX_LM_VERSION, sizeBytes };
}

export async function getInstallStatus() {
  const meta = await readMeta();
  const venvDir = getServerVenvDir(SERVER_ID);
  const installed = Boolean(meta?.installedAt) && (await isVenvHealthy(venvDir));
  const supported = isMlxSupported();
  const reason = supported ? null : MLX_UNSUPPORTED_MESSAGE;
  if (!installed) {
    return {
      installed: false,
      version: null,
      sizeBytes: 0,
      supported,
      installable: supported,
      reason,
    };
  }
  return {
    installed: true,
    version: typeof meta?.version === 'string' ? meta.version : null,
    sizeBytes: typeof meta?.sizeBytes === 'number' ? meta.sizeBytes : 0,
    supported,
    installable: supported,
    reason,
  };
}

/**
 * @param {number} port
 * @returns {string[]}
 */
export function buildMlxServerArgs(port) {
  return [
    '-m',
    'mlx_lm.server',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--allowed-origins',
    'http://127.0.0.1',
  ];
}

/**
 * @returns {Promise<Record<string, string>>}
 */
export async function buildMlxServerEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  const hubCache = await ensureHfHubCacheDir(resolveHfHubCacheDir());
  env.HF_HUB_CACHE = hubCache;
  env.HUGGINGFACE_HUB_CACHE = hubCache;
  if (process.env.HF_HOME) env.HF_HOME = process.env.HF_HOME;
  const token = await resolveHfTokenAsync().catch(() => '');
  if (token) env.HF_TOKEN = token;
  return env;
}

/**
 * @param {number} port
 * @returns {Promise<{ command: string, args: string[], env: Record<string, string>, cwd: string }>}
 */
export async function getSpawnSpec(port) {
  if (!isMlxSupported()) {
    throw new Error(MLX_UNSUPPORTED_MESSAGE);
  }
  const venvDir = getServerVenvDir(SERVER_ID);
  if (!(await isVenvHealthy(venvDir))) {
    throw new Error(
      'The mlx-lm virtual environment is corrupted (missing pyvenv.cfg). Reinstall from Models → Engine.',
    );
  }

  const env = await buildMlxServerEnv();

  return {
    command: venvPythonExe(venvDir),
    args: buildMlxServerArgs(port),
    cwd: getServerDir(SERVER_ID),
    env,
  };
}

export async function uninstall() {
  await fsp.rm(getServerDir(SERVER_ID), { recursive: true, force: true });
  return { ok: true };
}

export async function getExtendedStatus() {
  const status = await getInstallStatus();
  const venvDir = getServerVenvDir(SERVER_ID);
  return {
    ...status,
    venvPath: fs.existsSync(venvDir) ? venvDir : null,
  };
}

export { SERVER_ID };
