/** Keep existing cards when an older state contains duplicate display IDs. */
export function reconcileDuplicateIssueIds(issues) {
  const used = new Set(issues.map((issue) => issue.id));
  const nextByPrefix = new Map();
  for (const id of used) {
    const match = /^([A-Z0-9]+)-(\d+)$/i.exec(id);
    if (!match) continue;
    const prefix = match[1].toUpperCase();
    nextByPrefix.set(prefix, Math.max(nextByPrefix.get(prefix) ?? 1, Number(match[2]) + 1));
  }
  const seen = new Set();
  const repaired = issues.map((issue) => {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      return issue;
    }
    const match = /^([A-Z0-9]+)-\d+$/i.exec(issue.id);
    const prefix = match?.[1].toUpperCase() ?? 'ISS';
    let next = nextByPrefix.get(prefix) ?? 1;
    while (used.has(`${prefix}-${next}`)) next += 1;
    const id = `${prefix}-${next}`;
    nextByPrefix.set(prefix, next + 1);
    used.add(id);
    seen.add(id);
    return { ...issue, id };
  });

  // A reference inside the same workspace most likely points at its local card.
  // Cross-workspace references to an ambiguous old ID retain the first card.
  const byOldIdAndWorkspace = new Map();
  for (let i = 0; i < issues.length; i += 1) {
    const old = issues[i];
    const current = repaired[i];
    const workspace = String(old.workspacePath ?? '').replace(/\\/g, '/').toLowerCase();
    const key = `${old.id}\0${workspace}`;
    if (!byOldIdAndWorkspace.has(key)) byOldIdAndWorkspace.set(key, current.id);
  }
  return repaired.map((issue) => {
    const workspace = String(issue.workspacePath ?? '').replace(/\\/g, '/').toLowerCase();
    const remap = (id) => byOldIdAndWorkspace.get(`${id}\0${workspace}`) ?? id;
    const parentId = issue.parentId ? remap(issue.parentId) : issue.parentId;
    const issueRefs = issue.issueRefs?.map((ref) => ({ ...ref, issueId: remap(ref.issueId) }));
    return parentId !== issue.parentId || issueRefs?.some((ref, i) => ref.issueId !== issue.issueRefs[i].issueId)
      ? { ...issue, ...(parentId ? { parentId } : {}), ...(issueRefs ? { issueRefs } : {}) }
      : issue;
  });
}

/** Highest suffix for a project key across every workspace. */
export function maxIssueNumberForProjectKey(issues, projectKey) {
  const prefix = projectKey.toUpperCase();
  let max = 0;
  for (const issue of issues) {
    const match = /^([A-Z0-9]+)-(\d+)$/i.exec(issue.id);
    if (match?.[1].toUpperCase() === prefix) max = Math.max(max, Number(match[2]));
  }
  return max;
}
