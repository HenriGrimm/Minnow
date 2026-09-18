/**
 * Engine selection for llama.cpp: which binary (upstream or a fork) the next
 * serve spawns, plus per-engine install status for Models → Engine.
 */

import { readLlamaCppConfig, writeLlamaCppConfig } from './llama-args.js';
import {
  UPSTREAM_ENGINE_ID,
  listForkDefs,
  readEngineConfig,
  validateCustomFork,
} from './llama-forks-catalog.js';
import {
  checkBuildPrereqs,
  checkForkSupport,
  commitsBehind,
  detectCudaComputeCaps,
  getForkBuildJob,
  uninstallFork,
} from './llama-fork-build.js';
import { findForkBinary, readForkMeta, resolveUpstreamLlamaServer } from './llama-runtime.js';

/** @typedef {import('./llama-forks-catalog.js').ForkDef} ForkDef */

/**
 * @param {ForkDef} fork
 * @param {{ computeCaps: string[] }} probe
 */
async function forkStatus(fork, probe) {
  const binary = findForkBinary(fork);
  const meta = fork.source === 'github' ? await readForkMeta(fork.id) : null;
  const installedSha = typeof meta?.commitSha === 'string' ? meta.commitSha : null;
  const support = await checkForkSupport(fork, probe);
  const branch = fork.branch ?? fork.ref ?? null;

  const [prereqs, behind] = await Promise.all([
    fork.source === 'github' && support.supported ? checkBuildPrereqs(fork) : Promise.resolve(null),
    fork.repo && branch && (installedSha || fork.pinnedSha)
      ? commitsBehind(fork.repo, /** @type {string} */ (installedSha ?? fork.pinnedSha), branch)
      : Promise.resolve(null),
  ]);

  return {
    id: fork.id,
    label: fork.label,
    description: fork.description ?? null,
    kind: 'fork',
    origin: fork.origin,
    source: fork.source,
    repo: fork.repo ?? null,
    ref: fork.ref ?? null,
    branch,
    homepage: fork.homepage ?? null,
    backend: fork.backend,
    minCudaSm: fork.minCudaSm ?? null,
    cmakeFlags: fork.cmakeFlags,
    binaryPath: binary ?? fork.binaryPath ?? null,
    installed: Boolean(binary),
    installKind: typeof meta?.installKind === 'string' ? meta.installKind : fork.source === 'local' ? 'local' : null,
    version: typeof meta?.version === 'string' ? meta.version : null,
    installedSha,
    pinnedSha: fork.pinnedSha ?? null,
    /** Minnow moved the pin since this build. */
    pinUpdateAvailable: Boolean(installedSha && fork.pinnedSha && installedSha !== fork.pinnedSha),
    commitsBehind: behind,
    builtAt: typeof meta?.builtAt === 'string' ? meta.builtAt : null,
    supported: support.supported,
    unsupportedReason: support.reason,
    prereqs,
    kvCacheTypes: fork.kvCacheTypes ? Object.keys(fork.kvCacheTypes) : [],
    asymmetricKv: fork.asymmetricKv === true,
  };
}

export async function listLlamaEngines() {
  const config = await readLlamaCppConfig();
  const { active } = readEngineConfig(config);
  const forks = listForkDefs(config);
  const needsCaps = forks.some((f) => f.backend === 'cuda');
  const computeCaps = needsCaps ? await detectCudaComputeCaps() : [];
  const upstream = await resolveUpstreamLlamaServer();

  const engines = [
    {
      id: UPSTREAM_ENGINE_ID,
      label: 'llama.cpp',
      description: 'The official ggml-org build, pinned and downloaded by Minnow.',
      kind: 'upstream',
      origin: 'approved',
      installed: Boolean(upstream.path),
      binaryPath: upstream.path,
      supported: true,
      unsupportedReason: null,
    },
    ...(await Promise.all(forks.map((f) => forkStatus(f, { computeCaps })))),
  ];
  return {
    active: engines.some((e) => e.id === active) ? active : UPSTREAM_ENGINE_ID,
    engines,
    build: getForkBuildJob(),
  };
}

/**
 * @param {string} id
 */
export async function setActiveLlamaEngine(id) {
  const config = await readLlamaCppConfig();
  const engine = readEngineConfig(config);
  if (id !== UPSTREAM_ENGINE_ID && !listForkDefs(config).some((f) => f.id === id)) {
    throw new Error(`Unknown llama.cpp engine: ${id}`);
  }
  await writeLlamaCppConfig({ engine: { ...engine, active: id } });
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Promise<ForkDef>}
 */
export async function addCustomLlamaFork(raw) {
  const config = await readLlamaCppConfig();
  const engine = readEngineConfig(config);
  const fork = validateCustomFork(raw, listForkDefs(config));
  await writeLlamaCppConfig({ engine: { ...engine, customForks: [...engine.customForks, fork] } });
  return fork;
}

/**
 * Drop a custom fork, its built files, and the selection if it was active.
 * @param {string} id
 */
export async function removeCustomLlamaFork(id) {
  const config = await readLlamaCppConfig();
  const engine = readEngineConfig(config);
  const fork = engine.customForks.find((f) => f.id === id);
  if (!fork) throw new Error(`No custom fork ${id}`);
  if (fork.source === 'github') await uninstallFork(id);
  await writeLlamaCppConfig({
    engine: {
      active: engine.active === id ? UPSTREAM_ENGINE_ID : engine.active,
      customForks: engine.customForks.filter((f) => f.id !== id),
    },
  });
}
