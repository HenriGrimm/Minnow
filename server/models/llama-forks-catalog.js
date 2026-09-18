/**
 * llama.cpp engines: upstream ggml-org plus forks (approved catalog + user-added).
 *
 * Fork installs live under `models-runtime/llama-forks/<id>/`, never under the
 * upstream `models-runtime/llama-cpp/` root — `findBinaryInDir` scans one level
 * deep there and would pick a fork's binary up as the upstream install.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

export const UPSTREAM_ENGINE_ID = 'upstream';

/** @typedef {'cuda' | 'vulkan' | 'metal' | 'rocm' | 'cpu'} EngineBackend */

/**
 * @typedef {object} SourcePatch
 * @property {string} file Path inside the source tree, `/`-separated.
 * @property {Array<{ find: string, replace: string }>} edits All-or-nothing; each `find` must occur exactly once.
 * @property {string} why Logged with the build.
 */

/**
 * @typedef {object} ForkDef
 * @property {string} id
 * @property {string} label
 * @property {string} [description]
 * @property {'approved' | 'custom'} origin
 * @property {'github' | 'local'} source
 * @property {string} [repo] `owner/name`
 * @property {string} [branch] Branch "commits behind" is measured against.
 * @property {string} [ref] Custom forks: branch, tag or commit to build.
 * @property {string} [pinnedSha] Approved forks: the commit Minnow tested.
 * @property {string} [binaryPath] Local forks: an existing llama-server.
 * @property {EngineBackend} backend
 * @property {number} [minCudaSm] e.g. 86 for SM 8.6.
 * @property {string[]} cmakeFlags
 * @property {Partial<Record<NodeJS.Platform, string[]>>} [platformCmakeFlags] Approved forks only: host-specific fixes.
 * @property {Partial<Record<NodeJS.Platform, SourcePatch[]>>} [sourcePatches] Approved forks only: exact-string fixes applied after download.
 * @property {Record<string, number>} [kvCacheTypes] Extra `--cache-type-k/v` values, bits per value.
 * @property {boolean} [asymmetricKv] Fork supports different K and V cache types without a CPU fallback.
 * @property {string} [homepage]
 */

/** @type {Record<string, Omit<ForkDef, 'id' | 'origin' | 'source' | 'cmakeFlags'> & { cmakeFlags?: string[] }>} */
const APPROVED = {
  turbo3: {
    label: 'TurboQuant (turbo3-cuda)',
    description:
      'TurboQuant KV cache compression for NVIDIA GPUs: turbo2/3/4 cache types keep 4–8× more context in the same VRAM.',
    repo: 'Madreag/turbo3-cuda',
    branch: 'release/cuda-optimized',
    pinnedSha: '369a73549d9862c47981fe51bb2c5dd3cd2bab7e',
    backend: 'cuda',
    minCudaSm: 86,
    kvCacheTypes: {
      turbo4: 4.25,
      turbo3: 3.125,
      turbo3_tcq: 3.25,
      turbo2: 2.125,
      turbo2_tcq: 2.25,
      'turbo1.5': 2.0,
    },
    asymmetricKv: true,
    // Developed on Linux/WSL, where GCC accepts two things MSVC does not. Both fixes
    // are pinned to pinnedSha; drop them once the fork builds on Windows as-is.
    platformCmakeFlags: {
      win32: [
        // ggml-turbo-quant.c uses M_PI, which MSVC only defines with _USE_MATH_DEFINES.
        '-DCMAKE_C_FLAGS=/DWIN32 /D_WINDOWS /D_USE_MATH_DEFINES',
        '-DCMAKE_CXX_FLAGS=/DWIN32 /D_WINDOWS /EHsc /D_USE_MATH_DEFINES',
      ],
    },
    sourcePatches: {
      win32: [
        {
          file: 'ggml/src/ggml-cpu/ops.cpp',
          why: 'C global declared from C++ without extern "C" (MSVC mangles it; GCC does not)',
          edits: [
            {
              find: '#include "ops.h"\n',
              replace:
                '#include "ops.h"\n\n// Minnow (MSVC): defined in ggml-turbo-quant.c, so it needs C linkage.\nextern "C" int turbo3_cpu_wht_group_size;\n',
            },
            { find: '        extern int turbo3_cpu_wht_group_size;\n', replace: '' },
          ],
        },
      ],
    },
    homepage: 'https://github.com/Madreag/turbo3-cuda',
  },
};

/** @returns {ForkDef[]} */
export function listApprovedForks() {
  return Object.entries(APPROVED).map(([id, def]) => ({
    id,
    origin: 'approved',
    source: 'github',
    cmakeFlags: [],
    ...def,
  }));
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown> | null | undefined} config `llama-cpp.json`
 * @returns {{ active: string, customForks: ForkDef[] }}
 */
export function readEngineConfig(config) {
  const engine = config && typeof config.engine === 'object' && config.engine ? config.engine : {};
  const rawForks = Array.isArray(engine.customForks) ? engine.customForks : [];
  /** @type {ForkDef[]} */
  const customForks = [];
  for (const raw of rawForks) {
    try {
      customForks.push(normalizeCustomFork(raw));
    } catch {
      /* drop malformed rows rather than failing every status read */
    }
  }
  const active = typeof engine.active === 'string' && engine.active ? engine.active : UPSTREAM_ENGINE_ID;
  return { active, customForks };
}

/**
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {ForkDef[]}
 */
