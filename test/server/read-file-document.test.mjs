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
