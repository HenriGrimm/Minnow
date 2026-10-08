import path from 'node:path';

const accesses = new Set();

export function containsModelPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Keep deletion from racing a load, download admission, or another deletion. */
export async function withModelArtifactAccess(paths, deleting, run) {
  const entry = { paths: paths.map((p) => path.resolve(p)), deleting };
  for (const active of accesses) {
    if (!deleting && !active.deleting) continue;
    if (entry.paths.some((p) => active.paths.some((a) => containsModelPath(a, p) || containsModelPath(p, a)))) {
      throw new Error('Model files are busy. Wait for the current operation to finish and try again.');
    }
  }
  accesses.add(entry);
  try {
    return await run();
  } finally {
    accesses.delete(entry);
  }
}
