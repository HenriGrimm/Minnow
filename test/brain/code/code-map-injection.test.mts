/**
 * retrieveCodeMapBlock wraps repo map text as untrusted.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { setLocalServerAvailableForTests } from '../../../src/tools/config.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setLocalServerAvailableForTests(false);
});

describe('retrieveCodeMapBlock', () => {
  it('wraps map text with code-map source fence', async () => {
    setLocalServerAvailableForTests(true);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/brain/code/config')) {
        return {
          ok: true,
          json: async () => ({
            code: { enabled: true, repoMapTokenBudget: 1500, repoMapInjectionTokenBudget: 1200 },
          }),
        } as Response;
      }
      if (url.includes('/api/brain/code/repo-map') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        assert.equal(body.profile, 'injection');
        assert.equal(body.workspaceRoot, 'C:/Users/dev/my-app');
        assert.equal(body.repo, undefined);
        return {
          ok: true,
          json: async () => ({
            text: 'src/foo.ts\n  function bar()',
            truncated: false,
            tokenEstimate: 10,
          }),
        } as Response;
      }
      return { ok: false } as Response;
    };

    const { retrieveCodeMapBlock } = await import(
      '../../../src/brain/code-map-injection.ts'
    );
    const block = await retrieveCodeMapBlock({
      repoPath: 'C:/Users/dev/my-app',
      focus: 'bar',
    });
    assert.match(block, /<<<UNTRUSTED_SOURCE_DATA source="code-map">>>/);
    assert.match(block, /function bar/);
  });
});
