import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';

test('bundled image skill is discoverable and uses only the named Minnow image tools', async () => {
  const skill = await fs.readFile(new URL('../../src/skills/image-generation/SKILL.md', import.meta.url), 'utf8');
  const manifest = JSON.parse(await fs.readFile(new URL('../../src/skills/builtin-manifest.json', import.meta.url), 'utf8'));
  assert.match(JSON.stringify(manifest), /image-generation/);
  for (const name of ['generate_image', 'image_generation_info']) {
    assert.ok(BUILT_IN_TOOLS.some(tool => tool.id === name)); assert.ok(skill.includes(name));
  }
  assert.match(skill, /Plan mode/); assert.match(skill, /Text-only/); assert.match(skill, /never blindly resubmit/i);
  assert.doesNotMatch(skill, /sk-[A-Za-z0-9]|gpt-image-\d/);
});
