import { listRepoFilesRecursive } from './hf-client.js';
import { expandSplitGgufFilenames, parseSplitGgufFilename } from './split-gguf.js';
import { validateRepoId } from './validate.js';

/** Group every shard into one selectable artifact; projectors are not language models. */
export function groupGgufFiles(listed) {
  const ggufs = listed.filter(
    (row) => /\.gguf$/i.test(row.path) && !/(?:^|\/)mmproj[^/]*$/i.test(row.path),
  );
  const paths = ggufs.map((row) => row.path);
  const seen = new Set();
  const result = [];
  for (const row of ggufs) {
    const split = parseSplitGgufFilename(row.path);
    const key = split ? `${split.dir}/${split.prefix}:${split.count}` : row.path;
    if (seen.has(key)) continue;
    seen.add(key);
    let files;
    let error = null;
    try {
      files = expandSplitGgufFilenames(row.path, paths);
    } catch (err) {
      files = [row.path];
      error = err.message;
    }
    const sizes = files.map((file) => listed.find((item) => item.path === file)?.size);
    const quant =
      row.path
        .match(/(?:^|[-_.])(IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-.]|$)/i)?.[1]
        ?.toUpperCase() ?? '';
    result.push({
      filename: files[0],
      quant,
      files,
      error,
      sizeBytes: sizes.every((size) => Number.isFinite(size) && size > 0)
        ? sizes.reduce((a, b) => a + b, 0)
        : null,
    });
  }
  return result.sort(
    (a, b) =>
      (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity) || a.filename.localeCompare(b.filename),
  );
}

export async function getHubFiles(repoId) {
  validateRepoId(repoId);
  return { repoId, files: groupGgufFiles(await listRepoFilesRecursive(repoId)) };
}
