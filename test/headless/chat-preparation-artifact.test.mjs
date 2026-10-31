import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureChatPreparationArtifact } from '../../server/runtime/chat-preparation-artifact.js';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-artifact-'));
  const write = async (relative, text = 'source') => {
    const full = path.join(root, relative); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, text);
  };
  try { await run({ root, write, artifact: path.join(root, 'dist-headless/chat-preparation.mjs') }); }
  finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('source-only server startup builds a missing composer with the existing builder before continuing', async () => {
  await fixture(async ({ root, write, artifact }) => {
    await write('src/headless/chat-preparation.ts'); await write('scripts/build-headless-runner.mjs');
    let imports = 0;
    const result = await ensureChatPreparationArtifact({ appRoot: root, env: { NODE_ENV: 'development' },
      importBuilder: async url => {
        imports++; assert.ok(url.endsWith('/scripts/build-headless-runner.mjs'));
        return { async buildChatPreparation({ outfile }) { assert.equal(outfile, artifact); await write('dist-headless/chat-preparation.mjs', 'export const ready=true;'); } };
      } });
    assert.equal(result.built, true); assert.equal(imports, 1);
    assert.equal(await fs.readFile(artifact, 'utf8'), 'export const ready=true;');
  });
});

test('existing artifacts skip all builder imports, including packaged production without TS or esbuild', async () => {
  await fixture(async ({ root, write }) => {
    await write('dist-headless/chat-preparation.mjs', 'export const ready=true;');
    const result = await ensureChatPreparationArtifact({ appRoot: root, env: { NODE_ENV: 'production' },
      importBuilder: async () => { throw new Error('Never import esbuild'); } });
    assert.equal(result.built, false);
  });
});

test('missing packaged/production artifacts fail explicitly without importing dev dependencies', async () => {
  await fixture(async ({ root, write }) => {
    const importBuilder = async () => { throw new Error('Never import esbuild'); };
    await assert.rejects(ensureChatPreparationArtifact({ appRoot: root, env: {}, importBuilder }), error => error.code === 'capability_unavailable');
    await write('src/headless/chat-preparation.ts'); await write('scripts/build-headless-runner.mjs');
    await assert.rejects(ensureChatPreparationArtifact({ appRoot: root, env: { NODE_ENV: 'production' }, importBuilder }), error => error.code === 'capability_unavailable');
  });
});

test('concurrent source callers share one build and a builder without output cannot report success', async () => {
  await fixture(async ({ root, write }) => {
    await write('src/headless/chat-preparation.ts'); await write('scripts/build-headless-runner.mjs');
    let calls = 0;
    const options = { appRoot: root, env: {}, importBuilder: async () => ({ async buildChatPreparation() {
      calls++; await new Promise(resolve => setImmediate(resolve)); await write('dist-headless/chat-preparation.mjs');
    } }) };
    await Promise.all([ensureChatPreparationArtifact(options), ensureChatPreparationArtifact(options)]);
    assert.equal(calls, 1);
    await fs.rm(path.join(root, 'dist-headless/chat-preparation.mjs'));
    await assert.rejects(ensureChatPreparationArtifact({ appRoot: root, env: {},
      importBuilder: async () => ({ async buildChatPreparation() {} }) }), error => error.code === 'capability_unavailable');
  });
});
