import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const script of ['tts-optimizations.py', 'model-lifecycle.py']) {
test(`voice worker regression: ${script}`, (t) => {
  const python = ['python3', 'python'].find((command) => {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
    return probe.status === 0;
  });
  if (!python) return t.skip('Python is not available');
  const result = spawnSync(python, ['-B', fileURLToPath(new URL(script, import.meta.url))], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
}
