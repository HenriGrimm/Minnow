/** A multi-repository revision is an ordered, serializable map of repository IDs to Git object IDs. */
export function boardRevisionRepos(value) {
  if (typeof value !== 'string' || !value.startsWith('repos:')) return null;
  try {
    const encoded = value.slice(6).replaceAll('-', '+').replaceAll('_', '/');
    const rows = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))));
    if (!Array.isArray(rows) || !rows.length || rows.some(row => !Array.isArray(row) || row.length !== 2 ||
      typeof row[0] !== 'string' || typeof row[1] !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row[1]))) return null;
    const repos = new Map(rows);
    return repos.size === rows.length ? repos : null;
  } catch { return null; }
}

export function formatBoardRevision(value, length) {
  const repos = boardRevisionRepos(value);
  const short = sha => length ? sha.slice(0, length) : sha;
  return repos ? [...repos].map(([id, sha]) => `${id} ${short(sha)}`).join(', ') : short(value);
}
