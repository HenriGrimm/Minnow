import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson } from '../../server/config/store.js';
import { updateOnboarding, ONBOARDING_LEASE_MS } from '../../server/config/onboarding.js';

let home;
const previousHome = process.env.MINNOW_HOME;
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-onboarding-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});
after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(home, { recursive: true, force: true });
});

test('simultaneous setup claims have one winner and only its owner can save/release', async () => {
  const claims = await Promise.all(['a', 'b'].map(owner => updateOnboarding({ action: 'claim', owner }, 1000)));
  assert.deepEqual(claims.map(result => result.claimed), [true, false]);
  await assert.rejects(updateOnboarding({ action: 'save', owner: 'b', state: claims[0].state }, 1001), /another window/);
  await updateOnboarding({ action: 'release', owner: 'b' }, 1002);
  assert.equal((await readConfigJson('onboarding.json')).overlayOwner, 'a');
  await updateOnboarding({ action: 'renew', owner: 'a' }, 2000);
  assert.equal((await readConfigJson('onboarding.json')).overlayExpiresAt, 2000 + ONBOARDING_LEASE_MS);
  assert.equal((await updateOnboarding({ action: 'claim', owner: 'b' }, 2001)).claimed, false);
});

test('expired crashed owner can be replaced and its stale release/renew cannot touch new owner', async () => {
  const replacement = await updateOnboarding({ action: 'claim', owner: 'b' }, 40_000);
  assert.equal(replacement.claimed, true);
  await updateOnboarding({ action: 'release', owner: 'a' }, 40_001);
  await assert.rejects(updateOnboarding({ action: 'renew', owner: 'a' }, 40_001), /another window/);
  assert.equal((await readConfigJson('onboarding.json')).overlayOwner, 'b');
});

test('explicit rerun cannot reset another live window and completion persists before releasing', async () => {
  const blocked = await updateOnboarding({ action: 'claim', owner: 'c', reset: true }, 40_002);
  assert.equal(blocked.claimed, false);
  const state = { ...blocked.state, completedAt: '2026-10-01T00:00:00.000Z', lastStep: 'done' };
  await updateOnboarding({ action: 'save', owner: 'b', state }, 40_003);
  await updateOnboarding({ action: 'release', owner: 'b' }, 40_004);
  assert.equal((await readConfigJson('onboarding.json')).completedAt, state.completedAt);
  assert.equal((await updateOnboarding({ action: 'claim', owner: 'c' }, 40_005)).claimed, false);
  const rerun = await updateOnboarding({ action: 'claim', owner: 'c', reset: true }, 40_006);
  assert.equal(rerun.claimed, true);
  assert.equal(rerun.state.completedAt, null);
});
