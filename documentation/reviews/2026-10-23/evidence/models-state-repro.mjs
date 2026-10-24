/** Offline review evidence. From repository root: node documentation/reviews/2026-10-23/evidence/models-state-repro.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-models-evidence-'));
process.env.MINNOW_HOME = scratch;
process.env.HF_TOKEN = 'review-fixture-not-a-credential';
globalThis.fetch = async () => { throw new Error('Review evidence must not use network'); };
try {
  const { AllowanceTracker, allowanceFailure } = await import('../../../../server/generations/allowance.js');
  let now = 100;
  const tracker = new AllowanceTracker({ now: () => now });
  const context = { identity: 'fixture-account', modelId: 'model-a' };
  tracker.record(context, { kind: 'quota', scope: 'model', resetAt: 100_000 });
  tracker.record(context, allowanceFailure('ECONNREFUSED', { now }));
  now = 40_000;
  const availability = tracker.availability(context);
  const claim = tracker.claim(context);
  assert.equal(availability.available, true); // Defect: model quota is still blocked.
  assert.ok(claim);
  claim.finish(null);
  console.log(JSON.stringify({ overlappingAllowanceScopes: { available: availability.available, modelQuotaResetAt: 100_000, now } }));

  const { readConfigJson, writeConfigJson } = await import('../../../../server/config/store.js');
  const { patchModelsConfig } = await import('../../../../server/models/models-config.js');
  await writeConfigJson('config.json', { models: {} });
  await Promise.all([
    patchModelsConfig({ reviewFirst: true }),
    patchModelsConfig({ reviewSecond: true }),
  ]);
  const models = (await readConfigJson('config.json')).models;
  assert.equal(Boolean(models.reviewFirst && models.reviewSecond), false);
  console.log(JSON.stringify({ concurrentModelPatches: models }));

  await patchModelsConfig({ hfToken: 'review-dummy-hf-token' });
  const persisted = await fs.readFile(path.join(scratch, 'config.json'), 'utf8');
  assert.ok(persisted.includes('review-dummy-hf-token'));
  console.log(JSON.stringify({ hfTokenPlaintext: true, token: '[dummy fixture only]' }));

  const { downloadHfFile } = await import('../../../../server/models/hf-client.js');
  const corruptFile = path.join(scratch, 'corrupt.gguf');
  await fs.writeFile(corruptFile, 'BAD');
  const download = await downloadHfFile({ repoId: 'review/fixture', filename: 'model.gguf', destPath: corruptFile });
  assert.deepEqual(download, { bytesReceived: 3, totalBytes: 3 });
  assert.equal(await fs.readFile(corruptFile, 'utf8'), 'BAD');
  console.log(JSON.stringify({ unverifiedExistingDownload: download, originalCorruptionRetained: true }));
} finally {
  assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(0);
