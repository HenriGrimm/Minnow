import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { workspaceClaimHttpBase } from '../../electron/workspace-claim-transport.ts';

describe('workspaceClaimHttpBase', () => {
  const devUrl = 'http://localhost:9473/';

  test('prefers the in-process server when it is up', () => {
    assert.equal(
      workspaceClaimHttpBase({
        isDev: false,
        inProcessUrl: 'http://127.0.0.1:9473/',
        devUrl,
      }),
      'http://127.0.0.1:9473',
    );
  });

  test('uses the Vite origin only in Electron-dev', () => {
    assert.equal(
      workspaceClaimHttpBase({
        isDev: true,
        inProcessUrl: null,
        devUrl,
      }),
      'http://localhost:9473',
    );
  });

  test('does not fall back to the leftover Vite origin in a packaged build', () => {
    assert.equal(
      workspaceClaimHttpBase({
        isDev: false,
        inProcessUrl: null,
        devUrl,
      }),
      null,
    );
  });
});
