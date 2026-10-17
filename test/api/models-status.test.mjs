import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(root, 'src/api/models.ts'), 'utf8');

describe('fetchModels feedback', () => {
  test('does not set model inventory count on success', () => {
    assert.doesNotMatch(source, /\$\{models\.length\}\s*models/);
    assert.doesNotMatch(source, /nLoaded/);
    assert.doesNotMatch(source, /setReadyStatus\(\)/);
    assert.match(source, /sel\.setAttribute\('aria-busy', 'true'\)/);
  });
});
