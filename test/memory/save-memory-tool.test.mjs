/**
 * save_memory server tool — persists agent entries under MINNOW_HOME.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { normalizeMemoryConfig } from '../../server/config/validators.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { initMemoryApi } from '../../server/memory/routes.js';
import { getEntry, listEntries, loadMemoryConfig, saveMemoryConfig } from '../../server/memory/store.js';
import { rebuildCatalog, serializePage } from '../../server/brain/store.js';
import { toolSaveMemory } from '../../server/tools/memory-tools.js';

describe('save_memory tool', () => {
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-save-memory-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await initMemoryApi();
    // save_memory schedules vector sync — disable embeddings so teardown does not
    // race fire-and-forget embedder I/O on Windows CI.
    const configPath = path.join(homeDir, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.memory.embeddings.enabled = false;
    config.memory.maxEntries = 500;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  });

  after(async () => {
    closeCodeDbForTests();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('creates an agent-sourced entry with fixed title and body', async () => {
    const result = await toolSaveMemory({
      title: 'Fixture preference',
      body: 'Always run tests with npm test.',
      tags: ['testing'],
    });
    assert.match(result, /Saved memory "Fixture preference"/);

    const idMatch = result.match(/\(id: ([0-9a-f-]{36})\)/i);
    assert.ok(idMatch, 'result includes entry id');
    const row = await getEntry(idMatch[1]);
    assert.ok(row);
    assert.equal(row.entry.title, 'Fixture preference');
    assert.equal(row.entry.source, 'agent');
    assert.equal(row.body, 'Always run tests with npm test.');
    assert.deepEqual(row.entry.tags, ['testing']);
  });

  it('returns error when title is missing', async () => {
    const result = await toolSaveMemory({ body: 'orphan body' });
    assert.match(result, /^Error: title is required/);
  });

  it('discards legacy entry caps while preserving memory settings', async () => {
    assert.equal(Object.hasOwn(await loadMemoryConfig(), 'maxEntries'), false);
    const normalized = normalizeMemoryConfig({ maxEntries: 500, enabled: false }, {
      maxEntries: 500,
      maxInjectCharsFull: 4000,
    });
    assert.equal(Object.hasOwn(normalized, 'maxEntries'), false);
    assert.equal(normalized.enabled, false);
    assert.equal(normalized.maxInjectCharsFull, 4000);

    const saved = await saveMemoryConfig({ maxEntries: 500 });
    assert.equal(Object.hasOwn(saved, 'maxEntries'), false);
    assert.equal(saved.embeddings.enabled, false);
    const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8'));
    assert.equal(Object.hasOwn(config.memory, 'maxEntries'), false);
  });

  it('keeps saving durable memories beyond 500 facts', async () => {
    const factsDir = path.join(homeDir, 'brain', 'pages', 'facts');
    const entries = await listEntries();
    // Seed real pages in one batch instead of rebuilding the catalog 500 times.
    await Promise.all(Array.from({ length: 500 - entries.length }, (_, index) =>
      fs.writeFile(path.join(factsDir, `seed-${index}.md`), serializePage({
        id: randomUUID(),
        title: `Seed fact ${index}`,
        source: 'agent',
      }, `Existing fact ${index}.`), 'utf8'),
    ));
    await rebuildCatalog();
    assert.equal((await listEntries()).length, 500);

    for (const count of [501, 502]) {
      const result = await toolSaveMemory({
        title: `Fact ${count}`,
        body: `This memory persists beyond the former limit (${count}).`,
      });
      assert.match(result, /Saved memory/);
      const id = result.match(/\(id: ([0-9a-f-]{36})\)/i)?.[1];
      assert.ok(id);
      assert.equal((await getEntry(id)).body, `This memory persists beyond the former limit (${count}).`);
      assert.equal((await listEntries()).length, count);
    }
  });
});
