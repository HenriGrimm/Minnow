/** Restarts, the boot scan and HTTP validation for the Super Plan engine. */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { answerFirstOptions, createScriptedModel, startHarness } from '../helpers/super-plan-harness.mjs';
import { guardStageTools } from '../../server/super-plan/agent-stage.js';
import { readEvents } from '../../server/super-plan/journal.js';

test('a restart during an open question resumes the interview, which waits for the answer', async () => {
  const h = await startHarness();
  try {
    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 0 });
    const asked = await h.until(runId, (v) => v.needsInput === 'question', 'the question');
    await h.restart();
    let current = await h.until(runId, (v) => v.timeline.some((row) => row.label === 'Interview resumed'), 'the resumed interview');
    assert.equal(current.question?.questionId, asked.question.questionId, 'the question is still open after the restart');
    assert.equal(current.halted, null);
    await answerFirstOptions(h, runId, current);
    current = await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    const events = await readEvents(runId);
    assert.ok(events.some((e) => e.type === 'stage.ended' && e.outcome === 'interrupted'), 'the lost attempt was journaled as interrupted');
    const interview = await h.api('GET', `/${runId}/transcripts/interview-1`);
    assert.equal(interview.messages.filter((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function.name === 'ask_question')).length, 1);
  } finally {
    await h.stop();
  }
});

test('a paused run stays paused across a restart; a halted one stays halted', async () => {
  const h = await startHarness();
  try {
    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 0 });
    await h.until(runId, (v) => v.needsInput === 'question', 'the question');
    await h.api('POST', `/${runId}/pause`);
    await h.restart();
    const current = await h.view(runId);
    assert.equal(current.status, 'paused');
    assert.equal(current.actions.resume, true);
  } finally {
    await h.stop();
  }
});

test('routes validate their input and explain conflicts', async () => {
  const h = await startHarness({ model: createScriptedModel().model });
  try {
    const noWorkspace = await h.api('POST', '', { prompt: 'x' });
    assert.equal(noWorkspace.status, 400);
    assert.match(noWorkspace.error, /workspace/);
    const noPrompt = await h.api('POST', '', { prompt: ' ', workspacePath: h.workspace });
    assert.equal(noPrompt.status, 400);

    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 0 });
    await h.until(runId, (v) => v.needsInput === 'question', 'the question');
    assert.equal((await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' })).status, 409);
    assert.equal((await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'maybe' })).status, 400);
    assert.equal((await h.api('POST', `/${runId}/skip`, { stage: 'interview' })).status, 400);
    assert.equal((await h.api('POST', `/${runId}/skip`, { stage: 'review' })).status, 409);
    assert.equal((await h.api('POST', `/${runId}/rework`, { stage: 'draft' })).status, 409);
    const current = await h.view(runId);
    const bad = await h.api('POST', `/${runId}/questions/${current.question.questionId}/answer`, { answer: { answers: [] } });
    assert.equal(bad.status, 400);
    assert.match(bad.error, /Answer question/);
    assert.equal((await h.api('POST', `/${runId}/questions/nope/answer`, { answer: {} })).status, 404);
    assert.equal((await h.api('GET', '/no-such-run/state')).status, 404);
    assert.equal((await h.api('GET', '/..%2Fescape/state')).status, 400);

    const renamed = await h.api('POST', `/${runId}/rename`, { title: 'Offline queue' });
    assert.equal(renamed.view.title, 'Offline queue');
    const list = await h.api('GET', '/runs?active=1');
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0].needsInput, 'question');

    const deleted = await h.api('DELETE', `/${runId}`);
    assert.equal(deleted.ok, true);
    assert.equal((await h.api('GET', `/${runId}/state`)).status, 404);
  } finally {
    await h.stop();
  }
});

