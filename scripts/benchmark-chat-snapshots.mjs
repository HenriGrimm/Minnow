import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotCreate } from '../server/git/git-ops.js';

// Synthetic Git component benchmark. Never invokes inference or reads chat data.
const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const git = async (cwd, ...args) => (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const round = value => Math.round(value * 10) / 10;

export async function benchmarkChatSnapshots({ samples = 5, files = 200, baselineRef = 'HEAD' } = {}) {
  if (!Number.isInteger(samples) || samples < 2 || samples > 20) throw Error('samples must be 2–20');
  if (!Number.isInteger(files) || files < 1 || files > 5000) throw Error('files must be 1–5000');
  // Load the actual baseline module, resolving only its relative static imports.
  // This is a local Git ref, not downloaded code. Dependencies use this checkout.
  const source = await git(repoRoot, 'show', `${baselineRef}:server/git/git-ops.js`);
  const moduleUrl = new URL('../server/git/git-ops.js', import.meta.url);
  const resolved = source.replace(/from (['"])(\.[^'"]+)\1/g,
    (_match, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, moduleUrl).href)}`);
  const baseline = (await import('data:text/javascript;base64,' + Buffer.from(resolved).toString('base64'))).snapshotCreate;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-snapshot-benchmark-'));
  const results = { scope: 'Synthetic Git snapshot component only; not end-to-end chat or renderer latency.',
    machine: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length },
    baselineRef, baselineCommit: await git(repoRoot, 'rev-parse', baselineRef), samples, files, warmups: 1, rows: [] };
  try {
    for (const dirty of [false, true]) for (const concurrent of [1, 4]) {
      for (const [implementation, create] of [['baseline', baseline], ['current', snapshotCreate]]) {
        const cwd = path.join(scratch, `${dirty}-${concurrent}-${implementation}`);
        await fs.mkdir(cwd);
        await git(cwd, 'init');
        await git(cwd, 'config', 'user.name', 'Benchmark fixture');
        await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
        await git(cwd, 'config', 'core.autocrlf', 'false');
        for (let i = 0; i < files; i++) await fs.writeFile(path.join(cwd, `fixture-${i}.txt`), `Synthetic fixture ${i}\n`.repeat(100));
        await git(cwd, 'add', '.');
        await git(cwd, 'commit', '-m', 'synthetic seed');
        if (dirty) {
          await fs.writeFile(path.join(cwd, 'fixture-0.txt'), 'staged\n');
          await git(cwd, 'add', 'fixture-0.txt');
          await fs.writeFile(path.join(cwd, 'fixture-0.txt'), 'unstaged\n');
          await fs.writeFile(path.join(cwd, 'untracked.txt'), 'untracked\n');
        }
        const indexPath = path.join(cwd, '.git', 'index');
        const times = [], batches = [];
        let indexUnchanged = true;
        let failures = 0;
        for (let sample = 0; sample <= samples; sample++) {
          const before = await fs.readFile(indexPath);
          const batchStart = performance.now();
          const completed = await Promise.allSettled(Array.from({ length: concurrent }, async () => {
            const start = performance.now();
            const result = await create({ cwd, message: 'Synthetic snapshot benchmark' });
            assert.equal(result.ok, true, result.error);
            if (sample) times.push(performance.now() - start);
          }));
          failures += completed.filter(row => row.status === 'rejected').length;
          if (implementation === 'current') {
            for (const row of completed) if (row.status === 'rejected') throw row.reason;
          }
          if (sample) batches.push(performance.now() - batchStart);
          indexUnchanged &&= before.equals(await fs.readFile(indexPath));
        }
        if (implementation === 'current') assert.equal(indexUnchanged, true, 'current snapshots modified the real index');
        results.rows.push({ implementation, dirty, concurrent, captures: times.length, failures, indexUnchanged,
          captureP50Ms: round(percentile(times, 0.5)), captureP95Ms: round(percentile(times, 0.95)),
          batchP50Ms: round(percentile(batches, 0.5)), batchP95Ms: round(percentile(batches, 0.95)) });
      }
    }
    return results;
  } finally {
    // Only the freshly created synthetic directory, never the project or Minnow home.
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  const results = await benchmarkChatSnapshots({
    samples: args.includes('--samples') ? Number(value('--samples')) : 5,
    files: args.includes('--files') ? Number(value('--files')) : 200,
    baselineRef: args.includes('--baseline-ref') ? value('--baseline-ref') : 'HEAD',
  });
  const output = JSON.stringify(results, null, 2) + '\n';
  if (args.includes('--output')) await fs.writeFile(path.resolve(value('--output')), output);
  console.log(output);
}
