import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const couplingScript = join(root, 'scripts/index-html-coupling-map.mjs');

describe('index.html static shell (MIN-387)', () => {
  test('has zero inline on* event handlers', () => {
    assert.doesNotMatch(html, /\bon[a-z]+="/i);
  });

  test('coupling-map script reports zero inline handlers', () => {
    const out = execFileSync('node', [couplingScript, '--json'], { encoding: 'utf8' });
    const report = JSON.parse(out);
    assert.equal(report.summary.inlineHandlerCount, 0);
    assert.ok(report.summary.idCount > 0);
  });

  test('topbar app buttons exist without inline handlers', () => {
    for (const id of ['btnSettings']) {
      assert.match(html, new RegExp(`id="${id}"`));
      const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
      assert.doesNotMatch(tag, /\bon[a-z]+="/i);
    }
  });
});
