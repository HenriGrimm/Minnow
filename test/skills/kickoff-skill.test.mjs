import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseSkillFrontmatter } from '../../server/skills/parse-frontmatter.js';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const kickoff = read('src/skills/kickoff/SKILL.md');

test('kickoff frontmatter parses as a model-invocable built-in', () => {
  const { meta } = parseSkillFrontmatter(kickoff);
  assert.equal(meta.name, 'kickoff');
  assert.equal(meta['disable-model-invocation'], 'false');
  assert.ok(meta.description.trim().length > 0);
});

// Kickoff loads these through load_skill; a rename elsewhere would break it silently.
const LINKED = [
  { skill: 'impeccable', reference: 'reference/init.md', headings: ['## Step 5: Decide on DESIGN.md', '## Step 6: Configure live mode', '## Step 7: Recommend starting points'] },
  { skill: 'impeccable', reference: 'reference/document.md', headings: [] },
  { skill: 'impeccable', reference: 'reference/shape.md', headings: [] },
  {
    skill: 'frontend-design',
    reference: 'reference/frontend-aesthetics.md',
    headings: ['## Discover the Brief', '## Creative Direction', '## Match the Surface', '## The Specificity Ladder'],
  },
];

for (const { skill, reference, headings } of LINKED) {
  test(`kickoff link ${skill}/${reference} exists`, () => {
    assert.ok(kickoff.includes(reference), `kickoff no longer references ${reference}`);
    const body = read(`src/skills/${skill}/${reference}`);
    for (const heading of headings) {
      assert.ok(body.includes(heading), `${skill}/${reference} is missing "${heading}"`);
      const name = heading.replace(/^#+\s*/, '').replace(/:.*$/, '');
      if (skill === 'frontend-design') assert.ok(kickoff.includes(`**${name}**`), `kickoff no longer names "${name}"`);
    }
  });
}

test('kickoff names frontend-design workflow steps that exist', () => {
  const workflow = read('src/skills/frontend-design/SKILL.md');
  for (const step of ['Understand the task', 'Choose a direction']) {
    assert.ok(kickoff.includes(`*${step}*`), `kickoff no longer names "${step}"`);
    assert.ok(workflow.includes(`**${step}.**`), `frontend-design workflow is missing "${step}"`);
  }
});
