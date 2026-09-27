import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultShipGateConfig,
  loadShipGateState,
  normalizeShipGateConfig,
  saveShipGateConfig,
  saveShipGateEvidence,
  SHIP_GATE_CONFIG_FILE,
  SHIP_GATE_EVIDENCE_FILE,
} from '../../server/ship-gate/config.js';

test('safe defaults reuse project scripts and keep security checks opt-in', () => {
  const config = defaultShipGateConfig({
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'node --test',
      build: 'vite build',
      'check:performance-budgets': 'node scripts/perf.mjs',
      'check:secrets': 'gitleaks detect --redact',
    },
  });

  assert.equal(config.policy, 'warn');
  assert.deepEqual(
    config.checks.filter((check) => check.enabled).map((check) => check.id),
    ['typecheck', 'tests', 'build', 'performance', 'secrets'],
  );
  assert.equal(config.checks.find((check) => check.id === 'dependencies').enabled, false);
  assert.equal(config.checks.find((check) => check.id === 'performance').command, 'npm run check:performance-budgets');
});

test('normalization preserves only known checks and explicit commands', () => {
  const config = normalizeShipGateConfig({
    enabled: true,
    policy: 'block',
    checks: [
      { id: 'tests', enabled: false, command: 'pnpm test' },
      { id: 'unknown', enabled: true, command: 'curl example.com' },
    ],
  });
  assert.equal(config.policy, 'block');
  assert.equal(config.checks.length, 6);
  assert.deepEqual(config.checks.find((check) => check.id === 'tests'), {
    id: 'tests', label: 'Tests', enabled: false, command: 'pnpm test',
  });
  assert.equal(config.checks.some((check) => check.id === 'unknown'), false);
});

test('project config and local evidence round-trip in separate files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ship-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', build: 'vite build' } }));

  await saveShipGateConfig(root, {
    policy: 'block',
    checks: [{ id: 'tests', enabled: true, command: 'npm test -- --watch=false' }],
  });
  await saveShipGateEvidence(root, {
    outcome: 'pass',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    headSha: 'abc123',
    gitFingerprint: '[]',
    configSignature: 'sig',
    checks: [{ id: 'tests', command: 'npm test', outcome: 'pass', exitCode: 0, durationMs: 10, runId: 'run-1', outputTail: 'ok' }],
  });

  const state = await loadShipGateState(root);
  assert.equal(state.config.policy, 'block');
  assert.equal(state.evidence.outcome, 'pass');
  assert.equal(state.evidence.checks[0].runId, 'run-1');
  await fs.access(path.join(root, SHIP_GATE_CONFIG_FILE));
  await fs.access(path.join(root, SHIP_GATE_EVIDENCE_FILE));
});

test('refuses a ship-gate evidence directory that redirects outside the workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ship-gate-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ship-gate-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  try {
    await fs.symlink(outside, path.join(root, '.minnow'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('Creating a symlink requires additional privileges on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(
    () => saveShipGateEvidence(root, { outcome: 'pass', checks: [] }),
    /local workspace directory|outside the workspace/,
  );
  await assert.rejects(() => fs.access(path.join(outside, 'ship-gate-evidence.json')));
});
