#!/usr/bin/env node
// Standalone Electron/Node serializer probe. Never imports Minnow application code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';

const scriptPath = fileURLToPath(import.meta.url);
const digest = (text) => createHash('sha256').update(text).digest('hex');

function fixtures(dataPath) {
  const numbers = [0, -0, 1, -1, 0.1, 0.25, 1791311327786, 2147483647,
    2147483648, -2147483649, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE,
    Number.MAX_VALUE, Infinity, -Infinity, NaN, 1e-7, 1e21];
  // Deterministic IEEE-754 bit patterns exercise subnormal/large/fractional values.
  let seed = 0x13579bdf;
  const next = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
  const bits = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8192; i += 1) {
    bits.setUint32(0, next()); bits.setUint32(4, next());
    numbers.push(bits.getFloat64(0));
  }
  let deep = { value: 1791311327786, text: 'Minnow μ 🐟' };
  for (let i = 0; i < 256; i += 1) deep = { value: deep };
  const rows = numbers.map((value, i) => ({ id: i, value, updatedAt: 1791311327786 + i }));
  const cases = [
    { name: 'ascii-numbers', value: { text: 'plain ASCII', numbers } },
    { name: 'two-byte-numbers', value: { text: 'μ 🐟 漢字', numbers } },
    { name: 'mixed-records', value: rows.map((row, i) => ({ ...row, text: i % 2 ? 'ascii' : 'μ 🐟' })) },
    { name: 'escaping', value: { text: '"\\\n\t\u0000\ud800\udfff μ'.repeat(32768) } },
    { name: 'nested', value: deep },
    { name: 'sparse-array', value: Object.assign(new Array(256), { 0: null, 128: 0.25, 255: 'μ' }) },
  ];
  if (dataPath) {
    const state = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    cases.push({ name: 'saved-data', value: state });
    // Smaller individual records mirror repeated issue comparison calls.
    if (Array.isArray(state.issues)) {
      state.issues.forEach((value, i) => cases.push({ name: `saved-record-${i}`, value }));
    }
  }
  return cases;
}

