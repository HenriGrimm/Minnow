/**
 * Skills Library API client tests (MIN-477).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('skills library-api', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('getOfflineLibraryPacks returns five curated packs with counts', async () => {
    const { getOfflineLibraryPacks } = await import('../../src/skills/library-api.ts');
    const packs = getOfflineLibraryPacks();
    assert.equal(packs.length, 5);
    const ids = packs.map((pack) => pack.id).sort();
    assert.deepEqual(ids, [
      'addy-osmani',
      'browserbase',
      'last30days',
      'matt-pocock',
      'superpowers',
    ]);
    const matt = packs.find((pack) => pack.id === 'matt-pocock');
    assert.ok(matt);
    assert.ok(matt.totalCount > 0);
    assert.equal(matt.trust, 'official');
  });

  test('searchOfflineLibrarySkills finds grill-me in matt-pocock', async () => {
    const { searchOfflineLibrarySkills } = await import('../../src/skills/library-api.ts');
    const hits = searchOfflineLibrarySkills('grill-me');
    assert.ok(hits.some((hit) => hit.packId === 'matt-pocock' && hit.skill.skillId === 'grill-me'));
  });

  test('fetchLibraryPacks falls back to offline packs when fetch fails', async () => {
    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(true);

    globalThis.fetch = async () => {
      throw new Error('network down');
    };

    const { fetchLibraryPacks } = await import('../../src/skills/library-api.ts');
    const packs = await fetchLibraryPacks();
    assert.equal(packs.length, 5);
    assert.equal(packs[0].installedCount, 0);
  });

  test('installPackSkills rejects when server unavailable', async () => {
    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(false);

    const { installPackSkills } = await import('../../src/skills/library-api.ts');
    await assert.rejects(
      () => installPackSkills('matt-pocock', { skillIds: ['grill-me'] }),
      /needs network/i,
    );
  });

  test('installPackSkills returns per-skill partial results', async () => {
    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(true);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: false,
        installed: [{ skillId: 'one' }],
        skipped: [{ skillId: 'two', reason: 'already installed' }],
        failed: [{ skillId: 'three', error: 'local changes' }],
      }),
    });
    const { installPackSkills } = await import('../../src/skills/library-api.ts');
    const result = await installPackSkills('pack', { all: true });
    assert.deepEqual(result.installed.map((row) => row.skillId), ['one']);
    assert.deepEqual(result.skipped.map((row) => row.skillId), ['two']);
    assert.deepEqual(result.failed.map((row) => row.skillId), ['three']);
  });

  test('installSkillFromGitHubUrl posts repoUrl and subpath', async () => {
    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(true);

    let postedBody = '';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.equal(url, '/api/skills/library/install');
      assert.equal(init?.method, 'POST');
      postedBody = String(init?.body ?? '');
      return {
        ok: true,
        json: async () => ({ ok: true, installed: [{ skillId: 'custom-skill' }] }),
      };
    };

    const { installSkillFromGitHubUrl } = await import('../../src/skills/library-api.ts');
    const installed = await installSkillFromGitHubUrl(
      'https://github.com/example/repo',
      'skills/foo',
    );
    assert.equal(installed[0]?.skillId, 'custom-skill');
    assert.match(postedBody, /example\/repo/);
    assert.match(postedBody, /skills\/foo/);
  });
});
