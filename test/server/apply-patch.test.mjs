import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { toolApplyPatch } from '../../server/tools/apply-patch.js';
import { parsePatch, patchText } from '../../src/lib/apply-patch.mjs';
import { pathAccessStore } from '../../server/runtime/path-access.js';
import { blockPlanModeWrite } from '../../server/tools/plan-write-guard.js';
import { BOARD_BUILDER_TOOL_IDS, BOARD_VERIFIER_TOOL_IDS } from '../../server/runner/tool-set.js';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';
import { ALL_TOOL_IDS } from '../../server/config/tool-ids.js';
import { normalizeToolConfig } from '../../server/config/validators.js';

const patch = body => `*** Begin Patch\n${body}\n*** End Patch`;
async function workspace(t, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-patch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return pathAccessStore.run({ workspaceRootOverride: root, allowOutsideWorkspace: false }, () => fn(root));
}

test('one patch adds, edits with CRLF, moves, deletes, and reports all changed paths', t => workspace(t, async root => {
  await fs.writeFile(path.join(root, 'edit.txt'), 'one\r\ntwo\r\nthree\r\n');
  await fs.writeFile(path.join(root, 'old.txt'), 'before\n');
  await fs.writeFile(path.join(root, 'delete.txt'), 'gone\n');
  const result = await toolApplyPatch({ patch: patch('*** Add File: nested/new.txt\n+new\n*** Update File: edit.txt\n@@\n one\n-two\n+TWO\n three\n*** Update File: old.txt\n*** Move to: renamed.txt\n@@\n-before\n+after\n*** Delete File: delete.txt') });
  assert.equal(await fs.readFile(path.join(root, 'edit.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n');
  assert.equal(await fs.readFile(path.join(root, 'nested/new.txt'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(root, 'renamed.txt'), 'utf8'), 'after\n');
  await assert.rejects(fs.stat(path.join(root, 'old.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'delete.txt')), { code: 'ENOENT' });
  assert.equal(result.codeChange.additions, 3);
  assert.equal(result.codeChange.deletions, 3);
  assert.deepEqual(result.codeChange.paths, ['nested/new.txt', 'edit.txt', 'old.txt', 'renamed.txt', 'delete.txt']);
}));

test('late mismatch and outside paths do not apply earlier valid edits', t => workspace(t, async root => {
  await fs.writeFile(path.join(root, 'a'), 'old\n');
  for (const tail of ['*** Update File: a\n@@\n-missing\n+new', '*** Add File: ../escape\n+bad']) {
    await assert.rejects(toolApplyPatch({ patch: patch(`*** Add File: new\n+new\n${tail}`) }));
    await assert.rejects(fs.stat(path.join(root, 'new')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'a'), 'utf8'), 'old\n');
  }
}));

test('refuses overwrites, duplicate targets, binary files, and symlinks', t => workspace(t, async root => {
  await fs.writeFile(path.join(root, 'a'), 'old\n');
  await fs.writeFile(path.join(root, 'b'), 'keep\n');
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0xff, 0]));
  for (const body of ['*** Add File: a\n+bad', '*** Update File: a\n*** Move to: b\n@@\n-old\n+bad', '*** Add File: c\n+c\n*** Add File: c\n+c', '*** Update File: binary\n@@\n+bad']) {
    await assert.rejects(toolApplyPatch({ patch: patch(body) }));
  }
  await fs.mkdir(path.join(root, 'target'));
  await fs.symlink(path.join(root, 'target'), path.join(root, 'link'), 'junction');
  await assert.rejects(toolApplyPatch({ patch: patch('*** Add File: link/bad\n+bad') }), /symbolic link/);
  assert.equal(await fs.readFile(path.join(root, 'b'), 'utf8'), 'keep\n');
}));

test('strict parsing, anchors, EOF, empty files, and missing trailing newline', () => {
  assert.throws(() => parsePatch('bad'), /Begin Patch/);
  assert.throws(() => parsePatch(patch('*** Update File: a')), /hunk/);
  const hunks = body => parsePatch(patch(`*** Update File: a\n${body}`))[0].hunks;
  assert.throws(() => patchText('a\na\n', hunks('@@\n-a\n+b')), /Ambiguous/);
  assert.equal(patchText('a\na\n', hunks('@@\n-a\n+b\n*** End of File')), 'a\nb\n');
  assert.equal(patchText('anchor\na', hunks('@@ anchor\n-a\n+b')), 'anchor\nb');
  assert.equal(patchText('', hunks('@@\n+new')), 'new\n');
  assert.equal(patchText('existing\n', hunks('@@\n+new')), 'existing\nnew\n');
});

test('repeated updates share staged text and stats, and late mismatches write nothing', t => workspace(t, async root => {
  const target = path.join(root, 'a');
  await fs.writeFile(target, 'one\ntwo\n');
  const first = '*** Update File: a\n@@\n-one\n+ONE';
  await assert.rejects(toolApplyPatch({ patch: patch(first + '\n*** Update File: a\n@@\n-missing\n+bad') }), /context not found/);
  assert.equal(await fs.readFile(target, 'utf8'), 'one\ntwo\n');
  const out = await toolApplyPatch({ patch: patch(first + '\n*** Update File: a\n@@\n ONE\n-two\n+TWO') });
  assert.equal(await fs.readFile(target, 'utf8'), 'ONE\nTWO\n');
  assert.deepEqual(out.codeChange.paths, ['a']);
  assert.equal(out.codeChange.additions, 2);
  assert.equal(out.codeChange.deletions, 2);
}));

test('write failures restore earlier edits', t => workspace(t, async root => {
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await fs.writeFile(a, 'old-a\n');
  await fs.writeFile(b, 'old-b\n');
  const write = fs.writeFile.bind(fs);
  let fail = true;
  t.mock.method(fs, 'writeFile', async (target, ...args) => {
    if (target === b && fail) { fail = false; throw new Error('simulated write failure'); }
    return write(target, ...args);
  });
  await assert.rejects(toolApplyPatch({ patch: patch('*** Update File: a\n@@\n-old-a\n+new-a\n*** Update File: b\n@@\n-old-b\n+new-b') }), /simulated write failure/);
  assert.equal(await fs.readFile(a, 'utf8'), 'old-a\n');
  assert.equal(await fs.readFile(b, 'utf8'), 'old-b\n');
}));

test('patch is catalogued and builder-only; Plan refuses even plan-document patches', () => {
  assert.ok(ALL_TOOL_IDS.includes('apply_patch'));
  assert.ok(BUILT_IN_TOOLS.some(t => t.id === 'apply_patch'));
  assert.ok(BOARD_BUILDER_TOOL_IDS.includes('apply_patch'));
  assert.ok(!BOARD_VERIFIER_TOOL_IDS.includes('apply_patch'));
  assert.ok(blockPlanModeWrite('plan', 'apply_patch', { patch: patch('*** Add File: documentation/plans/a.md\n+plan') }));
});

test('existing editors get patch with Ask permission, preserving explicit off', () => {
  assert.equal(normalizeToolConfig({ permissions: { default: { save_file: 'full' } } }).permissions.default.apply_patch, 'ask');
  assert.equal(normalizeToolConfig({ permissions: { default: { save_file: 'full', apply_patch: 'off' } } }).permissions.default.apply_patch, 'off');
  assert.equal(normalizeToolConfig({ enabled: { save_file: true, apply_patch: false } }).permissions.default.apply_patch, 'off');
});