export function listForkDefs(config) {
  return [...listApprovedForks(), ...readEngineConfig(config).customForks];
}

/**
 * @param {string} id
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {ForkDef | null}
 */
export function getForkDef(id, config) {
  if (!id || id === UPSTREAM_ENGINE_ID) return null;
  return listForkDefs(config).find((f) => f.id === id) ?? null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const BACKENDS = new Set(['cuda', 'vulkan', 'metal', 'rocm', 'cpu']);
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
/** `-DNAME=VALUE` or `-DNAME:TYPE=VALUE`; nothing a shell or cmake script could smuggle. */
const CMAKE_FLAG_RE = /^-D[A-Za-z_][A-Za-z0-9_]*(?::[A-Z]+)?=[A-Za-z0-9._+,;/-]*$/;

/**
 * Accepts `owner/repo`, `https://github.com/owner/repo(.git)`, or `github.com/owner/repo`.
 * @param {unknown} input
 * @returns {string}
 */
export function parseGithubRepo(input) {
  let raw = String(input ?? '').trim();
  raw = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '');
  raw = raw.replace(/\.git$/i, '').replace(/\/+$/, '');
  const [owner, name] = raw.split('/');
  const slug = owner && name ? `${owner}/${name}` : raw;
  if (!REPO_RE.test(slug) || raw.split('/').length > 2) {
    throw new Error('Repository must be a GitHub owner/name, e.g. ggml-org/llama.cpp');
  }
  return slug;
}

/**
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseCmakeFlags(input) {
  const tokens = Array.isArray(input)
    ? input.map((t) => String(t).trim())
    : String(input ?? '').split(/\s+/);
  const flags = tokens.filter(Boolean);
  for (const flag of flags) {
    if (!CMAKE_FLAG_RE.test(flag)) {
      throw new Error(`Unsupported cmake flag "${flag}". Use -DNAME=VALUE.`);
    }
  }
  return flags;
}

/**
 * @param {string} label
 */
export function slugifyForkId(label) {
  const base = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'fork';
}

/**
 * Shape a stored or submitted custom fork. Throws on invalid input.
 * @param {Record<string, unknown>} raw
 * @returns {ForkDef}
 */
export function normalizeCustomFork(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Fork must be an object');
  const label = String(raw.label ?? '').trim();
  if (!label) throw new Error('Give the fork a name');
  const source = raw.source === 'local' ? 'local' : 'github';
  const backend = BACKENDS.has(String(raw.backend)) ? /** @type {EngineBackend} */ (raw.backend) : 'cpu';
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `custom-${slugifyForkId(label)}`;
  if (!/^custom-[a-z0-9-]{1,48}$/.test(id)) throw new Error('Invalid fork id');

  if (source === 'local') {
    const binaryPath = String(raw.binaryPath ?? '').trim();
    if (!binaryPath || !path.isAbsolute(binaryPath)) {
      throw new Error('Local fork needs the absolute path to its llama-server binary');
    }
    return { id, label, origin: 'custom', source, binaryPath, backend, cmakeFlags: [] };
  }

  const repo = parseGithubRepo(raw.repo);
  const ref = String(raw.ref ?? '').trim();
  if (ref && !REF_RE.test(ref)) throw new Error('Ref must be a branch, tag or commit');
  return {
    id,
    label,
    origin: 'custom',
    source,
    repo,
    ...(ref ? { ref } : {}),
    backend,
    cmakeFlags: parseCmakeFlags(raw.cmakeFlags),
    homepage: `https://github.com/${repo}`,
  };
}

/**
 * Validate a new custom fork against disk and the existing list.
 * @param {Record<string, unknown>} raw
 * @param {ForkDef[]} existing
 * @returns {ForkDef}
 */
export function validateCustomFork(raw, existing) {
  const fork = normalizeCustomFork({ ...raw, id: undefined });
  let id = fork.id;
  for (let n = 2; existing.some((f) => f.id === id); n += 1) id = `${fork.id}-${n}`;
  fork.id = id;
  if (fork.source === 'local') {
    let stat;
    try {
      stat = fs.statSync(/** @type {string} */ (fork.binaryPath));
    } catch {
      throw new Error(`No file at ${fork.binaryPath}`);
    }
    if (!stat.isFile()) throw new Error(`${fork.binaryPath} is not a file`);
  }
  return fork;
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function getForksRoot() {
  return path.join(getMinnowHome(), 'models-runtime', 'llama-forks');
}

/** @param {string} id */
export function getForkRoot(id) {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`Invalid engine id: ${id}`);
  return path.join(getForksRoot(), id);
}

/** @param {string} id */
export function getForkBinDir(id) {
  return path.join(getForkRoot(id), 'bin');
}

/** @param {string} id */
export function getForkMetaPath(id) {
  return path.join(getForkRoot(id), 'meta.json');
}

/**
 * Variant string the planner / device / flash-attn code keys on.
 * @param {ForkDef} fork
 */
export function variantForFork(fork) {
  return fork.backend;
}

/**
 * cmake backend switch for a fork's backend (added unless the user set it).
 * @param {EngineBackend} backend
 */
export function backendCmakeFlag(backend) {
  switch (backend) {
    case 'cuda':
      return '-DGGML_CUDA=ON';
    case 'vulkan':
      return '-DGGML_VULKAN=ON';
    case 'rocm':
      return '-DGGML_HIP=ON';
    case 'metal':
      return '-DGGML_METAL=ON';
    default:
      return null;
  }
}
