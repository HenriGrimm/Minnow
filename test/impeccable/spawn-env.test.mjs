/**
 * Packaged Electron must spawn Impeccable scripts as Node, not a second app.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyNodeRuntimeEnv } from '../../server/lsp/node-runtime.js';
import { buildImpeccableSpawnEnv } from '../../server/impeccable/spawn-env.js';

const WORKSPACE = '/tmp/minnow-impeccable-workspace';

describe('impeccable spawn env', () => {
  it('leaves ELECTRON_RUN_AS_NODE unset when the server is plain node', () => {
    const env = buildImpeccableSpawnEnv(WORKSPACE);
    assert.equal(env.ELECTRON_RUN_AS_NODE, process.env.ELECTRON_RUN_AS_NODE);
    assert.equal(env.IMPECCABLE_CONTEXT_DIR, WORKSPACE);
  });

  it('sets ELECTRON_RUN_AS_NODE when spawning the Electron binary', () => {
    const hadElectron = 'electron' in process.versions;
    process.versions.electron = '43.0.0-test';
    try {
      const env = buildImpeccableSpawnEnv(WORKSPACE);
      assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(env.IMPECCABLE_CONTEXT_DIR, WORKSPACE);

      const nativeBin = applyNodeRuntimeEnv({ PATH: '/usr/bin' }, 'rust-analyzer');
      assert.equal(nativeBin.ELECTRON_RUN_AS_NODE, undefined);
    } finally {
      if (!hadElectron) delete process.versions.electron;
    }
  });
});
