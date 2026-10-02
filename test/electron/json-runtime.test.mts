import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';

test('shell selects the standard JSON serializer before loading server modules', () => {
  const main = fs.readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
  assert.ok(main.startsWith("import './json-runtime.js';"));

  // Run in another process: V8 flags affect every isolate in this process.
  // A deep object distinguishes the native fast path from the standard path
  // without allocating a huge buffer or reproducing the fatal OOM itself.
  const runtime = new URL('../../electron/json-runtime.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, [
    '--json-stringify-fast-path', '--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      let deep = { text: 'Minnow μ', number: 0.25 };
      for (let i = 0; i < 12000; i++) deep = { value: deep };
      assert.ok(JSON.stringify(deep).length > 120000);
      const sample = { text: 'Minnow μ 🐟', number: 0.25, values: [null, true, -0, 1e100] };
      const expected = JSON.stringify(sample);
      await import(${JSON.stringify(runtime)});
      assert.equal(JSON.stringify(sample), expected);
      assert.throws(() => JSON.stringify(deep), RangeError);
      const cyclic = {}; cyclic.self = cyclic;
      assert.throws(() => JSON.stringify(cyclic), TypeError);
      assert.equal(JSON.stringify({ omitted: undefined, value: NaN }), '{"value":null}');
      assert.equal(JSON.stringify({ toJSON: () => 'custom' }), '"custom"');
    `,
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
