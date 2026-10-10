import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { toolPresentFiles } from '../../server/tools/present-files.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';
import { getToolById } from '../../server/tools/builtin-catalog.js';
import { DEFAULT_HEADLESS_TOOL_IDS } from '../../server/runner/tool-set.js';
import { normalizeToolConfig, validateSessionState } from '../../server/config/validators.js';

let root;
const originalHome = process.env.MINNOW_HOME;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-present-files-'));
  process.env.MINNOW_HOME = path.join(root, 'home');
  await fs.writeFile(path.join(root, 'plan.md'), '# Plan\n');
  await fs.writeFile(path.join(root, 'deliverable.pdf'), Buffer.from([0, 255, 1, 128]));
});
after(async () => {
  const { closeSessionsDb } = await import('../../server/config/sessions-db.js');
  closeSessionsDb();
  if (originalHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = originalHome;
  await fs.rm(root, { recursive: true, force: true });
});
const present = files => runWithToolContext(() => toolPresentFiles({ files }), { workspaceRoot: root, allowOutsideWorkspace: false });

test('presents existing project and binary deliverable files, with canonical paths and disk metadata', async () => {
  const result = JSON.parse(await present([{ path: 'plan.md', title: 'Implementation plan' },
    { path: path.join(root, 'deliverable.pdf') }, { path: './plan.md' }]));
  assert.equal(result.kind, 'presented-files');
  assert.equal(result.workspaceRoot, root);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files[0], { path: 'plan.md', name: 'plan.md', title: 'Implementation plan', bytes: 7 });
  assert.equal(result.files[1].path, 'deliverable.pdf');
  assert.equal(result.files[1].bytes, 4);
  assert.equal(await fs.readFile(path.join(root, 'plan.md'), 'utf8'), '# Plan\n');
});

test('rejects nonexistent files, directories, traversal and symlinks escaping the workspace', async () => {
  await assert.rejects(present([{ path: 'missing.pdf' }]), /ENOENT/);
  await assert.rejects(present([{ path: '.' }]), /Not a file/);
  await assert.rejects(present([{ path: '../other.txt' }]), /outside the workspace/);
  const link = path.join(root, 'outside');
  await fs.symlink(path.dirname(root), link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(present([{ path: 'outside/other.txt' }]), /outside the workspace/);
});

test('validates array bounds and malformed entries without producing a handoff', async () => {
  for (const files of [[], Array(21).fill({ path: 'plan.md' }), [{}], [{ path: 'plan.md', title: 123 }]]) {
    await assert.rejects(present(files));
  }
});

test('is enabled as a read-only tool and available to unattended agents', () => {
  assert.ok(getToolById('present_files'));
  assert.ok(DEFAULT_HEADLESS_TOOL_IDS.includes('present_files'));
  const config = normalizeToolConfig({});
  assert.equal(config.enabled.present_files, true);
  assert.equal(config.permissions.default.present_files, 'full');
});

test('the tool dispatcher returns durable structured content without recording a file edit', async () => {
  const { executeServerTool } = await import('../../server/runtime/tools-middleware.js');
  const result = await executeServerTool('present_files', { files: [{ path: 'plan.md' }] }, { workspaceRoot: root });
  assert.equal(JSON.parse(result.result).files[0].path, 'plan.md');
  assert.equal(result.codeChange, undefined);
});

test('session validation and serialization preserve the full handoff for reload', async () => {
  const content = await present([{ path: 'plan.md' }, { path: 'deliverable.pdf' }]);
  const state = validateSessionState({ version: 2, activeId: 'file-chat', chats: [{ id: 'file-chat', title: 'Files',
    history: [{ role: 'user', content: 'Show my files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'handoff', type: 'function',
        function: { name: 'present_files', arguments: '{"files":[{"path":"plan.md"}]}' } }] },
      { role: 'tool', tool_call_id: 'handoff', content }] }] });
  const reloaded = validateSessionState(JSON.parse(JSON.stringify(state)));
  assert.equal(reloaded.chats[0].history.at(-1).content, content);
  const { writeWholeSessionState, readWholeSessionState } = await import('../../server/config/sessions-repo.js');
  const { closeSessionsDb } = await import('../../server/config/sessions-db.js');
  writeWholeSessionState(state);
  closeSessionsDb();
  assert.equal(readWholeSessionState().chats[0].history.at(-1).content, content);
});
