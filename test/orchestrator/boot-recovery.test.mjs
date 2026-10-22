import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createBoard, appendEvents, resetJournalCache } from '../../server/orchestrator/journal.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { bootBoardRuntime, setEffectorFactory } from '../../server/orchestrator/middleware.js';
import { disposeEngines, peekEngine } from '../../server/orchestrator/engine.js';
import { getEffectiveWorkspaceRoot } from '../../server/runtime/path-access.js';
import { armBoardResumeGate, resetBoardResumeGateForTests } from '../../server/orchestrator/resume-gate.js';

test('cold boot resumes only opted-in running boards in their own workspaces without any UI', { timeout: 15000 }, async () => {
  const previous = process.env.MINNOW_HOME;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-boot-recovery-'));
  const observed = new Map();
  let complete;
  const launched = new Promise((resolve) => { complete = resolve; });
  try {
    process.env.MINNOW_HOME = path.join(scratch, 'home');
    resetMinnowHomeCache();
    resetJournalCache();
    armBoardResumeGate();
    setEffectorFactory((boardId) => {
      const live = [];
      return {
        inspect: () => [...live],
        async start(want) {
          observed.set(boardId, getEffectiveWorkspaceRoot());
          const attempt = { ...want, attemptId: `${boardId}-attempt` };
          live.push(attempt);
          if (observed.size === 2) complete();
          return { attemptId: attempt.attemptId };
        },
        async stop() { live.splice(0); },
        onEnd() {},
      };
    });
    for (const [id, running, version] of [['a', true, 1], ['b', true, 1], ['stopped', false, 1], ['legacy', true, 0]]) {
      const root = path.join(scratch, id);
      await fs.mkdir(root);
      await createBoard(id);
      await appendEvents(id, [
        makeEvent('board.created', { boardId: id, planPath: 'plan.md', workspacePath: root, waves: [], tasks: [{ id: 'A', title: 'A', wave: 1, touches: ['**/*'], dependsOn: [], build: 'b', test: 't', accept: 'a' }] }),
        ...(running ? [makeEvent('board.started', { concurrency: 1, ...(version ? { recoveryVersion: version } : {}) })] : []),
      ]);
    }
    await bootBoardRuntime();
    await launched;
    assert.equal(observed.get('a'), path.join(scratch, 'a'));
    assert.equal(observed.get('b'), path.join(scratch, 'b'));
    assert.equal(peekEngine('stopped'), undefined);
    assert.equal(peekEngine('legacy'), undefined);
    await bootBoardRuntime();
    assert.equal(observed.size, 2);
  } finally {
    disposeEngines();
    resetBoardResumeGateForTests();
    if (previous === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache();
    resetJournalCache();
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())));
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
