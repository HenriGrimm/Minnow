import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enableNativeCallTrace, installNativeCallTrace } from '../../electron/native-call-trace.ts';

test('native tracing is disabled by default', () => {
  const previous = process.env.MINNOW_NATIVE_CRASH_TRACE;
  const stringify = JSON.stringify;
  const entries = Object.entries;
  try {
    delete process.env.MINNOW_NATIVE_CRASH_TRACE;
    enableNativeCallTrace();
    assert.equal(JSON.stringify, stringify);
    assert.equal(Object.entries, entries);
  } finally {
    if (previous === undefined) delete process.env.MINNOW_NATIVE_CRASH_TRACE;
    else process.env.MINNOW_NATIVE_CRASH_TRACE = previous;
  }
});

test('native breadcrumbs preserve results, errors, and nested callers without recording values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-native-trace-'));
  const file = path.join(dir, 'call.txt');
  const original = JSON.stringify;
  const restore = installNativeCallTrace(file);
  try {
    assert.equal(JSON.stringify({ value: 'private-payload' }, ['value'], 2), '{\n  "value": "private-payload"\n}');
    assert.equal(JSON.stringify(undefined), undefined);
    assert.deepEqual(Object.entries({ a: 1 }), [['a', 1]]);
    assert.equal(fs.readFileSync(file, 'utf8').includes('private-payload'), false);
    const circular: any = {}; circular.self = circular;
    assert.throws(() => JSON.stringify(circular), TypeError);
    assert.match(fs.readFileSync(file, 'utf8'), /threw JSON.stringify/);
    Object.entries({ get nested() {
      JSON.stringify({ nested: true });
      assert.match(fs.readFileSync(file, 'utf8'), /active Object.entries/);
      return 1;
    } });
    assert.match(fs.readFileSync(file, 'utf8'), /completed Object.entries/);
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
    assert.equal(JSON.stringify({ still: 'works' }), '{"still":"works"}');
  } finally {
    restore();
    assert.equal(JSON.stringify, original);
  }
});

test('an abrupt process exit retains the active caller on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-native-trace-exit-'));
  const file = path.join(dir, 'call.txt');
  const source = new URL('../../electron/native-call-trace.ts', import.meta.url).href;
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { installNativeCallTrace } = await import(${JSON.stringify(source)});
      installNativeCallTrace(${JSON.stringify(file)});
      function saveIssueState() {
        JSON.stringify({ toJSON() { process.exit(29); } });
      }
      saveIssueState();
    `], { encoding: 'utf8', timeout: 15_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 29, child.stderr);
    const breadcrumb = fs.readFileSync(file, 'utf8');
    assert.match(breadcrumb, /active JSON.stringify/);
    assert.match(breadcrumb, /saveIssueState/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
