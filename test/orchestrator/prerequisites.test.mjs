import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import { normalizePrerequisites, prerequisitesReady } from '../../server/orchestrator/prerequisites.js';
import { parseBuilderReport, parseTesterReport } from '../../server/orchestrator/report-tool.js';
import { taskVerificationContract, validateVerificationChecks } from '../../server/orchestrator/verification-contract.js';

test('file and local-service prerequisites become ready without commands or model requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-readiness-'));
  const service = net.createServer(socket => socket.end());
  try {
    const file = [{ kind: 'file', path: 'inputs/prototype.html' }];
    assert.equal(await prerequisitesReady(file, root), false);
    await fs.mkdir(path.join(root, 'inputs'));
    await fs.writeFile(path.join(root, 'inputs/prototype.html'), 'reference');
    assert.equal(await prerequisitesReady(file, root), true);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    const check = [{ kind: 'service', port: service.address().port }];
    assert.equal(await prerequisitesReady(check, root), true);
    await new Promise(resolve => service.close(resolve));
    assert.equal(await prerequisitesReady(check, root), false);
    for (const value of [[{ kind: 'file', path: '../secret' }], [{ kind: 'executable', name: 'node; rm' }], [{ kind: 'service', port: 0 }], [{ kind: 'command', command: 'npm install' }]]) assert.throws(() => normalizePrerequisites(value));
  } finally { service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('blocked reports preserve typed prerequisites and reject unsafe descriptors', () => {
  const base = { outcome: 'blocked', summary: 'Reference missing', evidence: [], testOutput: 'Provide inputs/prototype.html', needs: ['Provide prototype'], blockers: [], prerequisites: [{ kind: 'file', path: 'inputs/prototype.html' }] };
  for (const parse of [parseBuilderReport, parseTesterReport]) {
    assert.deepEqual(parse(base).result.prerequisites, base.prerequisites);
    assert.equal(parse({ ...base, prerequisites: [{ kind: 'file', path: '../../other-workspace/file' }] }).ok, false);
  }
});

test('required verification identities change on spec edits and cannot be waived by missing checks', () => {
  const task = { id: 'A', testSpec: 'Run npm test and browser smoke', accept: 'Form submits successfully' };
  const contract = taskVerificationContract(task);
  assert.equal(contract[0].required, true);
  assert.notEqual(taskVerificationContract({ ...task, accept: 'New requirement' })[0].id, contract[0].id);
  for (const checks of [undefined, [], [{ id: contract[0].id, outcome: 'not-run', evidence: ['Unsupported'] }], [{ id: contract[0].id, outcome: 'pass', evidence: [] }]]) assert.ok(validateVerificationChecks(checks, contract));
  assert.equal(validateVerificationChecks([{ id: contract[0].id, outcome: 'pass', evidence: ['npm test: 8 passed; browser: successful submission'] }], contract), null);
});
