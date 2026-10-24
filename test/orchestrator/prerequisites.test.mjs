import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { test } from 'node:test';
import { normalizePrerequisites, prerequisitesReady } from '../../server/orchestrator/prerequisites.js';
import { parseBuilderReport, parseTesterReport } from '../../server/orchestrator/report-tool.js';
import { taskVerificationContract, validateVerificationChecks } from '../../server/orchestrator/verification-contract.js';
import { execLadderCommand } from '../../server/orchestrator/final-test.js';

test('desktop readiness and verification use the login PATH without executing prerequisite binaries', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-board-login-'));
  const saved = Object.fromEntries(['PATH', 'SHELL', 'HOME', 'ZDOTDIR'].map(key => [key, process.env[key]]));
  try {
    const bin = path.join(root, 'tool bin');
    const project = path.join(root, 'project with spaces');
    await fs.mkdir(bin);
    await fs.mkdir(project);
    await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nprintf "verifier-ran" > verified.txt\n', { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'not-executable'), 'not executable', { mode: 0o644 });
    const profile = `echo 'login banner'\nexport PATH='${bin.replaceAll("'", "'\\''")}':/usr/bin:/bin\n`;
    await fs.writeFile(path.join(root, '.zprofile'), profile);
    await fs.writeFile(path.join(root, '.bash_profile'), profile);
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    process.env.HOME = root;
    process.env.ZDOTDIR = root;

    assert.equal(await prerequisitesReady([{ kind: 'executable', name: 'npm' }], project), true);
    await assert.rejects(fs.stat(path.join(project, 'verified.txt')), { code: 'ENOENT' });
    assert.equal(await prerequisitesReady([{ kind: 'executable', name: 'not-executable' }], project), false);
    assert.equal(await prerequisitesReady([{ kind: 'executable', name: 'minnow-missing-verifier' }], project), false);
    const result = await execLadderCommand('npm test', { cwd: project });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(await fs.readFile(path.join(project, 'verified.txt'), 'utf8'), 'verifier-ran');

    const localBin = path.join(project, 'node_modules', '.bin');
    await fs.mkdir(localBin, { recursive: true });
    await fs.writeFile(path.join(localBin, 'npm'), '#!/bin/sh\necho checkout-tool\n', { mode: 0o755 });
    await fs.writeFile(path.join(localBin, 'minnow-checkout-verifier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(await prerequisitesReady([{ kind: 'executable', name: 'minnow-checkout-verifier' }], project), true);
    assert.match((await execLadderCommand('npm test', { cwd: project })).output, /checkout-tool/);

    // Recovery probes must notice newly installed tools without restarting Minnow.
    await fs.writeFile(path.join(bin, 'minnow-new-verifier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(await prerequisitesReady([{ kind: 'executable', name: 'minnow-new-verifier' }], project), true);

    process.env.SHELL = path.join(root, 'missing', 'zsh');
    process.env.PATH = bin;
    assert.equal(await prerequisitesReady([{ kind: 'executable', name: 'minnow-new-verifier' }], project), true);
    assert.match((await execLadderCommand('npm test', { cwd: project })).output, /checkout-tool/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
