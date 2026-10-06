import { maxIssueNumberForProjectKey, reconcileDuplicateIssueIds } from './issue-id-uniqueness.mjs';

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Merge only the caller's edits onto the newest persisted state. */
export function mergeIssuesState(base, local, remote) {
  // Older files may already contain duplicate IDs; repair them before the
  // ID-indexed merge so no card disappears when a Map is built below.
  base = { ...base, issues: reconcileDuplicateIssueIds(base.issues) };
  local = { ...local, issues: reconcileDuplicateIssueIds(local.issues) };
  remote = { ...remote, issues: reconcileDuplicateIssueIds(remote.issues) };

  // A previous server save may have rekeyed our new card while a renderer edit
  // was pending. Move the old baseline and pending edits to that returned ID
  // before comparing fields, so the edit cannot land on the other window's card.
  const remoteByOriginalId = new Map(remote.issues.map((issue) => [issue.id, issue]));
  const returnedIds = new Map();
  for (const before of base.issues) {
    const atOldId = remoteByOriginalId.get(before.id);
    if (!atOldId || equal(atOldId, before)) continue;
    const returned = remote.issues.find((candidate) =>
      candidate.id !== before.id && equal(candidate, { ...before, id: candidate.id }));
    if (returned) returnedIds.set(before.id, returned.id);
  }
  if (returnedIds.size) {
    const rewrite = (rows) => rows.map((issue) => ({
      ...issue,
      id: returnedIds.get(issue.id) ?? issue.id,
      ...(issue.parentId && returnedIds.has(issue.parentId)
        ? { parentId: returnedIds.get(issue.parentId) } : {}),
      ...(issue.issueRefs ? { issueRefs: issue.issueRefs.map((ref) => ({
        ...ref, issueId: returnedIds.get(ref.issueId) ?? ref.issueId,
      })) } : {}),
    }));
    base = { ...base, issues: rewrite(base.issues) };
    local = { ...local, issues: rewrite(local.issues) };
  }

  // Two windows can allocate the same next KEY-n before either save completes.
  // The server serializes writes; rekey the second new card against its newest
  // state and update references authored in the same local snapshot.
  const baseIds = new Set(base.issues.map((issue) => issue.id));
  const remoteById = new Map(remote.issues.map((issue) => [issue.id, issue]));
  const used = new Set([...remoteById.keys(), ...local.issues.map((issue) => issue.id)]);
  const remapped = new Map();
  const localIssues = local.issues.map((issue) => {
    const remoteIssue = remoteById.get(issue.id);
    if (baseIds.has(issue.id) || !remoteIssue || equal(issue, remoteIssue)) return issue;
    const match = /^([A-Z0-9]+)-\d+$/i.exec(issue.id);
    const prefix = match?.[1].toUpperCase() ?? 'ISS';
    let next = maxIssueNumberForProjectKey([...remote.issues, ...local.issues], prefix) + 1;
    while (used.has(`${prefix}-${next}`)) next += 1;
    const id = `${prefix}-${next}`;
    used.add(id);
    remapped.set(issue.id, id);
    return { ...issue, id };
  }).map((issue) => ({
    ...issue,
    ...(issue.parentId && remapped.has(issue.parentId) ? { parentId: remapped.get(issue.parentId) } : {}),
    ...(issue.issueRefs ? { issueRefs: issue.issueRefs.map((ref) => ({
      ...ref, issueId: remapped.get(ref.issueId) ?? ref.issueId,
    })) } : {}),
  }));
  if (remapped.size) local = { ...local, issues: localIssues };

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
