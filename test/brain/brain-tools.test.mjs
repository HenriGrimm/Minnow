/**
 * Brain wiki server tool handlers — write/search round-trip and workspace scoping.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { initBrainApi } from '../../server/brain/routes.js';
import { shutdownAllLsp } from '../../server/lsp/manager.js';
import { readPage } from '../../server/brain/store.js';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

const PAGE_PATH = 'facts/tool-roundtrip.md';

describe('brain wiki tools', () => {
  let homeDir;
  let workspaceDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-brain-tools-'));
    workspaceDir = path.join(homeDir, 'fixture-workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await initBrainApi();
    await setWorkspaceRoot(workspaceDir);
  });

  after(async () => {
    shutdownAllLsp();
    closeCodeDbForTests();
    // initBrainApi opens sessions.db via readAllChatIds — close before rm (Windows EBUSY).
    closeSessionsDb();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('brain_write_page creates a facts page and brain_search returns it', async () => {
    const writeOut = await executeServerTool('brain_write_page', {
      path: PAGE_PATH,
      title: 'Tool roundtrip note',
      body: 'Unique MIN_B4_MARKER phrase for hybrid search.',
      tags: ['testing'],
    });
    assert.match(writeOut.result, /Created wiki page "Tool roundtrip note"/);

    const row = await readPage(PAGE_PATH);
    assert.equal(row.meta.title, 'Tool roundtrip note');
    assert.match(row.body, /MIN_B4_MARKER/);

    const searchOut = await executeServerTool('brain_search', {
      query: 'MIN_B4_MARKER roundtrip',
      limit: 5,
    });
    assert.match(searchOut.result, /MIN_B4_MARKER/);
    assert.match(searchOut.result, /Matched page paths: facts\/tool-roundtrip\.md/);
    assert.ok(searchOut.result.includes(row.meta.id));
  });

  it('brain_read_page resolves basename to full path', async () => {
    await executeServerTool('brain_write_page', {
      path: 'minnow/nested-basename-test.md',
      title: 'Nested basename test',
      body: 'Basename resolution marker.',
      tags: ['testing'],
    });

    const out = await executeServerTool('brain_read_page', {
      path: 'nested-basename-test.md',
    });
    assert.match(out.result, /Nested basename test/);
    assert.match(out.result, /path: minnow\/nested-basename-test\.md/);
  });

  it('brain_read_page accepts page id from brain_search', async () => {
    const row = await readPage(PAGE_PATH);
    const out = await executeServerTool('brain_read_page', {
      path: row.meta.id,
    });
    assert.match(out.result, /Tool roundtrip note/);
  });

  it('brain_read_page returns page content by path', async () => {
    const out = await executeServerTool('brain_read_page', {
      path: 'facts/tool-roundtrip.md',
    });
    assert.match(out.result, /Tool roundtrip note/);
    assert.match(out.result, /MIN_B4_MARKER/);
    assert.match(out.result, /revision: [a-f0-9]{64}/);
  });

  it('brain_write_page rejects a stale tool revision without changing the page', async () => {
    const pagePath = 'facts/tool-revision.md';
    const first = await executeServerTool('brain_write_page', {
      path: pagePath, title: 'Revision test', body: 'First body',
    });
    assert.match(first.result, /revision: [a-f0-9]{64}/);
    const read = await executeServerTool('brain_read_page', { path: pagePath });
    const expectedRevision = read.result.match(/^revision: ([a-f0-9]{64})$/m)?.[1];
    assert.ok(expectedRevision);

    const changed = await executeServerTool('brain_write_page', {
      path: pagePath, title: 'Revision test', body: 'Second body', expectedRevision,
    });
    assert.match(changed.result, /Updated wiki page/);
    const stale = await executeServerTool('brain_write_page', {
      path: pagePath, title: 'Revision test', body: 'Stale body', expectedRevision,
    });
    assert.match(stale.result, /Error: Page changed since it was loaded/);
    assert.equal((await readPage(pagePath)).body.trim(), 'Second body');

    const unguarded = await executeServerTool('brain_write_page', {
      path: pagePath, title: 'Revision test', body: 'Legacy unguarded body',
    });
    assert.match(unguarded.result, /Updated wiki page/);
    assert.equal((await readPage(pagePath)).body.trim(), 'Legacy unguarded body');

    const lastRevision = (await readPage(pagePath)).revision;
    await executeServerTool('manage_brain', {
      action: 'delete_page', path: pagePath, confirmed: true,
    });
    const deleted = await executeServerTool('brain_write_page', {
      path: pagePath, title: 'Revision test', body: 'Resurrected', expectedRevision: lastRevision,
    });
    assert.match(deleted.result, /Error: Page changed since it was loaded/);
    await assert.rejects(() => readPage(pagePath));
  });

  it('brain_list returns a JSON tree', async () => {
    const out = await executeServerTool('brain_list', {});
    const tree = JSON.parse(out.result);
    assert.ok(tree && typeof tree === 'object');
    assert.ok(tree.facts);
  });

  it('brain_append_log appends to log.md', async () => {
    const out = await executeServerTool('brain_append_log', {
      entry: 'MIN-B4 test append',
    });
    assert.match(out.result, /Appended to brain log/);
  });

  it('manage_brain requires confirmed for destructive actions', async () => {
    const gate = await executeServerTool('manage_brain', {
      action: 'delete_page',
      path: PAGE_PATH,
    });
    assert.match(gate.result, /requires confirmation/);

    const del = await executeServerTool('manage_brain', {
      action: 'delete_page',
      path: PAGE_PATH,
      confirmed: true,
    });
    assert.match(del.result, /Deleted wiki page/);

    await assert.rejects(() => readPage(PAGE_PATH));
  });

  it('manage_brain accepts confirmed as string true', async () => {
    await executeServerTool('brain_write_page', {
      path: 'facts/string-confirm-test.md',
      title: 'String confirm test',
      body: 'Temporary page.',
      tags: ['testing'],
    });

    const del = await executeServerTool('manage_brain', {
      action: 'delete_page',
      path: 'facts/string-confirm-test.md',
      confirmed: 'true',
    });
    assert.match(del.result, /Deleted wiki page/);
  });

  it('manage_brain clear_wiki removes pages after confirmation', async () => {
    await executeServerTool('brain_write_page', {
      path: 'facts/clear-wiki-test.md',
      title: 'Clear wiki test',
      body: 'Temporary page for clear_wiki.',
      tags: ['testing'],
    });

    const gate = await executeServerTool('manage_brain', {
      action: 'clear_wiki',
    });
    assert.match(gate.result, /requires confirmation/);

    const cleared = await executeServerTool('manage_brain', {
      action: 'clear_wiki',
      confirmed: true,
    });
    assert.match(cleared.result, /Cleared \d+ wiki page/);

    const listOut = await executeServerTool('brain_list', {});
    const tree = JSON.parse(listOut.result);
    assert.equal(Object.keys(tree).length, 0);
  });
});