test('the events stream sends the view on connect and on every change', async () => {
  const h = await startHarness();
  try {
    const runId = await h.create({ research: false, polish: 'never', reviewRounds: 0 });
    const controller = new AbortController();
    const res = await fetch(`${h.base}/${runId}/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const started = Date.now();
    while (Date.now() - started < 5000 && !/"needsInput":"question"/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    assert.match(text, /event: view/);
    assert.match(text, /"needsInput":"question"/, 'the question arrives as a view push');
  } finally {
    await h.stop();
  }
});

test('a stream opened on an accepted run follows it when the plan is reopened', async () => {
  const h = await startHarness();
  try {
    const runId = await h.create({ interview: false, research: false, polish: 'never', reviewRounds: 0 });
    await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'spec', verdict: 'confirm' });
    await h.until(runId, (v) => v.needsInput === 'accept', 'the plan');
    await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'accept' });
    // A fresh process: the finished run has no engine when the page opens it.
    await h.restart();

    const controller = new AbortController();
    const res = await fetch(`${h.base}/${runId}/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (pattern, what) => {
      const started = Date.now();
      while (Date.now() - started < 8000 && !pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      assert.match(text, pattern, what);
    };
    await readUntil(/"status":"done"/, 'the accepted view on connect');
    text = '';
    const reopened = await h.api('POST', `/${runId}/checkpoint`, { checkpoint: 'accept', verdict: 'revise', feedback: 'Split the replay task.' });
    assert.equal(reopened.view.status, 'running');
    await readUntil(/"needsInput":"accept"/, 'the revised plan arrives on the stream that was already open');
    controller.abort();
  } finally {
    await h.stop();
  }
});

test('the library lists and deletes plan documents without any model tool', async () => {
  const h = await startHarness();
  try {
    const plans = path.join(h.workspace, 'documentation', 'plans');
    await fs.mkdir(path.join(plans, 'references'), { recursive: true });
    await fs.writeFile(path.join(plans, 'older.md'), '# Older\n');
    await fs.writeFile(path.join(plans, 'references', 'older-spec.md'), '# Spec\n');
    await fs.writeFile(path.join(plans, 'notes.txt'), 'not a plan');

    const listed = await h.api('GET', '/plans');
    assert.equal(listed.status, 200, JSON.stringify(listed));
    assert.deepEqual(listed.plans.map((p) => p.path), ['documentation/plans/older.md'], 'top-level markdown only');

    for (const bad of ['src/index.ts', 'documentation/plans/../../package.json', 'documentation/plans/notes.txt']) {
      const refused = await h.api('DELETE', '/plans', { path: bad });
      assert.equal(refused.status, 400, `${bad} must be refused`);
    }
    const deleted = await h.api('DELETE', '/plans', { path: 'documentation/plans/references/older-spec.md' });
    assert.equal(deleted.status, 200);
    await assert.rejects(fs.stat(path.join(plans, 'references', 'older-spec.md')));
    assert.ok(await fs.stat(path.join(plans, 'older.md')), 'only the named file goes');
  } finally {
    await h.stop();
  }
});

test('a stage may only write its own artifact, without implementation code', async () => {
  const calls = [];
  const execute = async (name, args) => {
    calls.push([name, args.path]);
    return { content: `Saved ${args.path} (10 bytes)` };
  };
  const draft = guardStageTools({ role: 'draft', artifactPath: 'documentation/plans/q.md', execute });
  assert.match((await draft('save_file', { path: 'src/app.ts', content: 'x' })).content, /saves exactly/);
  assert.match((await draft('save_file', { path: 'documentation/plans/q.md', content: '```ts\nconst a = 1;\n```' })).content, /not saved/);
  const warned = await draft('save_file', { path: './documentation/plans/Q.md', content: '# Q\n\n## A\nshort' });
  assert.match(warned.content, /will not pass/);
  assert.deepEqual(calls.at(-1), ['save_file', 'documentation/plans/q.md'], 'the path is normalised to the artifact');
  assert.match((await draft('make_directory', { path: 'src' })).content, /only writes/);
  assert.equal((await draft('make_directory', { path: 'documentation/plans' })).content.startsWith('Saved'), true);
  const review = guardStageTools({ role: 'review', artifactPath: 'documentation/plans/q.md', execute });
  assert.match((await review('save_file', { path: 'documentation/plans/q.md', content: '# Q' })).content, /read-only/);
  assert.equal((await review('read_file', { path: 'src/app.ts' })).content.startsWith('Saved'), true, 'reads pass through');
});

test('the interview saves under the interim name and the spec moves to its title slug', async () => {
  const h = await startHarness();
  try {
    await fs.mkdir(path.join(h.workspace, 'documentation/plans'), { recursive: true });
    await fs.writeFile(path.join(h.workspace, 'documentation/plans/offline-write-queue.md'), '# Someone else\n');
    const runId = await h.create({ interview: false, research: false, polish: 'never', reviewRounds: 0 });
    const current = await h.until(runId, (v) => v.needsInput === 'spec', 'the spec');
    const suffix = runId.split('-').pop();
    assert.equal(current.slug, `offline-write-queue-${suffix}`, 'a taken slug gets the run suffix');
  } finally {
    await h.stop();
  }
});
