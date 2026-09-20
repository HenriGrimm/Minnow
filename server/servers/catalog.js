/**
 * Built-in managed server catalog (SearXNG and future entries).
 */

import * as searxngProvisioner from './searxng.js';
import * as llamaCppProvisioner from './llama-cpp.js';
import * as mlxLmProvisioner from './mlx-lm.js';
import * as mtplxProvisioner from './mtplx.js';

/** @typedef {'python-venv' | 'native-binary'} ManagedServerKind */

/**
 * @typedef {object} ManagedServerDef
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {ManagedServerKind} kind
 * @property {number} defaultPort
 * @property {boolean} defaultAutoStart
 * @property {boolean} [defaultAutoProvision]
 * @property {string} healthPath
 * @property {object} provisioner
 */

/** mlx-lm uses python-venv (native-binary would refuse to spawn it) and stays off by default so RAM is not held until a model loads. */
/** @type {Record<string, ManagedServerDef>} */
export const BUILTIN_SERVERS = {
  mtplx: {
    id: 'mtplx', label: 'MTPLX',
    description: 'Powered by MTPLX. Apple Silicon inference with multi-token prediction. Uses your existing installation.',
    kind: 'native-binary', defaultPort: 8088, defaultAutoStart: false,
    defaultAutoProvision: false, healthPath: '/health', provisioner: mtplxProvisioner,
  },
  searxng: {
    id: 'searxng',
    label: 'SearXNG',
    description: 'Local privacy-focused metasearch for Deep Research and web search.',
    kind: 'python-venv',
    defaultPort: 8899,
    defaultAutoStart: true,
    defaultAutoProvision: true,
    healthPath: '/healthz',
    provisioner: searxngProvisioner,
  },
  'llama-cpp': {
    id: 'llama-cpp',
    label: 'llama.cpp',
    description: 'Local GGUF inference runtime (llama-server).',
    kind: 'native-binary',
    defaultPort: 8085,
    defaultAutoStart: false,
    healthPath: '/health',
    provisioner: llamaCppProvisioner,
  },
  'mlx-lm': {
    id: 'mlx-lm',
    label: 'MLX',
    description: 'Metal-native inference for MLX weights on Apple Silicon (mlx-lm).',
    kind: 'python-venv',
    defaultPort: 8087,
    defaultAutoStart: false,
    healthPath: '/v1/models',
    provisioner: mlxLmProvisioner,
  },
};

/**
 * @param {string} id
 * @returns {ManagedServerDef | undefined}
 */
export function getServerDef(id) {
  return BUILTIN_SERVERS[id];
}

/** @returns {ManagedServerDef[]} */
export function listServerDefs() {
  return Object.values(BUILTIN_SERVERS);
}
