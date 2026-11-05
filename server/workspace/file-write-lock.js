import { realpathForBoundaryCheck } from './safe-path.js';

const pendingWrites = new Map();

/** Reserve all affected files together so an overlapping edit waits through patch rollback. */
export function withFileWriteLocks(paths, operation) {
  const keys = new Set(paths.map(file => {
    const canonical = realpathForBoundaryCheck(file);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }));
  const predecessors = new Set([...keys].map(key => pendingWrites.get(key)).filter(Boolean));
  const result = Promise.all(predecessors).then(operation);
  const settled = result.then(() => {}, () => {});
  for (const key of keys) pendingWrites.set(key, settled);
  void settled.then(() => {
    for (const key of keys) {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    }
  });
  return result;
}
