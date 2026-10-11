import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { readPlanType } from '../../server/orchestrator/core/plan-format.js';
import { validateBuildPlan } from '../../server/tools/validate-build-plan.js';
import { parsePlan, isParseErrors } from '../../server/orchestrator/core/parse-plan.js';

import { buildPlan } from '../helpers/build-plan.mjs';

test('plan type reads only top-level front matter and rejects invalid explicit types', () => {
  for (const value of ['build', '"build"', "'build'", 'build # single chat']) {
    assert.equal(readPlanType(buildPlan.replace('planType: build', `planType: ${value}`)), 'build');
  }
  assert.equal(readPlanType(buildPlan.replace(/\n/g, '\r\n')), 'build');
  assert.equal(readPlanType('\uFEFF' + buildPlan), 'build');
  assert.equal(readPlanType('# Legacy\nplanType: build'), 'orchestrate');
  assert.equal(readPlanType(buildPlan.replace('planType: build\n', '')), 'orchestrate');
  for (const value of ['', 'other', '[]', 'build\nplanType: orchestrate']) {
    assert.equal(readPlanType(buildPlan.replace('planType: build', `planType: ${value}`)), 'invalid');
  }
});

test('Build validator accepts sequential steps and completed checkboxes without board fields', () => {
  assert.deepEqual(validateBuildPlan(buildPlan), { errors: [], stepCount: 1 });
  assert.deepEqual(validateBuildPlan(buildPlan.replaceAll('[ ]', '[x]')), { errors: [], stepCount: 1 });
});

test('Build validator rejects missing sections, verification, outcomes, and broken ordering', () => {
  for (const invalid of [
    buildPlan.replace('## Goal and scope', '## Other'),
    buildPlan.replace('None.', ''),
    buildPlan.replace('- Verify: Run the widget test; assert it renders.', '- Verify:'),
    buildPlan.replace('### 1.', '### 2.'),
    buildPlan.replace('- [ ] Widget is visible.', ''),
    buildPlan.replace('- [ ] Widget renders without affecting existing widgets.', ''),
    buildPlan.replace('### 1. Add widget', '```md\n### 1. Add widget').replace('## Acceptance checklist', '```\n## Acceptance checklist'),
  ]) {
    const result = validateBuildPlan(invalid);
    assert.ok(result.errors.length > 0, invalid);
    assert.ok(result.errors.every((error) => error.line > 0 && error.hint));
  }
});

test('board intake rejects Build plans even when their body contains a valid task graph', () => {
  const board = fs.readFileSync(new URL('../fixtures/orchestrator-v2-p2g/plan.md', import.meta.url), 'utf8');
  assert.equal(isParseErrors(parsePlan(board)), false);
  const marked = board.replace(/^---/, '---\nplanType: build');
  assert.match(parsePlan(marked)[0].message, /Build plan/);
  assert.match(parsePlan(marked.replace('planType: build', 'planType: unknown'))[0].message, /Invalid planType/);
});

test('all shipped Build templates validate with the same schema', () => {
  for (const file of ['src/chat/prompts/work-agents/planner/agent.full.md', 'src/chat/prompts/work-agents/planner/agent.lite.md', 'src/chat/prompts/modes/plan.full.md', 'src/chat/prompts/modes/plan.lite.md', 'src/skills/plan-work/plan-template.md']) {
    const prompt = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const template = prompt.slice(prompt.indexOf('## Build plan schema')).match(/```markdown\n([\s\S]*?)\n```/)[1];
    assert.equal(readPlanType(template), 'build', file);
    assert.deepEqual(validateBuildPlan(template).errors, [], file);
  }
});
