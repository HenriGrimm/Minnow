import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeReefActivity, tailText } from '../../src/reef/activity.ts';
import type { ReefRun } from '../../src/reef/types.ts';

const run = (patch: Partial<ReefRun>): ReefRun => ({ id: 'run-1', prompt: 'Make a timer', state: 'building', progress: 40, createdAt: 1, log: '', attempt: 0, chatIds: [], ...patch });

test('Reef activity names what the agent is doing in plain words', () => {
  const tools = [
    { id: 'a', name: 'save_file', args: { path: 'src/app.ts' }, result: 'ok' },
    { id: 'b', name: 'replace_text_in_file', args: { path: 'src\\index.html' } },
  ];
  const working = describeReefActivity(run({ agentSessions: [{ chatId: 'c', phase: 'build', state: 'running', activity: 'tools', rounds: [{ id: 'r', text: '', reasoning: '', tools }] }] }));
  assert.equal(working.stage, 'Building');
  assert.equal(working.headline, 'Editing index.html');
  assert.deepEqual(working.files, ['app.ts', 'index.html']);
  assert.equal(working.tools, 2);
  const thinking = describeReefActivity(run({ state: 'planning', agentSessions: [{ chatId: 'c', phase: 'plan', state: 'running', activity: 'thinking', rounds: [{ id: 'r', text: '', reasoning: 'Weigh **local storage** against a fi', tools: [] }] }] }));
  assert.equal(thinking.headline, 'Thinking it through');
  assert.equal(thinking.detail, 'Weigh local storage against a', 'the word still being typed is held back');
  const checking = describeReefActivity(run({ state: 'checking', log: 'vite v8\n\u001b[32m✓ built in 107ms\u001b[39m\n' }));
  assert.equal(checking.headline, 'Testing your app');
  assert.equal(checking.detail, '✓ built in 107ms');
});

test('Reef activity keeps stack traces out of the headline when a build stops', () => {
  const failed = describeReefActivity(run({ state: 'failed', failedStage: 'checking', error: 'node:internal/modules/run_main:107 triggerUncaughtException(' }));
  assert.equal(failed.stage, 'Stopped while testing');
  assert.equal(failed.headline, 'Your app didn’t pass its checks');
  assert.doesNotMatch(failed.detail, /node:internal/);
  assert.equal(describeReefActivity(run({ state: 'ready' })).headline, 'Your app is ready');
});

test('tailText keeps the end of long text from a word boundary', () => {
  const text = `${'word '.repeat(60)}the final thought`;
  const tail = tailText(text, 40);
  assert.ok(tail.startsWith('…'));
  assert.ok(tail.endsWith('the final thought'));
  assert.ok(tail.length <= 41);
});
