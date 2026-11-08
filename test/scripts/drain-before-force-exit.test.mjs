import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

test('Windows Node 24 drain preserves explicit application exits and test failures', {
  skip: process.platform !== 'win32' || !process.versions.node.startsWith('24.'),
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minnow-exit-drain-'));
  const fixture = join(dir, 'fixture.test.mjs');
  const marker = join(dir, 'drained');
  const preload = pathToFileURL(resolve('test/drain-before-force-exit.mjs')).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--import', preload, '--test', '--test-force-exit', fixture], {
    encoding: 'utf8', timeout: 15_000, env,
  });
  try {
    await writeFile(fixture, `import { test } from 'node:test'; import { writeFileSync } from 'node:fs';
test('pass', () => { setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'yes'), 50); });`);
    const passed = run();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.equal(await readFile(marker, 'utf8'), 'yes');
    await rm(marker);
    await writeFile(fixture, `import { test } from 'node:test'; import { writeFileSync } from 'node:fs';
test('explicit exit', () => { setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'bad'), 50); process.exit(7); });`);
    const exited = run();
    assert.notEqual(exited.status, 0, exited.stdout + exited.stderr);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await writeFile(fixture, `import { test } from 'node:test'; test('failure', () => { throw new Error('intentional assertion failure'); });`);
    const failed = run();
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.match(failed.stdout + failed.stderr, /intentional assertion failure/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8 });
  }
});
