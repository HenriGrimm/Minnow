/**
 * Composer includes mode fragments; HTML comments stripped from composed output.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  composeSystemPrompt,
  shouldSuppressModePart,
  stripPromptHtmlComments,
} from '../../src/chat/prompts/prompt-composer.ts';
import {
  registerPromptFilesFromRaw,
  resetPromptRegistry,
} from '../../src/chat/prompts/prompt-loader.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadBuiltinModePromptMap, registerShippedWorkAgents, repoPath } from './test-helpers.mts';

async function loadBaseAndModeFixtures(): Promise<Record<string, string>> {
  const map = await loadBuiltinModePromptMap();
  const baseFull = await fs.readFile(
    repoPath('src/chat/prompts/base/default.full.md'),
    'utf8',
  );
  map['./base/default.full.md'] = baseFull;
  const toolDir = repoPath('src/chat/prompts/tool-usage');
  map['./tool-usage/default.full.md'] = await fs.readFile(
    path.join(toolDir, 'default.full.md'),
    'utf8',
  );
  map['./tool-usage/sub-agent-delegation.full.md'] = await fs.readFile(
    path.join(toolDir, 'sub-agent-delegation.md'),
    'utf8',
  );
  map['./tool-usage/sub-agent-delegation.lite.md'] = await fs.readFile(
    path.join(toolDir, 'sub-agent-delegation.lite.md'),
    'utf8',
  );
  const agentsDir = repoPath('src/chat/prompts/work-agents');
  for (const agentId of ['builder', 'planner']) {
    for (const profile of ['full', 'lite'] as const) {
      const rel = `./work-agents/${agentId}/agent.${profile}.md`;
      const abs = path.join(agentsDir, agentId, `agent.${profile}.md`);
      try {
        map[rel] = await fs.readFile(abs, 'utf8');
      } catch {
        /* optional lite */
      }
    }
  }
  return map;
}

describe('composeSystemPrompt mode part', () => {
  beforeEach(async () => {
    resetPromptRegistry();
    await registerShippedWorkAgents();
  });

  test('stripPromptHtmlComments removes MINNOW_MODE_MARKER', () => {
    const raw = '<!-- MINNOW_MODE_MARKER: plan full -->\n\n# Plan mode';
    assert.equal(stripPromptHtmlComments(raw), '# Plan mode');
  });

  test('shouldSuppressModePart when default work-agent is active', () => {
    assert.equal(
      shouldSuppressModePart({ modeId: 'build', workAgentId: 'builder' } as never),
      true,
    );
    assert.equal(
      shouldSuppressModePart({ modeId: 'build', workAgentId: 'researcher' } as never),
      false,
    );
    assert.equal(
      shouldSuppressModePart({ modeId: 'build', workAgentId: null } as never),
      false,
    );
  });

  test('plan full includes plan heading; markers stripped from compose', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.match(out, /Operating mode: Plan/);
    assert.doesNotMatch(out, /MINNOW_MODE_MARKER/);
  });

  test('both planning profiles retain the format choice with and without the default Planner', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    for (const profile of ['full', 'lite'] as const) {
      for (const workAgentId of ['planner', null]) {
        const out = composeSystemPrompt({
          profile, cwd: '/test', modeId: 'plan', expertId: null, workAgentId,
          skillBody: null, memoryBlock: null, enabledToolIds: ['ask_question', 'check_plan'], infoPresetId: null,
        });
        assert.match(out, /How do you want to execute this plan\?/);
        assert.match(out, /planType: build/);
        assert.match(out, /Preserve its type unless the user explicitly requests conversion/);
        assert.match(out, /## Wave Breakdown/);
        assert.match(out, /## Implementation steps/);
      }
    }
  });

  test('switching modeId changes composed output', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const buildOut = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    const planOut = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'plan',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.notEqual(buildOut, planOut);
    assert.match(buildOut, /Operating mode: Build/);
    assert.match(planOut, /Operating mode: Plan/);
  });

  test('build with default builder suppresses mode body', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'build',
      expertId: null,
      workAgentId: 'builder',
      workAgentLabel: 'Builder',
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.match(out, /Work agent: Builder/);
    assert.doesNotMatch(out, /Operating mode: Build/);
  });

  test('general full includes mode handoff', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'general',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: [],
      infoPresetId: null,
    });
    assert.match(out, /Operating mode: General/);
    assert.doesNotMatch(out, /MINNOW_MODE_MARKER/);
  });

  test('lite profile uses lite mode body without marker comments', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'lite',
      cwd: '/test',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['get_datetime'],
      infoPresetId: null,
    });
    assert.match(out, /\*\*Build mode\.\*\*/);
    assert.doesNotMatch(out, /MINNOW_MODE_MARKER/);
    assert.doesNotMatch(out, /<!-- LITE -->/);
  });

  test('build full compose with spawn_sub_agent includes delegation fragment', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'build',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['spawn_sub_agent', 'read_file'],
      infoPresetId: null,
    });
    assert.match(out, /Sub-agent delegation/);
    assert.match(out, /researcher/);
  });

  test('orchestrate compose omits sub-agent delegation fragment', async () => {
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'orchestrate',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['spawn_sub_agent'],
      infoPresetId: null,
    });
    assert.doesNotMatch(out, /Sub-agent delegation/);
  });

  test('orchestrate has no default work agent, so the mode body survives', async () => {
    // V2 deleted the `orchestrator` work-agent (prompts and registry entry) —
    // the server engine owns board execution now. With no default agent for the
    // mode there is nothing carrying deliverable instructions, so suppressing
    // the mode body would leave the turn with no operating instructions at all.
    assert.equal(
      shouldSuppressModePart({
        modeId: 'orchestrate',
        workAgentId: 'orchestrator',
      } as never),
      false,
    );
    registerPromptFilesFromRaw(await loadBaseAndModeFixtures());
    const out = composeSystemPrompt({
      profile: 'full',
      cwd: '/test',
      modeId: 'orchestrate',
      expertId: null,
      workAgentId: null,
      skillBody: null,
      memoryBlock: null,
      enabledToolIds: ['read_file'],
      infoPresetId: null,
      orchestratePlanPath: 'documentation/plans/fixture-plan.md',
    });
    assert.match(out, /Operating mode: Orchestrate/);
  });

  test('a mode with a default work agent still suppresses its mode body', async () => {
    // The suppression rule itself is unchanged; only orchestrate lost its agent.
    assert.equal(
      shouldSuppressModePart({ modeId: 'build', workAgentId: 'builder' } as never),
      true,
    );
  });
});
