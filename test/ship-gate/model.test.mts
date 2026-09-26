import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessShipGateEvidence,
  gitStateFingerprint,
  type ShipGateConfig,
  type ShipGateEvidence,
} from '../../src/ship-gate/model.ts';

const config: ShipGateConfig = {
  version: 1,
  enabled: true,
  policy: 'warn',
  checks: [{ id: 'tests', label: 'Tests', enabled: true, command: 'npm test' }],
};

const evidence: ShipGateEvidence = {
  version: 1,
  outcome: 'pass',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
  headSha: 'abc123',
  gitFingerprint: '[dirty]',
  configSignature: 'config-a',
  checks: [],
};

test('git fingerprint is stable across API bucket order', () => {
  const one = gitStateFingerprint({ ok: true, staged: [{ path: 'b.ts', status: 'M' }], unstaged: [{ path: 'a.ts', status: 'M' }] });
  const two = gitStateFingerprint({ ok: true, unstaged: [{ path: 'a.ts', status: 'M' }], staged: [{ path: 'b.ts', status: 'M' }] });
  assert.equal(one, two);
  assert.notEqual(one, gitStateFingerprint({ ok: true, unstaged: [{ path: 'a.ts', status: 'M' }], staged: [{ path: 'b.ts', status: 'M' }] }, 'changed content'));
});

test('passing evidence must match config, HEAD, and working tree', () => {
  assert.equal(assessShipGateEvidence({ config, configSignature: 'config-a', evidence, headSha: 'abc123', gitFingerprint: '[dirty]' }), 'passed');
  assert.equal(assessShipGateEvidence({ config, configSignature: 'config-b', evidence, headSha: 'abc123', gitFingerprint: '[dirty]' }), 'stale');
  assert.equal(assessShipGateEvidence({ config, configSignature: 'config-a', evidence, headSha: 'def456', gitFingerprint: '[dirty]' }), 'stale');
  assert.equal(assessShipGateEvidence({ config, configSignature: 'config-a', evidence, headSha: 'abc123', gitFingerprint: '[]' }), 'stale');
});

test('disabled, missing, and failed states stay distinct', () => {
  assert.equal(assessShipGateEvidence({ config: { ...config, enabled: false }, configSignature: '', evidence: null, headSha: null, gitFingerprint: '' }), 'disabled');
  assert.equal(assessShipGateEvidence({ config, configSignature: '', evidence: null, headSha: null, gitFingerprint: '' }), 'missing');
  assert.equal(assessShipGateEvidence({ config, configSignature: 'config-a', evidence: { ...evidence, outcome: 'fail' }, headSha: 'abc123', gitFingerprint: '[dirty]' }), 'failed');
});
