import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { snapshotCreate } from '../server/git/git-ops.js';
import { initSessionsSchema } from '../server/config/sessions-schema.js';
import { createChatRepository } from '../server/chats/repository.js';
import { createChatCheckpointCoordinator } from '../server/chats/checkpoints.js';

// Actual coordinator and Git captures, scripted file effects, no inference or
// live profile. Pair both implementations within each sample to limit drift.
const exec = promisify(execFile);
const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const samples = Number(argument('--samples', '7'));
const files = Number(argument('--files', '200'));
assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 30);
assert.ok(Number.isInteger(files) && files >= 1 && files <= 5000);
const source = await fs.readFile(argument('--baseline-file', '.minnow/snapshot-before-optimization.js'), 'utf8');
const moduleUrl = new URL('../server/git/git-ops.js', import.meta.url);
const resolved = source.replace(/from (['"])(\.[^'"]+)\1/g,
  (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, moduleUrl).href)}`);
const before = (await import('data:text/javascript;base64,' + Buffer.from(resolved).toString('base64'))).snapshotCreate;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-checkpoint-bench-'));
const git = async (cwd, ...params) => (await exec('git', params, { cwd, windowsHide: true })).stdout.trim();
const rows = [];
try {
  for (const writes of [0, 1, 5]) {
    const observations = { before: [], after: [] };
    for (let sample = 0; sample <= samples; sample++) {
      // Alternate ordering, including one paired warmup.
      for (const [name, capture] of sample % 2 ? [['after', snapshotCreate], ['before', before]] : [['before', before], ['after', snapshotCreate]]) {
        const cwd = path.join(scratch, `${writes}-${sample}-${name}`);
        await fs.mkdir(cwd);
        await git(cwd, 'init'); await git(cwd, 'config', 'core.autocrlf', 'false');
        await git(cwd, 'config', 'user.name', 'Fixture'); await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
        for (let i = 0; i < files; i++) await fs.writeFile(path.join(cwd, `file-${i}.txt`), `fixture ${i}\n`.repeat(100));
        await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'seed');
        // Preserve distinct staged/unstaged and untracked data through the turn.
        await fs.writeFile(path.join(cwd, 'file-0.txt'), 'staged\n'); await git(cwd, 'add', 'file-0.txt');
        await fs.writeFile(path.join(cwd, 'file-0.txt'), 'unstaged\n');
        await fs.writeFile(path.join(cwd, 'untracked.txt'), 'untracked\n');
        const index = await fs.readFile(path.join(cwd, '.git', 'index'));
        const db = new Database(':memory:'); initSessionsSchema(db);
        try {
          const repository = createChatRepository({ db });
          repository.createChat({ id: 'fixture', name: 'Fixture', workspacePath: cwd });
          const fence = repository.claimExecution({ chatId: 'fixture', executionId: 'fixture', ownerId: 'benchmark' });
          let captures = 0, captureMs = 0;
          const coordinator = createChatCheckpointCoordinator({ repository, capture: async input => {
            const start = performance.now(); captures++;
            try { return await capture(input); } finally { captureMs += performance.now() - start; }
          } });
          const start = performance.now();
          const turn = await coordinator.prepare({ chatId: 'fixture', executionId: 'fixture', cwd, fence, deferBaseline: name === 'after' });
          const dispatchMs = performance.now() - start;
          for (let i = 0; i < writes; i++) await turn.effect('write-' + i,
            () => fs.writeFile(path.join(cwd, `effect-${i}.txt`), 'effect\n'));
          await turn.finalize();
          const totalMs = performance.now() - start;
          assert.equal(captures, (name === 'before' ? 1 : 0) + 2 * writes);
          assert.ok(index.equals(await fs.readFile(path.join(cwd, '.git', 'index'))));
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_workspace_checkpoints WHERE state!='settled'").get().n, 0);
          if (sample) observations[name].push({ totalMs, captureMs, dispatchMs, captures });
        } finally { db.close(); }
      }
    }
    for (const [implementation, values] of Object.entries(observations)) rows.push({ implementation, writes,
      captures: values[0].captures, samples: values.length,
      totalP50Ms: percentile(values.map(row => row.totalMs), .5), totalP95Ms: percentile(values.map(row => row.totalMs), .95),
      captureP50Ms: percentile(values.map(row => row.captureMs), .5), dispatchP95Ms: percentile(values.map(row => row.dispatchMs), .95) });
  }
  const result = { scope: 'Real coordinator + Git, scripted effects, no model/renderer. External turns defer baseline into first pre-effect capture; native turns retain eager baseline.',
    machine: { platform: process.platform, node: process.version, cpus: os.cpus().length }, files, warmups: 1,
    baselineSourceSha256: createHash('sha256').update(source).digest('hex'), rows };
  const output = JSON.stringify(result, null, 2) + '\n';
  await fs.writeFile(argument('--output', 'documentation/plans/chat-performance-checkpoint-results.json'), output);
  console.log(output);
} finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
