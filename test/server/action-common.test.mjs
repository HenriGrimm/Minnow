import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const calls = [];
mock.module('../../server/git/forge-ops.js', {
  namedExports: {
    gh: async (args) => { calls.push(args); return { code: 0, stdout: '{"permissions":{"push":true}}' }; },
    requireForge: async () => ({ ok: true }),
    processError: () => 'Request failed',
  },
});
const { github } = await import('../../server/git/action-common.js');

test('repository permission requests omit the trailing slash that GitHub rejects', async () => {
  const context = { cwd: '.', hostname: 'github.example.com', repo: 'owner/repo' };
  const result = await github(context, '');
  assert.equal(result.permissions.push, true);
  assert.deepEqual(calls.at(-1), ['api', '--hostname', 'github.example.com', '--method', 'GET', 'repos/owner/repo']);
  await github(context, 'releases/42');
  assert.equal(calls.at(-1).at(-1), 'repos/owner/repo/releases/42');
});
