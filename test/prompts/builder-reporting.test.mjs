import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');

for (const variant of ['agent.full.md']) {
  test(`${variant} requires evidence-scoped status and runtime reporting`, async () => {
    const body = await readFile(
      path.join(root, 'src', 'chat', 'prompts', 'work-agents', 'builder', variant),
      'utf8',
    );
    assert.match(body, /git_status/);
    assert.match(body, /\?\?.*untracked/s);
    assert.match(body, /build warnings/);
    assert.match(body, /no errors observed in the checks run/);
    assert.doesNotMatch(body, /three unsuccessful repair cycles/i);
    assert.match(body, /Diagnose and fix implementation and acceptance failures/);
    assert.match(body, /defer only the work that depends on it/);
    assert.match(body, /keep it unverified and run the other checks/);
  });
}
