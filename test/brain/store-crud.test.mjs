/**
 * Brain wiki store CRUD, wikilinks, backlinks, and bootstrap seeds.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import {
  getBrainDir,
  getBrainIndexPath,
  getBrainLogPath,
  getBrainSchemaPath,
  getCatalogPath,
} from '../../server/brain/paths.js';
import {
  computeBacklinks,
  createPage,
  deletePage,
  ensureBrainStore,
  extractWikilinks,
  findOrphanPages,
  listPages,
  readPage,
  updatePage,
  atomicWritePage,
  rebuildCatalog,
  serializePage,
} from '../../server/brain/store.js';

const PAGE_ID = '11111111-1111-1111-1111-111111111111';
const PAGE_ID_B = '22222222-2222-2222-2222-222222222222';
const CREATED_AT = '2024-01-15T10:00:00.000Z';
const UPDATED_AT = '2024-02-01T12:30:00.000Z';

let homeDir;

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-brain-store-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await ensureMinnowLayout();
  // CRUD tests do not cover vector sync — disable embeddings so scheduled sync is a no-op
  // and teardown does not race fire-and-forget embedder I/O on Windows CI.
  const configPath = path.join(homeDir, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.memory.embeddings.enabled = false;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
});

after(async () => {
  closeCodeDbForTests();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('brain store bootstrap', () => {
  test('ensureBrainStore seeds index, log, schema, and catalog', async () => {
    await ensureBrainStore();
    const index = await fs.readFile(getBrainIndexPath(), 'utf8');
    const log = await fs.readFile(getBrainLogPath(), 'utf8');
    const schema = await fs.readFile(getBrainSchemaPath(), 'utf8');
    const catalog = JSON.parse(await fs.readFile(getCatalogPath(), 'utf8'));
    assert.match(index, /Brain Wiki Index/);
    assert.match(log, /Brain Changelog/);
    assert.match(schema, /Brain Routing Schema/);
    assert.equal(catalog.version, 1);
    assert.ok(Array.isArray(catalog.pages));
    await fs.access(path.join(getBrainDir(), 'sources'));
    await fs.access(path.join(getBrainDir(), 'code'));
    await fs.access(path.join(getBrainDir(), 'pages', 'facts'));
    await fs.access(path.join(getBrainDir(), 'pages', 'workspaces'));
  });
});

describe('brain page CRUD', () => {
  test('rejects stale revisions and preserves the previous complete page', async () => {
    const relPath = 'facts/revision-check.md';
    await createPage({ relPath, title: 'First', body: 'Original body' });
    const first = await readPage(relPath);
    assert.match(first.revision, /^[a-f0-9]{64}$/);

    const updated = await updatePage(relPath, {
      title: 'Second', body: 'Updated body', expectedRevision: first.revision,
    });
    assert.notEqual(updated.revision, first.revision);
    await assert.rejects(
      updatePage(relPath, { body: 'Stale body', expectedRevision: first.revision }),
      { statusCode: 409 },
    );
    assert.equal((await readPage(relPath)).body, 'Updated body');
    const backup = await fs.readFile(path.join(getBrainDir(), 'pages', `${relPath}.bak`), 'utf8');
    assert.match(backup, /Original body/);
    assert.equal((await listPages()).find((page) => page.path === relPath)?.title, 'Second');
    await deletePage(relPath);
  });

  test('failed replacement leaves either the old or new complete page', async () => {
    const relPath = 'facts/atomic-test.md';
    const page = await createPage({ relPath, title: 'Old page', body: 'Old complete body' });
    const abs = path.join(getBrainDir(), 'pages', relPath);
    const oldSource = await fs.readFile(abs, 'utf8');
    const newSource = serializePage({ ...page.meta, title: 'New page' }, 'New complete body');
    let renameCalls = 0;
    const fileSystem = {
      mkdir: fs.mkdir, writeFile: fs.writeFile, copyFile: fs.copyFile, rm: fs.rm,
      rename: async (...args) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error('before replace');
        return fs.rename(...args);
      },
    };
    await assert.rejects(atomicWritePage(abs, newSource, { backupExisting: true, fileSystem }), /before replace/);
    assert.equal(await fs.readFile(abs, 'utf8'), oldSource);
    assert.equal(await fs.readFile(`${abs}.bak`, 'utf8'), oldSource);
    assert.deepEqual((await fs.readdir(path.dirname(abs))).filter((name) => name.endsWith('.tmp')), []);
    await rebuildCatalog();
    assert.equal((await listPages()).find((entry) => entry.path === relPath)?.title, 'Old page');

    fileSystem.rename = async (...args) => {
      await fs.rename(...args);
      if (args[1] === abs) throw new Error('after replace');
    };
    await assert.rejects(atomicWritePage(abs, newSource, { backupExisting: true, fileSystem }), /after replace/);
    assert.equal(await fs.readFile(abs, 'utf8'), newSource);
    assert.equal(await fs.readFile(`${abs}.bak`, 'utf8'), oldSource);
    await rebuildCatalog();
    assert.equal((await readPage(relPath)).body, 'New complete body');
    assert.equal((await listPages()).find((entry) => entry.path === relPath)?.title, 'New page');
    await deletePage(relPath);
  });

  test('create read update delete round-trip in nested paths', async () => {
    const created = await createPage({
      relPath: 'facts/preferred-command.md',
      id: PAGE_ID,
      title: 'Preferred test command',
      tags: ['testing'],
      source: 'user',
      pinned: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      body: 'Always run npm start before API smoke tests.',
    });
    assert.equal(created.meta.id, PAGE_ID);
    assert.equal(created.meta.folder, 'facts');
    assert.equal(created.meta.slug, 'preferred-command');

    const read = await readPage('facts/preferred-command.md');
    assert.equal(read.body, 'Always run npm start before API smoke tests.');
    assert.deepEqual(read.meta.tags, ['testing']);

    const domain = await createPage({
      relPath: 'minnow/architecture/overview.md',
      id: PAGE_ID_B,
      title: 'Architecture overview',
      body: 'See [[facts/preferred-command]] for commands.',
    });
    assert.equal(domain.meta.folder, 'minnow/architecture');

    const updated = await updatePage('facts/preferred-command.md', {
      title: 'Preferred command (updated)',
      body: 'Updated body with [[minnow/architecture/overview]].',
    });
    assert.equal(updated.meta.title, 'Preferred command (updated)');
    assert.ok(updated.meta.updatedAt > UPDATED_AT);

    const pages = await listPages();
    assert.equal(pages.length, 2);

    await deletePage('facts/preferred-command.md');
    await deletePage('minnow/architecture/overview.md');
    assert.equal((await listPages()).length, 0);
  });
});

describe('wikilinks backlinks orphans', () => {
  test('extracts path-based wikilinks and computes backlinks', () => {
    const links = extractWikilinks('Alpha [[facts/a]] and [[minnow/b]] again [[facts/a]].');
    assert.deepEqual(links, ['facts/a', 'minnow/b']);

    const catalog = {
      pages: [
        { path: 'facts/a.md', links: ['minnow/b'], status: 'current' },
        { path: 'minnow/b.md', links: ['facts/a'], status: 'current' },
        { path: 'facts/orphan.md', links: [], status: 'orphan' },
      ],
    };
    const backlinks = computeBacklinks(catalog);
    assert.deepEqual(backlinks['minnow/b'], ['facts/a.md']);

    const orphans = findOrphanPages(catalog);
    const orphanPaths = orphans.map((p) => p.path).sort();
    assert.deepEqual(orphanPaths, ['facts/orphan.md']);
    assert.equal(backlinks['facts/a'].length, 1);
  });

  test('similarTo edges keep both endpoints out of the orphan list', () => {
    const catalog = {
      pages: [
        // No wikilinks anywhere; pages relate only via similarTo.
        { path: 'facts/x.md', links: [], similarTo: ['facts/y'], status: 'current' },
        { path: 'facts/y.md', links: [], status: 'current' },
        // similarTo to a non-existent page must not rescue this page.
        { path: 'facts/dangling.md', links: [], similarTo: ['facts/missing'], status: 'current' },
        { path: 'facts/alone.md', links: [], status: 'current' },
      ],
    };
    const orphanPaths = findOrphanPages(catalog).map((p) => p.path).sort();
    // x has an outbound similar edge, y is the inbound target — both connected.
    assert.deepEqual(orphanPaths, ['facts/alone.md', 'facts/dangling.md']);
  });
});
