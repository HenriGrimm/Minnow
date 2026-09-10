import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { functionCallChunks } from '../../scripts/fake-model-server.mjs';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { openWorkspace, closeWorkspace } from '../../server/workspace/open-workspaces.js';
import { createProvider } from '../../server/providers/store.js';
import { derive } from '../../server/super-plan/derive.js';
import { createHeadlessEffector } from '../../server/super-plan/effector-headless.js';
import { runResearchStage } from '../../server/super-plan/research.js';
import { createStageTranscriptStore } from '../../server/super-plan/transcripts.js';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import { projectSuperPlan } from '../../server/super-plan/projection.js';

test('real runner executes a fixture read and captures structured review findings', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-runner-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  openWorkspace(home);
  try {
    await createProvider({ id: 'sp-fixture', label: 'Fixture', baseUrl: 'http://127.0.0.1:9', apiKind: 'openai-v1' });
    const planPath = 'documentation/plans/fixture.md';
    await fs.mkdir(path.join(home, 'documentation/plans'), { recursive: true });
    await fs.writeFile(path.join(home, planPath), '# Plan\n\n## Verification\nRun tests.');
    const state = derive([{ type: 'run.created', runId: 'real-runner', prompt: 'Review fixture', workspacePath: home }, { type: 'plan.written', path: planPath }]);
    let calls = 0;
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    const effector = createHeadlessEffector({ runId: state.runId, getState: () => state, model: { providerId: 'sp-fixture', id: 'fixture' }, limits: { maxTurns: 4, wallClockMs: 5000 }, postChatCompletions: async (_provider, body) => {
      calls++;
      if (calls > 1) assert.ok(body.messages.some((message) => message.role === 'tool' && String(message.content).includes('Verification')), 'review must actually read the fixture');
      const chunks = calls === 1 ? functionCallChunks('read_file', { path: planPath }, 'read') : functionCallChunks('report_outcome', { summary: 'No issues found', findings: [], artifacts: [] }, 'report');
      return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    effector.onEnd(done);
    await effector.start({ taskId: state.runId, role: 'review', seedKind: 'initial' });
    const end = await finished;
    assert.equal(end.outcome, 'pass', JSON.stringify({ end, calls, transcript: createStageTranscriptStore(state.runId, 'review').load('ignored') }));
    assert.deepEqual(end.evidence.findings, []);
    assert.equal(calls, 2);
    const resumed = createStageTranscriptStore(state.runId, 'review');
    assert.ok(resumed.load('ignored').messages.some((message) => message.role === 'tool'));
  } finally {
    closeWorkspace(home);
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('research starts a continuation for interrupted work and saves the report', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-research-'));
  const state = derive([{ type: 'run.created', runId: 'research', prompt: 'Explore', workspacePath: workspace, config: { researchDepth: 'quick' } }, { type: 'research.started', researchId: 'old' }]);
  const facts = [];
  let start;
  try {
    const result = await runResearchStage({ state, engine: { append: async (events) => facts.push(...events) }, signal: new AbortController().signal, store: {
      getResearchStatus: async (id) => ({ status: id === 'old' ? 'interrupted' : 'done' }),
      startResearch: async (options) => { start = options; return { researchId: 'new' }; },
      getResearchResult: async () => ({ result: '# Research\nEvidence.' }),
      cancelResearch: () => {},
    } });
    assert.equal(result.outcome, 'pass');
    assert.equal(start.continueFrom, 'old');
    assert.equal(start.maxRounds, 2);
    assert.equal(facts[0].researchId, 'new');
    assert.match(await fs.readFile(path.join(workspace, 'documentation/plans/references/research-research.md'), 'utf8'), /Evidence/);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('session normalization preserves the server projection and open gate', () => {
  const state = derive([{ type: 'run.created', runId: 'projection', prompt: 'Build', config: { interview: false } }, { type: 'run.started' }, { type: 'gate.opened', kind: 'spec', gateId: 'g:1', attemptId: 'g' }]);
  const view = projectSuperPlan(state, 42);
  const chat = normalizeChatRow({ id: 'chat', modeId: 'super-plan', superPlanRunId: 'projection', superPlanView: view });
  assert.equal(chat.superPlanView.stageIndex, 1);
  assert.equal(chat.superPlanView.gate.gateId, 'g:1');
  assert.equal(chat.superPlanView.state, 'waiting');
});
