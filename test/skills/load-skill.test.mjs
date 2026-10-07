import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { defaultToolsJson } from '../../server/config/home.js';
import { normalizeToolConfig } from '../../server/config/validators.js';
import { toolLoadSkill } from '../../server/skills/load-skill.js';
import { listMergedSkills } from '../../server/skills/scan.js';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';
import { DEFAULT_HEADLESS_TOOL_IDS, BOARD_VERIFIER_TOOL_IDS } from '../../server/runner/tool-set.js';
import { isParallelSafeTool } from '../../server/runner/parallel-tool-policy.js';

let scratch, appRoot, home;
const previousHome = process.env.MINNOW_HOME;

async function writeSkill(root, id, body, invocation = false) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: Test ${id} workflow\ndisable-model-invocation: ${invocation}\n---\n${body}`);
  return dir;
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-load-skill-'));
  appRoot = path.join(scratch, 'app');
  home = path.join(scratch, 'home');
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  const builtin = path.join(appRoot, 'src/skills');
  await writeSkill(builtin, 'impeccable', 'Design workflow');
  await writeSkill(builtin, 'review', 'Builtin workflow');
  await writeSkill(builtin, 'manual', 'User invocation only', true);
  await writeSkill(builtin, '_hidden', 'Hidden implementation');
  await writeSkill(builtin, 'disabled', 'Disabled workflow');
  await writeSkill(path.join(home, 'skills'), 'review', Array.from({ length: 550 }, (_, i) => `User instruction ${i + 1}`).join('\n'));
  await fs.writeFile(path.join(home, 'skills.json'), JSON.stringify({ enabled: { disabled: false } }));
  const references = path.join(home, 'skills/review/reference');
  await fs.mkdir(references);
  await fs.writeFile(path.join(references, 'checks.md'), 'Check correctness\nCheck regressions');
  await fs.writeFile(path.join(references, 'binary.bin'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(references, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
  await fs.writeFile(path.join(home, 'secret.txt'), 'outside skill');
  // Junctions need no symlink privilege on Windows and exercise realpath containment.
  await fs.symlink(home, path.join(references, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
});

after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(scratch, { recursive: true, force: true });
});

const load = async args => (await toolLoadSkill(args, appRoot)).result;

test('discovers only enabled, model-invocable skills; filters and paginates', async () => {
  const result = JSON.parse(await load({}));
  assert.deepEqual(result.skills.map(skill => skill.id), ['impeccable', 'review']);
  assert.equal(result.skills.find(skill => skill.id === 'review').source, 'user');
  assert.equal(result.total, 2);
  assert.equal(result.next_offset, null);
  assert.deepEqual(JSON.parse(await load({ query: 'REVIEW' })).skills.map(skill => skill.id), ['review']);
  const first = JSON.parse(await load({ limit: 1 }));
  assert.equal(first.next_offset, 2);
  const second = JSON.parse(await load({ offset: first.next_offset, limit: 1 }));
  assert.equal(second.skills[0].id, 'review');
  assert.equal(second.next_offset, null);
  assert.equal(JSON.parse(await load({ query: 'missing' })).total, 0);
  const catalog = await listMergedSkills(appRoot);
  assert.equal(catalog.find(skill => skill.id === 'manual').disableModelInvocation, true);
});

test('loads the user override and provides continuation windows and reference origin', async () => {
  const first = JSON.parse(await load({ id: 'review' }));
  assert.equal(first.content.split('\n').length, 200);
  assert.equal(first.content.split('\n')[0], 'User instruction 1');
  assert.equal(first.total_lines, 550);
  assert.equal(first.next_offset, 201);
  assert.equal(first.directory, await fs.realpath(path.join(home, 'skills/review')));
  const last = JSON.parse(await load({ id: 'review', offset: 501 }));
  assert.equal(last.content.split('\n').length, 50);
  assert.equal(last.next_offset, null);
  assert.match(first.usage, /does not pin/);
});

test('reads bundled references even outside the workspace and never runs scripts', async () => {
  const result = JSON.parse(await load({ id: 'review', reference: 'reference/checks.md', limit: 1 }));
  assert.equal(result.content, 'Check correctness');
  assert.equal(result.next_offset, 2);
  assert.equal(result.reference, 'reference/checks.md');
  const second = JSON.parse(await load({ id: 'review', reference: 'reference\\checks.md', offset: 2 }));
  assert.equal(second.content, 'Check regressions');
});

test('blocks disabled, user-only, hidden, unknown and malformed ids', async () => {
  for (const [id, message] of [
    ['disabled', /disabled in Settings/], ['manual', /explicit user invocation/],
    ['_hidden', /Invalid skill id/], ['absent', /Unknown skill/],
    ['../secret', /Invalid skill id/], [42, /Invalid skill id/], ['', /Invalid skill id/],
  ]) assert.match(await load({ id }), message);
});

test('rejects reference traversal, absolute paths, junction escapes and non-text files', async () => {
  for (const reference of ['../secret.txt', 'reference/../../secret.txt', '/secret.txt', 'C:\\secret.txt', '\\\\host\\share\\secret.txt', 'reference/escape/secret.txt', 'reference/checks.md:secret']) {
    assert.match(await load({ id: 'review', reference }), /^Error: Reference must stay inside/);
  }
  assert.match(await load({ id: 'review', reference: 'reference/binary.bin' }), /UTF-8 text/);
  assert.match(await load({ id: 'review', reference: 'reference/huge.md' }), /1 MB text limit/);
  assert.match(await load({ id: 'review', reference: 'reference' }), /must be a file/);
  assert.match(await load({ reference: 'SKILL.md' }), /id is required/);
  assert.match(await load({ id: 'review', reference: 'missing.md' }), /^Error:/);
});

test('validates windows and observes changed enablement on every call', async () => {
  for (const args of [{ offset: 0 }, { limit: 501 }, { limit: '2' }, { query: 3 }, { id: 'review', offset: 1.5 }]) {
    assert.match(await load(args), /^Error:/);
  }
  await fs.writeFile(path.join(home, 'skills.json'), JSON.stringify({ enabled: { disabled: false, review: false } }));
  assert.match(await load({ id: 'review' }), /disabled in Settings/);
  assert.ok(!JSON.parse(await load({})).skills.some(skill => skill.id === 'review'));
  await fs.writeFile(path.join(home, 'skills.json'), JSON.stringify({ enabled: { disabled: false } }));
});

test('character budgets return complete JSON with continuation rather than losing instructions', async () => {
  const dir = path.join(home, 'skills/review/reference');
  const lines = Array.from({ length: 200 }, (_, index) => `${index}: ${'x'.repeat(1000)}`);
  await fs.writeFile(path.join(dir, 'long.md'), lines.join('\n'));
  const firstRaw = await load({ id: 'review', reference: 'reference/long.md' });
  assert.ok(firstRaw.length <= 32_000);
  const first = JSON.parse(firstRaw);
  assert.ok(first.next_offset > 1 && first.next_offset < 200);
  const second = JSON.parse(await load({ id: 'review', reference: 'reference/long.md', offset: first.next_offset }));
  assert.equal(second.content.split('\n')[0], lines[first.next_offset - 1]);
  await fs.writeFile(path.join(dir, 'one-line.md'), 'x'.repeat(40_000));
  assert.match(await load({ id: 'review', reference: 'reference/one-line.md' }), /full_result: true/);
  const full = JSON.parse(await load({ id: 'review', reference: 'reference/one-line.md', full_result: true }));
  assert.equal(full.content.length, 40_000);
});

test('registers a read-only tool across shared and unattended tool sets with preserved permissions', () => {
  assert.equal(defaultToolsJson().permissions.default.load_skill, 'full');
  assert.ok(BUILT_IN_TOOLS.some(tool => tool.id === 'load_skill' && tool.serverRequired));
  assert.ok(DEFAULT_HEADLESS_TOOL_IDS.includes('load_skill'));
  assert.ok(BOARD_VERIFIER_TOOL_IDS.includes('load_skill'));
  assert.equal(isParallelSafeTool('load_skill'), true);
  for (const raw of [undefined, {}, { enabled: { read_file: true } }]) {
    const config = normalizeToolConfig(raw);
    assert.equal(config.enabled.load_skill, true);
    assert.equal(config.permissions.default.load_skill, 'full');
  }
  assert.equal(normalizeToolConfig({ enabled: { load_skill: false } }).permissions.default.load_skill, 'off');
  assert.equal(normalizeToolConfig({ permissions: { default: { load_skill: 'ask' } } }).permissions.default.load_skill, 'ask');
});
