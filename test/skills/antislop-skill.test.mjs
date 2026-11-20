import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { toolLoadSkill } from '../../server/skills/load-skill.js';
import { parseSlashCommand } from '../../src/skills/parse-slash.ts';

const root = new URL('../../', import.meta.url);

test('Antislop is discoverable online and offline and ships readable references', async (t) => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-antislop-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = scratch;
  resetMinnowHomeCache();
  t.after(async () => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const load = async args => {
    const { result } = await toolLoadSkill(args, fileURLToPath(root));
    assert.doesNotMatch(result, /^Error:/);
    return JSON.parse(result);
  };
  const { skills } = await load({ query: 'antislop' });
  const [entry] = skills.filter(skill => skill.id === 'antislop');
  assert.equal(entry?.label, 'Antislop');
  assert.equal(entry?.source, 'builtin');

  const manifest = JSON.parse(await fs.readFile(new URL('src/skills/builtin-manifest.json', root), 'utf8'));
  assert.deepEqual(manifest.skills.find(skill => skill.id === 'antislop'), {
    ...entry,
    disableModelInvocation: false,
  });

  const body = await load({ id: 'antislop' });
  assert.equal(body.next_offset, null);
  for (const [reference, heading] of [
    ['reference/audit-checklist.md', '# Antislop audit checklist'],
    ['reference/report-template.md', '# Antislop audit'],
    ['reference/comments-cleanup.md', '# Antislop comment cleanup'],
    ['reference/pattern-census.md', '# Antislop pattern census'],
  ]) {
    const file = await load({ id: 'antislop', reference });
    assert.ok(file.content.startsWith(heading));
    assert.equal(file.next_offset, null);
  }
  for (const reference of ['reference/audit-checklist.md', 'reference/report-template.md', 'reference/comments-cleanup.md', 'reference/pattern-census.md']) {
    assert.ok(body.content.includes(`(${reference})`), `SKILL.md no longer links ${reference}`);
  }
  for (const mode of ['## Auto mode', '## Diff mode', '## Resume mode', '`antislop/.gitignore`']) {
    assert.ok(body.content.includes(mode), `SKILL.md is missing ${mode}`);
  }
});

test('the slash picker passes Antislop mode arguments through as user text', () => {
  for (const suffix of ['', 'report', 'issues', 'multi', 'multi issues', 'report multi', 'auto', 'auto multi', 'diff', 'diff origin/main', 'resume', 'comments', 'comments smart src/ui', 'comments full src/ui']) {
    assert.deepEqual(parseSlashCommand(`/antislop ${suffix}`), {
      skillId: 'antislop',
      userText: suffix,
    });
  }
});
