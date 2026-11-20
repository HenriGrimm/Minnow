/**
 * Memory search: precise, scoped, no recency fallback.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { createPage } from '../../server/brain/store.js';
import { clearMemoryProjectCache, resolveMemoryProject } from '../../server/brain/memory/scope.js';
import { createMemory } from '../../server/brain/memory/store.js';
import { rankMemories, searchMemories, specificTerms } from '../../server/brain/memory/search.js';

const deps = { config: { embeddings: { enabled: false } } };
let homeDir;
let scratch;
let minnow;
let keylogic;
const ids = {};

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-memory-search-'));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-memory-search-repos-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await ensureMinnowLayout();
  const configPath = path.join(homeDir, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.brain = { ...(config.brain ?? {}), embeddings: { enabled: false } };
  config.memory = { ...(config.memory ?? {}), embeddings: { enabled: false } };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  minnow = await resolveMemoryProject(await makeRepo(path.join(scratch, 'minnow')));
  keylogic = await resolveMemoryProject(await makeRepo(path.join(scratch, 'keylogic')));
  const save = async (name, project, fields) => {
    ids[name] = (await createMemory({ project, kind: 'decision', ...fields }, deps)).meta.id;
  };
  await save('gitbox', minnow, { title: 'Gitbox sync runs through the gh CLI', body: 'Source Control uses gh for PR lists; Minnow stores no GitHub credentials.', kind: 'constraint' });
  await save('gitboxOld', minnow, { title: 'Gitbox sync scrapes github.com', body: 'Old approach used the browser for PR lists.' });
  await save('gitboxNew', minnow, { title: 'Gitbox PR lists use gh pr list', body: 'Replaces browser scraping for gitbox PR lists.', supersedes: [ids.gitboxOld] });
  await save('worktrees', minnow, { title: 'Windows worktrees need core.longpaths', body: 'Deep worktree paths fail on Windows without core.longpaths=true.', kind: 'gotcha' });
  await save('pref', null, { title: 'User wants terse final summaries', body: 'Short reports with path:line references.', kind: 'preference', scope: 'user' });
  // Distractors in another project that share words with Minnow queries.
  await save('keylogicGitbox', keylogic, { title: 'Gitbox in KeyLogic is a vendored fork', body: 'KeyLogic patches gitbox sync locally.' });
  await save('keylogicWorktrees', keylogic, { title: 'KeyLogic worktrees live under build', body: 'worktrees are created under build/wt.' });
  // Legacy global pages that the old retrieval returned for everything.
  await createPage({ relPath: 'facts/gitbox-legacy.md', title: 'Gitbox legacy note', body: 'gitbox gitbox gitbox', tags: ['gitbox'], pinned: true, skipVectorSync: true });
  await createPage({ relPath: 'workspaces/minnow--0123/gitbox.md', title: 'Gitbox workspace note', body: 'gitbox', skipVectorSync: true });
});

after(async () => {
  closeCodeDbForTests();
  closeSessionsDb();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  clearMemoryProjectCache();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('memory search', () => {
  test('a nonsense or generic query returns nothing', async () => {
    assert.deepEqual(await searchMemories({ query: 'zqxj flurble wibble', project: minnow }, deps), []);
    assert.deepEqual(await searchMemories({ query: 'help me fix this code', project: minnow }, deps), []);
    assert.deepEqual(await searchMemories({ query: '   ', project: minnow }, deps), []);
  });

  test('legacy pages and other projects never appear', async () => {
    const hits = await searchMemories({ query: 'gitbox sync', project: minnow, limit: 10 }, deps);
    const hitIds = hits.map(hit => hit.id);
    assert.ok(hitIds.includes(ids.gitbox));
    assert.ok(!hitIds.includes(ids.keylogicGitbox));
    assert.ok(hits.every(hit => !/legacy|workspace note/i.test(hit.title)));
    const fromKeylogic = await searchMemories({ query: 'gitbox', project: keylogic, limit: 10 }, deps);
    assert.deepEqual(fromKeylogic.map(hit => hit.id), [ids.keylogicGitbox]);
  });

  test('a superseded memory never appears beside its replacement', async () => {
    const hits = await searchMemories({ query: 'gitbox PR lists browser scraping', project: minnow, limit: 10 }, deps);
    const hitIds = hits.map(hit => hit.id);
    assert.ok(hitIds.includes(ids.gitboxNew));
    assert.ok(!hitIds.includes(ids.gitboxOld));
  });

  test('results are compact, filterable by kind and capped', async () => {
    const [hit] = await searchMemories({ query: 'longpaths windows', project: minnow }, deps);
    assert.deepEqual(Object.keys(hit).sort(), ['id', 'kind', 'scope', 'summary', 'title', 'updated']);
    assert.equal(hit.id, ids.worktrees);
    assert.equal(hit.kind, 'gotcha');
    assert.match(hit.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(hit.summary.length <= 160);
    const constraints = await searchMemories({ query: 'gitbox', project: minnow, kind: 'constraint' }, deps);
    assert.deepEqual(constraints.map(h => h.id), [ids.gitbox]);
    const one = await searchMemories({ query: 'gitbox', project: minnow, limit: 1 }, deps);
    assert.equal(one.length, 1);
  });

  test('user preferences are searchable from any project', async () => {
    for (const project of [minnow, keylogic, null]) {
      const hits = await searchMemories({ query: 'terse summaries', project }, deps);
      assert.deepEqual(hits.map(h => h.id), [ids.pref]);
      assert.equal(hits[0].scope, 'user');
    }
  });

  test('semantic matches need cosine >= 0.45 and project ranks above user on ties', () => {
    const entries = [
      { meta: { id: 'u', title: 'Alpha', scope: 'user', updatedAt: '2026-02-01' }, body: 'x' },
      { meta: { id: 'p', title: 'Alpha', scope: 'project', updatedAt: '2026-01-01' }, body: 'x' },
      { meta: { id: 'weak', title: 'Unrelated', scope: 'project', updatedAt: '2026-01-01' }, body: 'y' },
    ];
    const similarities = new Map([['u', 0.6], ['p', 0.6], ['weak', 0.44]]);
    const hits = rankMemories(entries, { query: 'zzzz', similarities });
    assert.deepEqual(hits.map(h => h.id), ['p', 'u']);
  });

  test('specificTerms drops broad words', () => {
    assert.deepEqual(specificTerms('How do we fix the Gitbox build?'), ['gitbox']);
  });

  test('keyword search supports short design topics and Unicode', () => {
    const entries = [
      { meta: { id: 'ci', title: 'CI uses Linux', scope: 'project' }, body: 'Runner constraints.' },
      { meta: { id: 'unicode', title: '日本語の設定', scope: 'project' }, body: 'Verified preference.' },
    ];
    assert.deepEqual(rankMemories(entries, { query: 'CI' }).map(hit => hit.id), ['ci']);
    assert.deepEqual(rankMemories(entries, { query: '日本語の設定' }).map(hit => hit.id), ['unicode']);
  });
});
