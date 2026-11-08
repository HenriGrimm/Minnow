/**
 * read_file extracts Excel/PDF instead of dumping ZIP bytes (MIN-614).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { toolCreateSpreadsheet } from '../../server/tools/create-document.js';
import { pathAccessStore } from '../../server/runtime/path-access.js';

let tempRoot = '';

before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-read-file-doc-'));
});

after(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/** Run a server tool with this suite's temp workspace as the root. */
function runInWorkspace(fn) {
  return pathAccessStore.run({ workspaceRootOverride: tempRoot }, fn);
}

describe('read_file office documents', () => {
  it('extracts spreadsheet rows instead of ZIP PK bytes', async () => {
    const created = await runInWorkspace(() =>
      toolCreateSpreadsheet({
        path: 'Comission Structure.xlsx',
        sheets: [{ name: 'Rates', rows: [['Role', 'Pct'], ['Closer', 12]] }],
      }),
    );
    assert.match(created, /Created spreadsheet/);

    const { result } = await executeServerTool(
      'read_file',
      { path: 'Comission Structure.xlsx' },
      { workspaceRoot: tempRoot },
    );

    assert.match(result, /Closer/);
    assert.match(result, /Rates/);
    assert.doesNotMatch(result, /^PK/);
    assert.equal(result.includes('\u0000'), false);
  });

  it('applies read_file_range to extracted sheet text', async () => {
    await runInWorkspace(() =>
      toolCreateSpreadsheet({
        path: 'range-sheet.xlsx',
        sheets: [{ name: 'A', rows: [['Alpha'], ['Beta'], ['Gamma']] }],
      }),
    );

    const { result } = await executeServerTool(
      'read_file_range',
      { path: 'range-sheet.xlsx', start_line: 1, end_line: 8 },
      { workspaceRoot: tempRoot },
    );

    assert.match(result, /Alpha/);
    assert.doesNotMatch(result, /^PK/);
  });

  it('reads UTF-16 and mixed-encoding logs instead of refusing them', async () => {
    const ascii = Buffer.from('=== header line ===\r\n', 'utf8');
    const utf16 = Buffer.from('tail written as UTF-16LE by a shell redirect\r\n', 'utf16le');
    await fs.writeFile(path.join(tempRoot, 'ci.log'), Buffer.concat([ascii, utf16]));

    const { result } = await executeServerTool(
      'read_file',
      { path: 'ci.log' },
      { workspaceRoot: tempRoot },
    );

    assert.match(result, /header line/);
    assert.match(result, /UTF-16LE by a shell redirect/);
    assert.doesNotMatch(result, /^Error:/);
    assert.equal(result.includes('\u0000'), false);
  });

  it('still reads UTF-8 text files', async () => {
    await fs.writeFile(path.join(tempRoot, 'note.txt'), 'plain note body\n', 'utf8');
    const { result } = await executeServerTool(
      'read_file',
      { path: 'note.txt' },
      { workspaceRoot: tempRoot },
    );
    assert.match(result, /plain note body/);
  });

  it('returns numbered offset/limit windows', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n');
    await fs.writeFile(path.join(tempRoot, 'rows.txt'), `${body}\n`, 'utf8');
    const { result } = await executeServerTool(
      'read_file',
      { path: 'rows.txt', offset: '5', limit: 3 },
      { workspaceRoot: tempRoot },
    );
    assert.match(result, /^5: row 5\n6: row 6\n7: row 7\n/);
    assert.match(result, /continue with offset=8/);

    const bad = await executeServerTool(
      'read_file',
      { path: 'rows.txt', offset: 0 },
      { workspaceRoot: tempRoot },
    );
    assert.match(bad.result, /^Error: offset must be a positive integer/);
  });

  it('replace_text_in_file tolerates copied read_file line prefixes', async () => {
    await fs.writeFile(path.join(tempRoot, 'edit.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const { result } = await executeServerTool(
      'replace_text_in_file',
      { path: 'edit.txt', search: '2: beta\n3: gamma', replace: '2: BETA\n3: gamma' },
      { workspaceRoot: tempRoot },
    );
    assert.match(result, /Replaced 1 occurrence/);
    assert.equal(await fs.readFile(path.join(tempRoot, 'edit.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
  });

  it('suggests the workspace parent for a missing file', async () => {
    const { result } = await executeServerTool('read_file', { path: 'missing/note.txt' }, { workspaceRoot: tempRoot });
    assert.match(result, /ENOENT.*list_directory in "\."/);
    await fs.mkdir(path.join(tempRoot, 'nested'));
    const nested = await executeServerTool('read_file', { path: 'nested/note.txt' }, { workspaceRoot: tempRoot });
    assert.match(nested.result, /list_directory in "nested"/);
  });

  it('redirects an inaccessible skill to scoped discovery without revealing an external directory', async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'private-skill-'));
    try {
      await fs.writeFile(path.join(external, 'SKILL.md'), 'private content');
      await fs.symlink(external, path.join(tempRoot, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir');
      const { result } = await executeServerTool('read_file', { path: 'linked-skill/SKILL.md' }, { workspaceRoot: tempRoot, filesystemAccessCeiling: 'workspace' });
      assert.match(result, /outside the workspace.*load_skill/);
      for (const forbidden of [external, 'private content', 'full disk access', 'list_directory']) assert.ok(!result.includes(forbidden));
    } finally { await fs.rm(external, { recursive: true, force: true }); }
  });

  it('preserves literal replacement strings and the legacy omitted deletion', async () => {
    const file = path.join(tempRoot, 'replace.txt');
    const edit = args => executeServerTool('replace_text_in_file', { path: 'replace.txt', search: 'x', ...args }, { workspaceRoot: tempRoot });
    for (const [args, expected] of [[{ replace: '' }, ''], [{ replace: ' ' }, ' '], [{}, '']]) {
      await fs.writeFile(file, 'x');
      assert.match((await edit(args)).result, /Replaced 1/);
      assert.equal(await fs.readFile(file, 'utf8'), expected);
    }
    await fs.writeFile(file, 'x');
    for (const args of [{ replace: null }, { replace: 3 }, { replace: 'y', search: '' }]) {
      assert.match((await edit(args)).result, /^Error:/);
      assert.equal(await fs.readFile(file, 'utf8'), 'x');
    }
  });

  it('rejects generic binary files instead of dumping them', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]);
    await fs.writeFile(path.join(tempRoot, 'blob.bin'), binary);
    const { result } = await executeServerTool(
      'read_file',
      { path: 'blob.bin' },
      { workspaceRoot: tempRoot },
    );
    assert.match(result, /^Error:/);
    assert.match(result, /binary file/i);
    assert.doesNotMatch(result, /\u0000/);
  });
});
