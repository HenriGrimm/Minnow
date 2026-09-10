import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createEntry, appendEvents, readEvents } from '../../server/super-plan/journal.js';
import { getSuperPlanEngine, resetSuperPlanMiddlewareForTests, setSuperPlanEffectorFactory } from '../../server/super-plan/middleware.js';
import { createSplitEffector } from '../../server/super-plan/effector-split.js';
import { createGateEffector } from '../../server/super-plan/effector-gate.js';
import { createDelegatedEffector, getDelegatedEffector } from '../../server/super-plan/effector-delegated.js';
import { createHeadlessEffector } from '../../server/super-plan/effector-headless.js';
import { answerJournaledGate } from '../../server/super-plan/ask-bridge.js';
import { artifactPaths } from '../../server/super-plan/artifacts.js';

async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('pipeline did not reach expected state');
}

test('production gate + delegated + headless effectors complete two review rounds without renderer sequencing', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-production-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetSuperPlanMiddlewareForTests();
  let reviewCount = 0;
  const runId = 'production-12345678';
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(workspace);
  setSuperPlanEffectorFactory((runId) => {
    const delegated = createDelegatedEffector({ runId });
    const headless = createHeadlessEffector({ runId, model: { providerId: 'fixture', id: 'fixture' }, runTurn: async (options) => {
      reviewCount++;
      const parsed = options.parseReport({ summary: 'Reviewed the artifact', findings: reviewCount === 1 ? [{ title: 'Missing verification', detail: 'Add a reproducible verification step.', severity: 'blocker', paths: ['src/app.ts'] }] : [], artifacts: [] });
      assert.equal(parsed.ok, true);
      return parsed.result;
    } });
    return createSplitEffector({ byRole: { interview: () => delegated, draft: () => delegated, review: () => headless, gate: () => createGateEffector({ runId }) } });
  });
  try {
    await createEntry(runId);
    await appendEvents(runId, [{ type: 'run.created', runId, prompt: 'Build a useful feature', workspacePath: workspace, config: { interview: false, research: false, polish: 'never', reviewRounds: 2 } }, { type: 'run.started' }]);
    const engine = await getSuperPlanEngine(runId, { tickMs: 20 });
    await engine.tick();
    await until(() => engine.getState().gate?.kind === 'spec');
    const specGate = engine.getState().gate;
    const answer = await answerJournaledGate({ engine, runId, gateId: specGate.gateId, answer: 'confirm' });
    assert.equal(answer.ok, true);
    for (let draft = 1; draft <= 2; draft++) {
      await until(() => engine.getState().attempts.some((a) => a.stage === 'draft' && !a.ended));
      const state = engine.getState();
      const attempt = state.attempts.find((a) => a.stage === 'draft' && !a.ended);
      const delegated = getDelegatedEffector(runId);
      assert.equal(delegated.claim(attempt.attemptId, 'test-window').ok, true);
      const planPath = artifactPaths(state).planPath;
      await fs.writeFile(path.join(workspace, planPath), `# Feature plan\n\n## Context\nDraft ${draft}\n\n## Verification\n${draft === 2 ? 'Run the focused suite.' : 'To be decided.'}\n`);
      assert.equal((await delegated.finish(attempt.attemptId, { clientId: 'test-window', outcome: 'pass' })).ok, true);
    }
    await until(() => engine.getState().gate?.kind === 'accept');
    assert.equal(reviewCount, 2);
    assert.equal(engine.getState().reviews.length, 2);
    assert.equal(engine.getState().reviews[1].findings.length, 0);
    await answerJournaledGate({ engine, runId, gateId: engine.getState().gate.gateId, answer: 'accept' });
    await until(() => engine.getState().finished);
    assert.equal(engine.getState().runOutcome, 'pass');
    const count = (await readEvents(runId)).length;
    await engine.tick();
    await engine.tick();
    assert.equal((await readEvents(runId)).length, count);
  } finally {
    resetSuperPlanMiddlewareForTests();
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  }
});
