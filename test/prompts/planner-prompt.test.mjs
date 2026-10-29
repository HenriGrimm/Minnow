/**
 * Planner work-agent prompt — optional clarifying-questions gate (Plan mode Phase 1).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PLANNER_DIR = path.join(REPO_ROOT, 'src/chat/prompts/work-agents/planner');

describe('planner work-agent prompts', () => {
  test('planning sources specify browser pass conditions without a fixed total time budget', async () => {
    for (const relative of ['src/chat/prompts/work-agents/planner/agent.full.md', 'src/chat/prompts/work-agents/planner/agent.lite.md', 'src/skills/plan-work/SKILL.md', 'src/skills/plan-work/plan-template.md']) {
      const body = await fs.readFile(path.join(REPO_ROOT, relative), 'utf8');
      assert.doesNotMatch(body, /two-minute total (?:browser-check )?budget/);
      assert.match(body, /observable pass condition/);
    }
  });
  test('both profiles and Plan mode choose the format before scope questions and preserve revisions', async () => {
    for (const relative of ['work-agents/planner/agent.full.md', 'work-agents/planner/agent.lite.md', 'modes/plan.full.md', 'modes/plan.lite.md']) {
      const body = await fs.readFile(path.join(REPO_ROOT, 'src/chat/prompts', relative), 'utf8');
      assert.match(body, /How would you like to build this\?/);
      assert.match(body, /Wait for the answer before drafting/);
      assert.match(body, /Ask once per plan/);
      assert.match(body, /Preserve its type unless the user explicitly requests conversion/);
      assert.match(body, /Unattended board or Super Plan tasks/);
      assert.match(body, /planType: build/);
      assert.match(body, /For Build, summarize the sequential steps and suggest \*\*Build\*\*/);
      const choice = body.indexOf('How would you like to build this?');
      const scope = body.indexOf('Would you like a few questions');
      if (scope >= 0) assert.ok(choice < scope);
    }
  });
  test('agent.full.md offers optional clarifying-questions grill before explore', async () => {
    const body = await fs.readFile(path.join(PLANNER_DIR, 'agent.full.md'), 'utf8');
    assert.match(body, /ask_question/);
    assert.match(body, /Would you like a few questions to help decide what to include\?/);
    assert.match(body, /lightweight grill/i);
    assert.match(body, /two batches of up to 4 questions/i);
    assert.match(body, /one `ask_question` call/);
    assert.doesNotMatch(body, /one question at a time/i);
    assert.doesNotMatch(body, /never batch/i);
    assert.match(body, /recommended answer/i);
    assert.match(body, /\/grilling/);

    const processSection = body.slice(body.indexOf('## Process'));
    const exploreIdx = processSection.indexOf('**Explore the codebase.**');
    const clarifyIdx = processSection.indexOf('Would you like a few questions');
    assert.ok(clarifyIdx >= 0 && exploreIdx >= 0, 'Process section must include clarify gate and explore step');
    assert.ok(clarifyIdx < exploreIdx, 'clarifying-questions gate must appear before Explore the codebase');
  });

  test('agent.lite.md mentions optional clarifying-questions gate', async () => {
    const body = await fs.readFile(path.join(PLANNER_DIR, 'agent.lite.md'), 'utf8');
    assert.match(body, /Would you like a few questions to help decide what to include\?/);
    assert.match(body, /lightweight grill/i);
    assert.match(body, /2 batches of up to 4 questions/);
    assert.doesNotMatch(body, /one at a time/i);
  });

  test('agent.full.md teaches greenfield solo Wave 1 and scheduler-only Depends on', async () => {
    const body = await fs.readFile(path.join(PLANNER_DIR, 'agent.full.md'), 'utf8');
    assert.match(body, /Greenfield \(empty workspace\)/);
    assert.match(body, /Wave 1 is one scaffold task only/);
    assert.match(body, /Waves do not sequence themselves/);
  });

  test('agent.lite.md teaches greenfield solo Wave 1 and scheduler-only Depends on', async () => {
    const body = await fs.readFile(path.join(PLANNER_DIR, 'agent.lite.md'), 'utf8');
    assert.match(body, /empty workspace: Wave 1 is scaffold only/);
    assert.match(body, /waves do not wait/);
  });
});
