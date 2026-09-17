import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCodeActivity, readCodeActivity, activityWorkspaceKey } from '../../server/activity/store.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { countLineChangeStats, buildDiffLines } from '../../server/tools/line-diff-stats.js';

test('activity persists across reads, deduplicates delivery, and isolates projects and sources', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-activity-test-'));
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  try {
    const a = path.join(home, 'a'), b = path.join(home, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const event = { id: 'one', source: 'agent', additions: 10, deletions: 4, paths: ['a.ts'] };
    assert.equal(recordCodeActivity(a, event), true);
    assert.equal(recordCodeActivity(a, event), false);
    assert.equal(recordCodeActivity(a, { ...event, id: 'two', source: 'completions' }), true);
    assert.equal(readCodeActivity(a).days.length, 2);
    assert.equal(readCodeActivity(a, { source: 'agent' }).days[0].additions, 10);
    assert.equal(readCodeActivity(b).days.length, 0);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(readCodeActivity(a, { day }).events.length, 2);
    assert.throws(() => recordCodeActivity(a, { ...event, additions: -1 }));
    assert.throws(() => recordCodeActivity(a, { ...event, source: 'git-commit' }));
    assert.equal(recordCodeActivity(a, { ...event, additions: 0, deletions: 0 }), false);
    assert.throws(() => readCodeActivity(a, { day: '../escape' }));
    for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const localDay = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
      const zoned = readCodeActivity(a, { timeZone, day: localDay });
      assert.equal(zoned.days[0].day, localDay, `days bucket in ${timeZone}`);
      assert.equal(zoned.events.length, 2);
    }
    assert.throws(() => readCodeActivity(a, { timeZone: 'Not/AZone' }));
    const worktree = path.join(home, 'linked'); fs.mkdirSync(worktree);
    const gitDir = path.join(a, '.git', 'worktrees', 'linked'); fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}`);
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..');
    assert.equal(activityWorkspaceKey(worktree), activityWorkspaceKey(a));
    assert.equal(readCodeActivity(worktree).days.length, 2);
    const { executeServerTool } = await import('../../server/runtime/tools-middleware.js');
    await executeServerTool('save_file', { path: 'manual.txt', content: 'manual edit' }, { workspaceRoot: b });
    assert.equal(readCodeActivity(b).days.length, 0, 'manual editor saves are not AI edits');
    const result = await executeServerTool('save_file', { path: 'agent.txt', content: 'agent edit' }, { workspaceRoot: b, agentActivity: true });
    assert.ok(result.codeChange, String(result.result));
    assert.equal(readCodeActivity(b).days[0].additions, 1);
    await executeServerTool('save_file', { path: 'agent.txt', content: 'agent edit' }, { workspaceRoot: b, agentActivity: true });
    assert.equal(readCodeActivity(b).days[0].additions, 1, 'an unchanged retry adds no activity');
  } finally {
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache(); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('line totals are complete even when the diff preview is capped', () => {
  const before = Array.from({ length: 700 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 900 }, (_, i) => `new ${i}`).join('\n');
  assert.deepEqual(countLineChangeStats(before, after), { additions: 900, deletions: 700 });
  assert.equal(buildDiffLines(before, after).lines.length, 500);
});

test('agent edits link only a real chat, never the runtime owner key', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-activity-chat-test-'));
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  try {
    const root = path.join(home, 'project'); fs.mkdirSync(root);
    const { executeServerTool } = await import('../../server/runtime/tools-middleware.js');
    // Board runs key their runtime by board id; that is not a chat the Home page can open.
    const boardOwner = { chatId: 'my-board', runId: 'task-1', agentId: 'attempt-1' };
    await executeServerTool('save_file', { path: 'board.txt', content: 'board edit' }, { workspaceRoot: root, agentActivity: true, runtimeOwner: boardOwner });
    await executeServerTool('save_file', { path: 'chat.txt', content: 'chat edit' }, { workspaceRoot: root, agentActivity: true, runtimeOwner: boardOwner, activityChatId: 'chat-1' });
    const day = readCodeActivity(root).days[0].day;
    const events = readCodeActivity(root, { day }).events;
    assert.equal(events.find(e => e.paths[0] === 'board.txt')?.chatId, null);
    assert.equal(events.find(e => e.paths[0] === 'chat.txt')?.chatId, 'chat-1');
  } finally {
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache(); fs.rmSync(home, { recursive: true, force: true });
  }
});
