// Run from the repository root: node documentation/reviews/2026-10-23/evidence/08-secret-init-race.mjs
// Uses only synthetic strings in a fresh temporary home. Never prints key material.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-secret-race-'));
const priorHome = process.env.MINNOW_HOME;
process.env.MINNOW_HOME = home;
try {
  const { encryptSecretPayload, decryptSecretPayload } = await import('../../../../server/security/secret-box.js');
  const envelopes = await Promise.all(Array.from({ length: 32 }, (_, index) => encryptSecretPayload('synthetic-review-value-' + index)));
  let decrypted = 0;
  for (const envelope of envelopes) {
    try { await decryptSecretPayload(envelope); decrypted++; } catch { /* Count only, no error payload. */ }
  }
  const result = { encryptionsSucceeded: envelopes.length, decryptionsSucceeded: decrypted, decryptionsFailed: envelopes.length - decrypted };
  console.log(JSON.stringify(result));
  assert.equal(decrypted, envelopes.length, 'Concurrent initialization must retain a key that decrypts every successful encryption');
} finally {
  if (priorHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = priorHome;
  const resolved = path.resolve(home);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('minnow-review-secret-race-'));
  await fs.rm(resolved, { recursive: true, force: true });
}

