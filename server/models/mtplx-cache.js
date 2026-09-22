import fsp from 'node:fs/promises';
import path from 'node:path';
import { defaultMtplxCacheDir, runMtplxJson } from './mtplx-runtime.js';
import { contextLengthFromTransformersConfig } from './mlx-context-length.js';

/** The CLI owns validation; absent CLI rows remain visible but unvalidated. */
export async function scanMtplxCache(seen, { run = runMtplxJson, fallbackDir = defaultMtplxCacheDir() } = {}) {
  let models;
  try { models = (await run(['models', '--json'])).models; }
  catch {
    try {
      models = (await fsp.readdir(fallbackDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.includes('--'))
        .map((entry) => ({ repo_id: entry.name.replace('--', '/'), path: path.join(fallbackDir, entry.name) }));
    } catch { return []; }
  }
  const out = [];
  for (const row of Array.isArray(models) ? models : []) {
    if (typeof row.repo_id !== 'string' || typeof row.path !== 'string' || !path.isAbsolute(row.path) || seen.has(row.repo_id)) continue;
    let config = {};
    try { config = JSON.parse(await fsp.readFile(path.join(row.path, 'config.json'), 'utf8')); } catch {}
    const validated = row.has_runtime_contract === true && row.validation?.ok === true;
    const missing = Array.isArray(row.validation?.missing_files) ? row.validation.missing_files.filter((s) => typeof s === 'string') : [];
    seen.add(row.repo_id);
    out.push({ repo_id: row.repo_id, path: row.path, size_bytes: Number(row.size_bytes) || 0,
      nb_files: row.validation?.required_files?.length ?? 0, has_incomplete: !validated,
      mtplx_root: row.path, mtplx_validated: validated, mtplx_profile: row.recommended_profile,
      mtplx_missing_files: missing, mtplx_reason: validated ? null : missing.length ? `Missing files: ${missing.join(', ')}` : 'MTPLX runtime contract has not been validated. Install MTPLX and refresh.',
      mlx_root: row.path, mlx_quant: config.quantization?.bits ? `mlx-${config.quantization.bits}bit` : '',
      mlx_context_length: contextLengthFromTransformersConfig(config),
    });
  }
  return out;
}
