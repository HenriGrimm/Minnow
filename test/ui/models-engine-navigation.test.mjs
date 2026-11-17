import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Graphite keeps Engine visible and selects its own navigation item', async () => {
  const [css, page] = await Promise.all([
    readFile(new URL('../../src/styles/models-graphite.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/ui/models-page.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(css, /data-models-nav=['"]engine['"]\]\)[^{]*\{\s*display:\s*none/);
  assert.doesNotMatch(page, /section === 'engine' \? 'settings'/);
  assert.match(page, /const navSection = displaySection/);
});