export async function runProbe(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let app;
  if (process.versions.electron) {
    const electron = await import('electron');
    app = electron.app;
    app.setPath('userData', path.join(config.caseDir, 'profile'));
    app.setPath('crashDumps', path.join(config.caseDir, 'dumps'));
    app.disableHardwareAcceleration();
    electron.crashReporter.start({ uploadToServer: false });
    await app.whenReady();
  }
  // Apply the same runtime flag as Minnow, or explicitly select the fast path.
  setFlagsFromString(config.mode === 'standard'
    ? '--no-json-stringify-fast-path' : '--json-stringify-fast-path');
  // The iterative fast path accepts depths the recursive standard path rejects.
  // Confirm the flag took effect instead of merely trusting the command line.
  let deep = { value: 1 };
  for (let i = 0; i < 12000; i += 1) deep = { value: deep };
  if (config.mode === 'standard') assert.throws(() => JSON.stringify(deep), RangeError);
  else assert.ok(JSON.stringify(deep).length > 120000);
  deep = null;
  const cases = fixtures(config.dataPath);
  const expectations = config.expectations;
  assert.equal(cases.length, expectations.length);
  const stats = { case: config.name, calls: 0, characters: 0, rounds: 0,
    maxCallMs: 0, peakHeapBytes: 0, peakRssBytes: 0, gcCalls: 0, mismatches: 0 };
  const report = (event) => process.stdout.write(`${JSON.stringify({ event, ...stats })}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'ready', case: config.name,
    versions: process.versions, fixtures: cases.length, pid: process.pid, modeVerified: true })}\n`);
  const started = performance.now();
  let nextProgress = started + 10_000;
  const pressure = [];
  let cursor = 0;
  try {
    while (performance.now() - started < config.seconds * 1000) {
      const batchEnd = performance.now() + 40;
      do {
        const sample = cases[cursor];
        const start = performance.now();
        const output = JSON.stringify(sample.value);
        stats.maxCallMs = Math.max(stats.maxCallMs, performance.now() - start);
        stats.calls += 1;
        stats.characters += output.length;
        if (output.length !== expectations[cursor].length || digest(output) !== expectations[cursor].hash) {
          stats.mismatches += 1;
          throw new Error(`Serialization mismatch in ${sample.name}`);
        }
        // Periodically create fresh objects too, as real read/merge/save cycles do.
        if (stats.rounds % 8 === 0) sample.value = JSON.parse(output);
        cursor = (cursor + 1) % cases.length;
        if (cursor === 0) {
          stats.rounds += 1;
          // Bounded allocation churn; do not accumulate serialized output.
          pressure.push(Array.from({ length: 8192 }, (_, i) => ({ i, value: i + 0.25 })));
          if (pressure.length > 4) pressure.shift();
          if (stats.rounds % 16 === 0 && typeof global.gc === 'function') {
            global.gc(); stats.gcCalls += 1;
          }
        }
      } while (performance.now() < batchEnd);
      const memory = process.memoryUsage();
      stats.peakHeapBytes = Math.max(stats.peakHeapBytes, memory.heapUsed);
      stats.peakRssBytes = Math.max(stats.peakRssBytes, memory.rss);
      if (performance.now() >= nextProgress) {
        report('progress'); nextProgress = performance.now() + 10_000;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    stats.elapsedMs = performance.now() - started;
    report('passed');
    if (app) app.exit(0);
  } catch (error) {
    report('failed');
    process.stderr.write(`${error.stack}\n`);
    if (app) app.exit(1);
    else process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (args.includes('--help')) {
    console.log('node scripts/diagnose-json-serialization.mjs [--seconds 300] [--data path/to/state.json] [--electron path/to/electron]');
    console.log('Runs isolated Electron standard/fast and Node standard cases concurrently. Saves metrics and local dumps in a temporary directory. Input is snapshotted read-only, never logged, and the snapshot is removed afterward.');
    return;
  }
  if (args.includes('--child')) return runProbe(option('--child'));
  const seconds = Number(option('--seconds') ?? 60);
  assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 3600, '--seconds must be 1..3600');
  const electron = option('--electron') ?? createRequire(import.meta.url)('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-json-isolation-'));
  let dataPath;
  if (option('--data')) {
    dataPath = path.join(root, 'input.json');
    fs.writeFileSync(dataPath, fs.readFileSync(path.resolve(option('--data'))), { mode: 0o600 });
  }
  const expectations = fixtures(dataPath).map(({ name, value }) => {
    const text = JSON.stringify(value);
    return { name, length: text.length, hash: digest(text) };
  });
  console.log(`Results: ${root}`);
  const active = new Set();
  const interrupt = () => { for (const child of active) child.kill(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'MINNOW_NATIVE_CRASH_TRACE']) delete env[key];
  const runs = [
    { name: 'electron-standard', mode: 'standard', electron: true },
    { name: 'electron-fast', mode: 'fast', electron: true },
    { name: 'node-standard', mode: 'standard', electron: false },
  ];
  try {
    const results = await Promise.all(runs.map(async (run) => {
      const caseDir = path.join(root, run.name);
      fs.mkdirSync(caseDir);
      const configPath = path.join(caseDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ ...run, caseDir, dataPath, expectations, seconds }));
      fs.writeFileSync(path.join(caseDir, 'package.json'), JSON.stringify({ name: run.name, version: '1.0.0', type: 'module', main: 'main.mjs' }));
      // Do not await app.whenReady() at module top level: Electron waits for
      // entry-module evaluation before emitting ready.
      fs.writeFileSync(path.join(caseDir, 'main.mjs'), `import { runProbe } from ${JSON.stringify(pathToFileURL(scriptPath).href)}; runProbe(${JSON.stringify(configPath)}).catch(error => { console.error(error); process.exit(1); });`);
      return new Promise((resolve) => {
        const child = spawn(run.electron ? electron : process.execPath,
          run.electron ? [caseDir, '--js-flags=--expose-gc'] : ['--expose-gc', scriptPath, '--child', configPath],
          { env: { ...env, MINNOW_HOME: path.join(caseDir, 'home') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        active.add(child);
        const stdout = fs.createWriteStream(path.join(caseDir, 'stdout.jsonl'));
        const stderr = fs.createWriteStream(path.join(caseDir, 'stderr.log'));
        let pending = '', final = null, versions = null, timedOut = false, spawnError;
        child.stdout.pipe(stdout); child.stderr.pipe(stderr);
        child.stdout.on('data', (bytes) => {
          pending += bytes.toString();
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) {
            try {
              const row = JSON.parse(line);
              if (row.event === 'ready') versions = row.versions;
              if (row.event === 'passed' || row.event === 'failed') final = row;
              if (row.event === 'ready' || row.event === 'passed' || row.event === 'failed') console.log(line);
            } catch { /* Raw runtime output remains in stdout.jsonl. */ }
          }
        });
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, seconds * 1000 + 30_000);
        child.on('error', (error) => { spawnError = error.message; });
        child.on('close', (code, signal) => {
          clearTimeout(timer); active.delete(child);
          resolve({ name: run.name, code, signal, timedOut, spawnError, versions, result: final,
            passed: code === 0 && !timedOut && final?.event === 'passed' });
        });
      });
    }));
    const report = { generatedAt: new Date().toISOString(), seconds, electron,
      inputIncluded: Boolean(dataPath), fixtures: expectations.length, results };
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Report: ${path.join(root, 'report.json')}`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } finally {
    if (dataPath) fs.unlinkSync(dataPath);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();
