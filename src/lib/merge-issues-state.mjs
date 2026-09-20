function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Merge only the caller's edits onto the newest persisted state. */
export function mergeIssuesState(base, local, remote) {
  function merge(before, mine, theirs, preferLocal = true) {
    if (equal(mine, before)) return theirs;
    if (equal(theirs, before) || equal(mine, theirs)) return mine;
    if (mine === undefined || theirs === undefined) return undefined;
    if (Array.isArray(mine) && Array.isArray(theirs) && Array.isArray(before)
      && [...before, ...mine, ...theirs].every((value) => typeof value === 'string')) {
      const old = new Set(before), left = new Set(mine), right = new Set(theirs);
      return [...new Set([...theirs, ...mine])].filter((value) => !old.has(value) || (left.has(value) && right.has(value)));
    }
    if (Array.isArray(mine) && Array.isArray(theirs) && Array.isArray(before)
      && [...before, ...mine, ...theirs].every((row) => record(row) && typeof row.id === 'string')) {
      const index = (rows) => new Map(rows.map((row) => [row.id, row]));
      const b = index(before), l = index(mine), r = index(theirs);
      const out = [];
      for (const id of new Set([...r.keys(), ...l.keys()])) {
        const old = b.get(id), left = l.get(id), right = r.get(id);
        // Explicit deletion wins over a stale renderer's edits; new rows survive.
        if (old !== undefined && (left === undefined || right === undefined)) continue;
        if (old === undefined && left !== undefined && right !== undefined && !equal(left, right)) {
          throw new Error(`Issue ID ${id} was created in another window. Your unsaved issue is retained; copy it before reloading.`);
        }
        const value = old === undefined ? left ?? right : merge(old, left, right, preferLocal);
        if (value !== undefined) out.push(value);
      }
      return out;
    }
    if (record(mine) && record(theirs) && record(before)) {
      const winner = typeof mine.updatedAt === 'number' && typeof theirs.updatedAt === 'number'
        ? mine.updatedAt > theirs.updatedAt : preferLocal;
      const out = {};
      for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
        const value = ['nextId', 'updatedAt', 'localChangedAt'].includes(key)
          && typeof mine[key] === 'number' && typeof theirs[key] === 'number'
          ? Math.max(mine[key], theirs[key])
          : merge(before[key], mine[key], theirs[key], winner);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    return preferLocal ? mine : theirs;
  }
  return merge(base, local, remote);
}
