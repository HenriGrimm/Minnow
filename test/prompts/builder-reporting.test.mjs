import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');

for (const variant of ['agent.full.md', 'agent.lite.md']) {
  test(`${variant} requires evidence-scoped status and runtime reporting`, async () => {
    const body = await readFile(
      path.join(root, 'src', 'chat', 'prompts', 'work-agents', 'builder', variant),
      'utf8',
    );
    assert.match(body, /git_status/);
    assert.match(body, /\?\?.*untracked/s);
    assert.match(body, /build warnings/);
    assert.match(body, /no errors observed in the checks run/);
  });
}
