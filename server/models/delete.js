import fsp from 'node:fs/promises';
import path from 'node:path';
import { invalidateCachedModelsCache, listCachedModels } from './cached.js';
import { listDownloads } from './download.js';
import { listServes } from './serve.js';
import { parseSplitGgufFilename } from './split-gguf.js';
import { containsModelPath, withModelArtifactAccess } from './artifact-access.js';

/** Resolve only identities emitted by the scanner, never a client-supplied path. */
async function resolveTarget(libraryId) {
  invalidateCachedModelsCache();
  const { models } = await listCachedModels();
  for (const row of models) {
    if (row.is_ollama) continue;
    const hub = !row.is_local_dir && row.status !== 'downloaded';
    const root = hub ? path.join(row.path, `models--${row.repo_id.replace(/\//g, '--')}`) : row.path;
    for (const file of row.gguf_files ?? []) {
      if (file.role !== 'model' || libraryId !== `gguf:${row.repo_id}:${file.rel_path}`) continue;
      const modelPath = path.join(root, ...(hub ? ['snapshots'] : []), file.rel_path);
      const split = parseSplitGgufFilename(modelPath);
      const files = split
        ? (await fsp.readdir(path.dirname(modelPath))).filter((name) => {
          const sibling = parseSplitGgufFilename(name);
          return sibling && sibling.prefix === split.prefix && sibling.count === split.count;
        }).map((name) => path.join(path.dirname(modelPath), name))
        : [modelPath];
      return { root, paths: files, modelPath, recursive: false, repoId: row.repo_id };
    }
    if (row.mlx_root && !(row.gguf_files ?? []).some((file) => file.role === 'model') && libraryId === `mlx:${row.repo_id}`) {
      // An MLX row represents the whole repo; HF revisions share its blob store.
      return { root, paths: [root], modelPath: row.mlx_root, recursive: true, repoId: row.repo_id };
    }
  }
  throw new Error('Model not found in My models. Rescan local folders and try again.');
}

/** Reject changed/junction paths before deleting, including every split shard. */
async function validatePaths(target) {
  const realRoot = await fsp.realpath(target.root);
  for (const filename of target.paths) {
    if (!containsModelPath(target.root, filename)) throw new Error('Model path is outside its scanned folder.');
    const realParent = await fsp.realpath(path.dirname(filename));
    const realFile = await fsp.realpath(filename);
    if (target.recursive) {
      const stat = await fsp.lstat(filename);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realFile !== path.resolve(filename)) {
        throw new Error('Cannot delete a linked model folder.');
      }
    } else if (!containsModelPath(realRoot, realParent) || !containsModelPath(realRoot, realFile) || !(await fsp.lstat(filename)).isFile()) {
      throw new Error('Cannot delete a linked model file or a file outside its scanned folder.');
    }
  }
}

export async function deleteLibraryModel(libraryId, modelPath) {
  if (typeof libraryId !== 'string' || !libraryId.trim()) throw new Error('libraryId is required');
  const target = await resolveTarget(libraryId);
  if (typeof modelPath !== 'string' || path.resolve(modelPath) !== path.resolve(target.modelPath)) {
    throw new Error('Model location changed. Rescan local folders and try again.');
  }
  return withModelArtifactAccess(target.paths, true, async () => {
    await validatePaths(target);
    const [serves, downloads] = await Promise.all([listServes(), listDownloads()]);
    const overlaps = (filename) => filename && target.paths.some((p) => containsModelPath(p, filename) || containsModelPath(filename, p));
    if (serves.some((serve) => ['starting', 'running', 'unhealthy'].includes(serve.status) && overlaps(serve.modelPath))) {
      throw new Error('Eject this model before deleting it.');
    }
    if (downloads.some((job) => job.repoId === target.repoId && !['completed', 'cancelled'].includes(job.status))) {
      throw new Error('Cancel and discard this model’s download before deleting it.');
    }
    try {
      for (const filename of target.paths) {
        await fsp.rm(filename, { recursive: target.recursive });
      }
      return { deleted: true, libraryId };
    } finally {
      // A failed split deletion may still have removed some of its shards.
      invalidateCachedModelsCache();
    }
  });
}
