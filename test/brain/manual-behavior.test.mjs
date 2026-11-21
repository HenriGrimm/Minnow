import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { MEMORY_LIMITS } from '../../server/brain/memory/store.js';

const read = name => fs.readFile(new URL(`../../documentation/manual/${name}`, import.meta.url), 'utf8');

test('the Brain manual matches shipped memory limits and on-demand recall', async () => {
  const manual = await read('apps/brain.md');
  assert.ok(manual.includes(`up to ${MEMORY_LIMITS.body.toLocaleString('en-US')} characters`));
  assert.ok(manual.includes('no limit on how many memories'));
  for (const tool of ['memory_search', 'memory_read', 'memory_save', 'memory_forget']) assert.ok(manual.includes(tool), tool);
  assert.match(manual, /Nothing from memory is added to your messages/);
  assert.match(manual, /worktrees share one memory/);
  assert.match(manual, /Clean up old Brain data/);
  assert.match(manual, /Skip.*leaves those files on disk/);
});

test('manual pages no longer describe injected Brain notes or retired wiki tools', async () => {
  for (const name of ['apps/brain.md', 'concepts/context-and-memory.md', 'reference/wiki-and-brain.md', 'extend/mcp-hub.md']) {
    const manual = await read(name);
    for (const retired of ['brain_search', 'brain_read_page', 'brain_write_page', 'save_memory', 'Brain notes', 'Brain context']) {
      assert.ok(!manual.includes(retired), `${name} mentions ${retired}`);
    }
    assert.doesNotMatch(manual, /suggested memories|saved directly/, name);
  }
  assert.match(await read('concepts/context-and-memory.md'), /Nothing from it is added to your prompt/);
});
