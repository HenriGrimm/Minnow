import { remoteContext, github, segment, positiveId } from './action-common.js';

function commitSha(value) {
  if (!/^[a-f0-9]{40,64}$/i.test(value || '')) throw new Error('GitHub returned an invalid commit SHA');
  return value;
}

async function tagCommit(context, tag, allowMissing = false) {
  let object;
  try {
    object = (await github(context, `git/ref/tags/${segment(tag)}`)).object;
  } catch (error) {
    if (allowMissing && /\bHTTP 404\b/.test(error.message)) return null;
    throw error;
  }
  const visited = new Set();
  while (object?.type === 'tag') {
    const sha = commitSha(object.sha);
    if (visited.has(sha)) throw new Error('Invalid annotated tag');
    visited.add(sha);
    object = (await github(context, `git/tags/${sha}`)).object;
  }
  if (object?.type !== 'commit') throw new Error('The tag does not point to a commit');
  return commitSha(object.sha);
}

async function lastPublishedTag(context, id) {
  let latest;
  for (let page = 1; ; page++) {
    const rows = await github(context, `releases?per_page=100&page=${page}`);
    for (const row of rows) {
      if (row.id !== id && !row.draft && row.published_at &&
          (!latest || Date.parse(row.published_at) > Date.parse(latest.published_at))) latest = row;
    }
    if (rows.length < 100) return latest?.tag_name ?? null;
  }
}

/** Remote, immutable range snapshot. No fetch, checkout, or release mutation. */
export async function releaseDraftContext(args) {
  const context = await remoteContext(args.cwd);
  const id = positiveId(args.id);
  const release = await github(context, `releases/${id}`);
  if (!release.draft || release.immutable) throw new Error('Select an editable draft release');
  if (args.previousTag !== undefined && typeof args.previousTag !== 'string')
    throw new Error('Previous tag must be text');
  let targetSha = await tagCommit(context, release.tag_name, true);
  if (!targetSha) {
    // Only a missing tag can fall back to the draft's target, never auth/network errors.
    if (!release.target_commitish) throw new Error('This draft has no target commit');
    targetSha = commitSha((await github(context, `commits/${segment(release.target_commitish)}`)).sha);
  }
  const baseTag = args.previousTag?.trim() || await lastPublishedTag(context, id);
  const baseSha = baseTag ? await tagCommit(context, baseTag) : null;
  const commits = new Map();
  let expected;
  for (let page = 1; ; page++) {
    let rows;
    if (baseSha) {
      const comparison = await github(context, `compare/${baseSha}...${targetSha}?per_page=100&page=${page}`);
      if (!['ahead', 'identical'].includes(comparison.status))
        throw new Error('The previous tag is not an ancestor of the draft target. Choose another previous tag.');
      if (!Number.isSafeInteger(comparison.total_commits) || comparison.total_commits < 0)
        throw new Error('GitHub returned an invalid commit count');
      if (expected !== undefined && expected !== comparison.total_commits)
        throw new Error('The release comparison changed. Try again.');
      expected = comparison.total_commits;
      rows = comparison.commits;
    } else {
      rows = await github(context, `commits?sha=${targetSha}&per_page=100&page=${page}`);
    }
    const before = commits.size;
    for (const row of rows) {
      if (typeof row.commit?.message !== 'string') throw new Error('GitHub returned an incomplete commit message');
      commits.set(commitSha(row.sha), { sha: row.sha, message: row.commit.message });
    }
    if (expected !== undefined && commits.size === expected) break;
    if (rows.length < 100) {
      if (expected !== undefined) throw new Error('Could not collect every commit in the release range. Try again.');
      break;
    }
    if (commits.size === before) throw new Error('GitHub commit pagination did not advance');
  }
  const ordered = [...commits.values()];
  if (!baseSha) ordered.reverse();
  return { ok: true, draftContext: {
    repo: `${context.hostname}/${context.repo}`, tag: release.tag_name,
    baseTag, baseSha, targetSha, commitCount: ordered.length, commits: ordered,
  } };
}
