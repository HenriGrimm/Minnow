/**
 * Context window from Hugging Face / MLX config.json on disk.
 * mlx_lm.server does not expose context length on /v1/models, so Minnow reads
 * the weights' config when scanning MLX repos and when proxying mlx-lm-local.
 */

import path from 'node:path';
import { listCachedModels } from './cached.js';

/** @type {readonly string[]} */
const CONFIG_CONTEXT_FIELDS = [
  'max_position_embeddings',
  'max_sequence_length',
  'model_max_length',
  'seq_length',
  'n_positions',
];

/**
 * @param {Record<string, unknown> | null | undefined} obj
 * @returns {number | undefined}
 */
function firstPositiveField(obj, fields) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const field of fields) {
    const val = obj[field];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * Effective context tokens from a transformers-style config object.
 * @param {unknown} config
 * @returns {number | undefined}
 */
export function contextLengthFromTransformersConfig(config) {
  if (!config || typeof config !== 'object') return undefined;

  const root = /** @type {Record<string, unknown>} */ (config);
  let base = firstPositiveField(root, CONFIG_CONTEXT_FIELDS);

  const textConfig = root.text_config;
  if (base === undefined && textConfig && typeof textConfig === 'object') {
    base = firstPositiveField(/** @type {Record<string, unknown>} */ (textConfig), CONFIG_CONTEXT_FIELDS);
  }

  if (base === undefined) return undefined;

  const scaling = root.rope_scaling;
  if (scaling && typeof scaling === 'object') {
    const factor = Number(/** @type {Record<string, unknown>} */ (scaling).factor);
    if (Number.isFinite(factor) && factor > 1) {
      const original = Number(
        /** @type {Record<string, unknown>} */ (scaling).original_max_position_embeddings,
      );
      if (Number.isFinite(original) && original > 0) {
        return Math.round(original * factor);
      }
      return Math.round(base * factor);
    }
  }

  return base;
}

/**
 * True when a transformers-style config.json declares a vision tower.
 * MTPLX serves these checkpoints multimodally; its `/v1/models` rows say nothing.
 * @param {unknown} config
 * @returns {boolean}
 */
export function visionFromTransformersConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const vision = /** @type {Record<string, unknown>} */ (config).vision_config;
  return Boolean(vision && typeof vision === 'object');
}

/**
 * Attach max_context_length to mlx-lm-local /v1/models rows from cached MLX scans.
 * Uses `listCachedModels` (30s TTL) — do not walk the library on every proxy request.
 * Context itself was parsed at scan time onto `mlx_context_length`.
 * @param {{ data: Array<Record<string, unknown>> }} normalized
 */
export async function enrichMlxLmModelsWithCachedContext(normalized) {
  const { models } = await listCachedModels();
  /** @type {Map<string, number>} */
  const byPath = new Map();
  /** @type {Map<string, number>} */
  const byRepo = new Map();

  for (const row of models) {
    const len = row.mlx_context_length;
    if (typeof len !== 'number' || !Number.isFinite(len) || len <= 0) continue;
    if (row.mlx_root) byPath.set(path.resolve(row.mlx_root), len);
    if (row.repo_id) byRepo.set(row.repo_id, len);
  }

  if (byPath.size === 0 && byRepo.size === 0) {
    return normalized;
  }

  return {
    data: normalized.data.map((row) => {
      if (typeof row.max_context_length === 'number' && row.max_context_length > 0) {
        return row;
      }
      const id = String(row.id ?? '');
      let ctx = byPath.get(path.resolve(id));
      if (!ctx) {
        for (const [repoId, len] of byRepo) {
          const artifactTail = repoId.replace(/\//g, '--');
          if (id.includes(artifactTail) || id.endsWith(repoId) || id.includes(repoId)) {
            ctx = len;
            break;
          }
        }
      }
      if (!ctx) return row;
      return { ...row, max_context_length: ctx };
    }),
  };
}
