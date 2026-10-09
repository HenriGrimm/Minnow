import assert from 'node:assert/strict';
import { test, mock, beforeEach } from 'node:test';

const sha = n => n.toString(16).padStart(40, '0');
const calls = [];
let release;
let published;
let reply;
mock.module('../../server/git/action-common.js', { namedExports: {
  remoteContext: async () => ({ cwd: '/repo', hostname: 'github.example.com', repo: 'owner/repo' }),
  positiveId: Number, segment: encodeURIComponent,
  github: async (_, endpoint, method) => {
    calls.push({ endpoint, method });
    if (endpoint === 'releases/1') return release;
    if (endpoint.startsWith('releases?')) return typeof published === 'function' ? published(endpoint) : published;
    return reply(endpoint);
  },
} });
const { releaseDraftContext } = await import('../../server/git/release-draft-context.js');
beforeEach(() => {
  calls.length = 0;
  release = { id: 1, draft: true, tag_name: 'v2', target_commitish: 'main' };
  published = [{ id: 2, draft: false, published_at: '2026-01-01', tag_name: 'v1' }];
  reply = endpoint => {
    if (endpoint === 'git/ref/tags/v2') return { object: { type: 'commit', sha: sha(2) } };
    if (endpoint === 'git/ref/tags/v1') return { object: { type: 'commit', sha: sha(1) } };
    if (endpoint.startsWith('compare/')) return { status: 'ahead', total_commits: 1, commits: [{ sha: sha(2), commit: { message: 'feat: editor\n\nAdd keyboard navigation.' } }] };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
});

test('uses the remote tag, full messages, and latest publication including prereleases', async () => {
  published.unshift({ id: 3, draft: false, prerelease: true, published_at: '2026-02-01', tag_name: 'v1-beta' });
  const original = reply;
  reply = endpoint => endpoint === 'git/ref/tags/v1-beta' ? { object: { type: 'commit', sha: sha(1) } } : original(endpoint);
  published.push({ id: 4, draft: true, published_at: '2026-03-01', tag_name: 'wrong' });
  const { draftContext } = await releaseDraftContext({ cwd: '/repo', id: 1 });
  assert.equal(draftContext.repo, 'github.example.com/owner/repo');
  assert.equal(draftContext.baseTag, 'v1-beta');
  assert.equal(draftContext.targetSha, sha(2));
  assert.equal(draftContext.commits[0].message, 'feat: editor\n\nAdd keyboard navigation.');
  assert(!calls.some(call => call.endpoint === 'commits/main'));
  assert(calls.every(call => !call.method || call.method === 'GET'));
});

test('resolves nested annotated tags and explicit override without listing releases', async () => {
  const original = reply;
  reply = endpoint => {
    if (endpoint === 'git/ref/tags/old%2Ftag') return { object: { type: 'tag', sha: sha(7) } };
    if (endpoint === `git/tags/${sha(7)}`) return { object: { type: 'tag', sha: sha(8) } };
    if (endpoint === `git/tags/${sha(8)}`) return { object: { type: 'commit', sha: sha(1) } };
    return original(endpoint);
  };
  const { draftContext } = await releaseDraftContext({ id: 1, previousTag: 'old/tag' });
  assert.equal(draftContext.baseSha, sha(1));
  assert(!calls.some(call => call.endpoint.startsWith('releases?')));
});

test('missing draft tag resolves its remote target; other failures never fall back', async () => {
  const original = reply;
  reply = endpoint => {
    if (endpoint === 'git/ref/tags/v2') throw new Error('gh: Not Found (HTTP 404)');
    if (endpoint === 'commits/main') return { sha: sha(9) };
    return original(endpoint);
  };
  assert.equal((await releaseDraftContext({ id: 1 })).draftContext.targetSha, sha(9));
  reply = () => { throw new Error('HTTP 403'); };
  await assert.rejects(releaseDraftContext({ id: 1 }), /403/);
});

test('initial release pages through the full pinned remote history', async () => {
  published = [];
  const original = reply;
  reply = endpoint => endpoint.startsWith('commits?')
    ? Array.from({ length: endpoint.endsWith('page=1') ? 100 : 2 }, (_, i) => ({ sha: sha(endpoint.endsWith('page=1') ? 102 - i : 2 - i), commit: { message: `change ${i}` } }))
    : original(endpoint);
  const { draftContext } = await releaseDraftContext({ id: 1 });
  assert.equal(draftContext.baseTag, null);
  assert.equal(draftContext.commitCount, 102);
  assert.equal(draftContext.commits[0].sha, sha(1));
  assert(calls.some(call => call.endpoint === `commits?sha=${sha(2)}&per_page=100&page=2`));
});

test('comparison pagination includes more than 250 commits without duplicates', async () => {
  const original = reply;
  reply = endpoint => {
    if (!endpoint.startsWith('compare/')) return original(endpoint);
    const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
    const start = (page - 1) * 100;
    return { status: 'ahead', total_commits: 301, commits: Array.from({ length: Math.min(100, 301 - start) }, (_, i) => ({ sha: sha(start + i + 10), commit: { message: `commit ${start + i}` } })) };
  };
  const { draftContext } = await releaseDraftContext({ id: 1 });
  assert.equal(draftContext.commitCount, 301);
  assert.equal(draftContext.commits.at(-1).message, 'commit 300');
  assert.equal(calls.filter(call => call.endpoint.startsWith('compare/')).length, 4);
});

test('identical targets return an empty range; reversed and unrelated ranges require a new base', async () => {
  const original = reply;
  for (const status of ['identical', 'behind', 'diverged']) {
    reply = endpoint => endpoint.startsWith('compare/') ? { status, total_commits: 0, commits: [] } : original(endpoint);
    if (status === 'identical') assert.equal((await releaseDraftContext({ id: 1 })).draftContext.commitCount, 0);
    else await assert.rejects(releaseDraftContext({ id: 1 }), /Choose another previous tag/);
  }
});

test('incomplete comparisons and missing base tags fail rather than returning partial context', async () => {
  const original = reply;
  reply = endpoint => endpoint.startsWith('compare/') ? { status: 'ahead', total_commits: 2, commits: [] } : original(endpoint);
  await assert.rejects(releaseDraftContext({ id: 1 }), /every commit/);
  reply = endpoint => {
    if (endpoint === 'git/ref/tags/v1') throw new Error('HTTP 404');
    return original(endpoint);
  };
  await assert.rejects(releaseDraftContext({ id: 1 }), /404/);
});

test('release pagination considers later pages and excludes the selected release', async () => {
  published = endpoint => endpoint.endsWith('page=1')
    ? Array.from({ length: 100 }, (_, i) => ({ id: i + 20, draft: true }))
    : [{ id: 1, draft: false, published_at: '2027-01-01', tag_name: 'v2' },
      { id: 2, draft: false, published_at: '2026-01-01', tag_name: 'v1' }];
  assert.equal((await releaseDraftContext({ id: 1 })).draftContext.baseTag, 'v1');
  assert(calls.some(call => call.endpoint.endsWith('per_page=100&page=2')));
});

test('published and immutable releases are rejected', async () => {
  release.draft = false;
  await assert.rejects(releaseDraftContext({ id: 1 }), /editable draft/);
  release.draft = true;
  release.immutable = true;
  await assert.rejects(releaseDraftContext({ id: 1 }), /editable draft/);
});
