/**
 * Shared harness for Super Plan server tests: a temp Minnow home and
 * workspace, the HTTP middleware on a real port, and a scripted model that
 * plays each stage through real tool dispatch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { functionCallChunks, proseSseChunks } from '../../scripts/fake-model-server.mjs';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createProvider } from '../../server/providers/store.js';
import { openWorkspace, closeWorkspace } from '../../server/workspace/open-workspaces.js';
import {
  bootSuperPlanRuntime,
  createSuperPlanMiddleware,
  resetSuperPlanMiddlewareForTests,
  setSuperPlanEffectorFactory,
} from '../../server/super-plan/middleware.js';
import { createSuperPlanEffector } from '../../server/super-plan/effector.js';
import { runAgentStage } from '../../server/super-plan/agent-stage.js';
import { runResearchStage } from '../../server/super-plan/research.js';
import { createWorkspaceScopeMiddleware } from '../../server/runtime/workspace-scope-middleware.js';

export const FIXTURE_PROVIDER = 'sp-fixture';

/** A plan that parses as a board task graph. */
export function validPlan(title = 'Offline write queue', note = '') {
  return `---
name: offline-write-queue
overview: Queue writes while offline and replay them when the connection returns.
todos:
  - id: W1-A
    content: "Wave 1: Queue store"
    status: pending
  - id: W2-A
    content: "Wave 2: Replay on reconnect"
    status: pending
isProject: true
---

# ${title}

**Goal:** Keep every write a user makes while offline.

## Context
The sync layer drops writes made without a connection. ${note}

## Wave Breakdown

### Wave 1 — Store

#### Task W1-A: Queue store
- **Build:** Add \`QueueStore\` in \`src/sync/queue.ts\` with \`enqueue\` and \`drain\`.
- **Test:** \`npm test -- queue\` passes with a new enqueue and drain case.
- **Accept:** Writes made offline are returned by \`QueueStore.drain()\`.
- **Touches:** \`src/sync/**\`

### Wave 2 — Replay

#### Task W2-A: Replay on reconnect
- **Build:** Call \`QueueStore.drain()\` from \`src/sync/connection.ts\` when \`online\` fires.
- **Test:** \`npm test -- connection\` passes with a reconnect case.
- **Accept:** A queued write reaches the server after reconnecting.
- **Touches:** \`src/sync/connection.ts\`
- **Depends on:** W1-A

## Verification Checklist
- [ ] \`npm test\` passes
`;
}

/** A spec that passes the spec checks. */
export function validSpec(title = 'Offline write queue') {
  return `# ${title}

## Summary
Writes made while offline are queued locally and replayed in order when the connection returns.

## Goals
- No write is lost while offline.

## Non-goals
- Conflict resolution beyond last-write-wins.

## Requirements
1. R1 — queue writes while offline.
2. R2 — replay them in order on reconnect.

## Acceptance criteria
- A write made offline reaches the server after reconnecting.
`;
}

/**
 * @param {string[]} chunks
 */
export function sse(chunks) {
  return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * @param {unknown} body
 * @returns {string}
 */
export function stageOf(body) {
  const system = String(/** @type {any} */ (body)?.messages?.[0]?.content ?? '');
  if (system.includes('## Your stage: Interview')) return 'interview';
  if (system.includes('## Your stage: Plan review')) return 'review';
  if (system.includes('## Your stage: Interface polish')) return 'polish';
  if (system.includes('## Your stage: Plan')) return 'draft';
  return 'unknown';
}

/**
 * The newest message of each role, and every tool result since the last user message.
 * @param {any} body
 */
export function turnOf(body) {
  const messages = body.messages ?? [];
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  const since = messages.slice(lastUser + 1);
  const seed = lastUser >= 0 ? String(messages[lastUser].content ?? '') : '';
  return {
    messages,
    seed,
    toolResults: since.filter((m) => m.role === 'tool'),
    allToolResults: messages.filter((m) => m.role === 'tool'),
  };
}

/**
 * First backtick-quoted path in `text` after `marker`.
 * @param {string} text
 * @param {RegExp} marker
 * @returns {string}
 */
export function pathAfter(text, marker) {
  const match = marker.exec(text);
  assert.ok(match, `no path in: ${text.slice(0, 400)}`);
  return match[1];
}

/**
 * @param {any} message
 * @returns {boolean}
 */
export function isSaveResult(message) {
  return /^Saved /.test(String(message?.content ?? ''));
}

/**
 * Default scripted stage behaviour. Tests override single stages.
 * @param {{ reviews?: Array<Array<Record<string, unknown>>>, plan?: (n: number) => string, spec?: () => string, questions?: boolean }} [options]
 */
export function createScriptedModel(options = {}) {
  const calls = [];
  let reviewRound = 0;
  let drafts = 0;
  const model = async (_provider, body) => {
    const stage = stageOf(body);
    const turn = turnOf(body);
    calls.push({ stage, seed: turn.seed, tools: turn.toolResults.map((t) => String(t.content).slice(0, 200)) });
    if (stage === 'interview') {
      const allText = turn.messages.map((m) => String(m.content ?? '')).join('\n');
      const specPath = /`(documentation\/plans\/references\/[^`]+-spec\.md)`/.exec(allText)?.[1];
      const asked = turn.messages.some((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.function?.name === 'ask_question'));
      const hasAskTool = (body.tools ?? []).some((t) => t.function?.name === 'ask_question');
      if (options.questions !== false && hasAskTool && !asked) {
        return sse(functionCallChunks('ask_question', {
          title: 'Scope',
          questions: [
            { id: 'conflicts', prompt: 'How should conflicting writes resolve?', options: [{ id: 'lww', label: 'Last write wins', recommended: true }, { id: 'merge', label: 'Merge fields' }] },
            { id: 'limit', prompt: 'Cap the queue size?', options: [{ id: 'none', label: 'No cap' }, { id: 'k', label: '1000 writes (Recommended)' }] },
          ],
        }, `ask_${calls.length}`));
      }
      const savedOk = turn.toolResults.some((m) => isSaveResult(m) && !String(m.content).includes('will not pass'));
      if (!savedOk) {
        return sse(functionCallChunks('save_file', { path: specPath, content: options.spec?.() ?? validSpec() }, `save_${calls.length}`));
      }
      return sse(functionCallChunks('report_outcome', { summary: 'Spec written.', decisions: ['Last write wins'], assumptions: [] }, `report_${calls.length}`));
    }
    if (stage === 'draft') {
      const planPath = /`(documentation\/plans\/[^`/]+\.md)`/.exec(turn.seed)?.[1]
        ?? /`(documentation\/plans\/[^`/]+\.md)`/.exec(turn.messages.map((m) => String(m.content ?? '')).join('\n'))?.[1];
      // A real model might keep fixing; this one reports after one save, so
      // the stage's own checks decide.
      const saved = turn.toolResults.some((m) => isSaveResult(m));
      if (!saved) {
        drafts += 1;
        return sse(functionCallChunks('save_file', { path: planPath, content: options.plan?.(drafts) ?? validPlan('Offline write queue', `Draft ${drafts}.`) }, `save_${calls.length}`));
      }
      return sse(functionCallChunks('report_outcome', { summary: `Plan draft ${drafts}.`, addressed: [] }, `report_${calls.length}`));
    }
    if (stage === 'review') {
      const findings = options.reviews?.[reviewRound] ?? [];
      reviewRound += 1;
      return sse(functionCallChunks('report_outcome', { summary: findings.length ? 'Needs revision.' : 'Ready.', verdict: findings.length ? 'revise' : 'ready', findings }, `report_${calls.length}`));
    }
    if (stage === 'polish') {
      const planPath = /`(documentation\/plans\/[^`/]+\.md)`/.exec(turn.seed)?.[1];
      const saved = turn.toolResults.some((m) => isSaveResult(m));
      if (!saved) return sse(functionCallChunks('save_file', { path: planPath, content: validPlan('Offline write queue', 'Polished.') }, `save_${calls.length}`));
      return sse(functionCallChunks('report_outcome', { summary: 'Polished.', changes: ['states'] }, `report_${calls.length}`));
    }
    return sse(proseSseChunks('Unknown stage.'));
  };
  return { model, calls };
}

/**
 * A temp home, workspace, provider and HTTP server with the Super Plan middleware.
 * @param {{ model?: (provider: unknown, body: unknown) => Promise<Response>, research?: Record<string, any> }} [options]
 */
export async function startHarness(options = {}) {
  const previousHome = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-home-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetSuperPlanMiddlewareForTests();
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(path.join(workspace, 'src', 'sync'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'sync', 'queue.ts'), 'export const queue = [];\n');
  openWorkspace(workspace);
  await createProvider({ id: FIXTURE_PROVIDER, label: 'Fixture', baseUrl: 'http://127.0.0.1:9', apiKind: 'openai-v1' });

  const scripted = options.model ? null : createScriptedModel();
  const postChatCompletions = options.model ?? scripted.model;
  const factory = (runId) =>
    createSuperPlanEffector({
      runId,
      runStage: (input) =>
        input.role === 'research'
          ? runResearchStage({ ...input, pollMs: 5, resolveBinding: async () => ({ providerId: FIXTURE_PROVIDER, id: 'fixture' }), ...(options.research ? { store: options.research } : {}) })
          : runAgentStage({ ...input, postChatCompletions, resolveModel: async () => ({ providerId: FIXTURE_PROVIDER, id: 'fixture' }) }),
    });
  setSuperPlanEffectorFactory(factory);

  /**
   * The process dies: engines and running attempts vanish without ending,
   * then a fresh process boots and scans the journals.
   */
  const restart = async () => {
    resetSuperPlanMiddlewareForTests();
    setSuperPlanEffectorFactory(factory);
    await bootSuperPlanRuntime();
  };

  // Same composition as the app: the view's workspace scope, then the routes.
  const scope = createWorkspaceScopeMiddleware();
  const middleware = createSuperPlanMiddleware();
  const server = http.createServer((req, res) => {
    scope(req, res, () => {
      void middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/api/super-plan`;

  const api = async (method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'x-minnow-workspace': workspace, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { status: res.status, ...json };
  };

  const view = async (runId) => (await api('GET', `/${runId}/state`)).view;

  /**
   * @param {string} runId
   * @param {(view: any) => boolean} predicate
   * @param {string} what
   */
  const until = async (runId, predicate, what, timeoutMs = 8000) => {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      last = await view(runId);
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.fail(`timed out waiting for ${what}: ${JSON.stringify({ status: last?.status, current: last?.current, activity: last?.activity, halted: last?.halted, timeline: last?.timeline?.slice(-6) }, null, 1)}`);
  };

  const create = async (config = {}, prompt = 'Queue writes while offline and replay them on reconnect.') => {
    const created = await api('POST', '', { prompt, workspacePath: workspace, config });
    assert.equal(created.status, 201, JSON.stringify(created));
    return created.runId;
  };

  const stop = async () => {
    resetSuperPlanMiddlewareForTests();
    await new Promise((resolve) => server.close(resolve));
    closeWorkspace(workspace);
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };

  return { home, workspace, base, api, view, until, create, stop, restart, calls: scripted?.calls ?? [] };
}

/**
 * Answer the open question with each question's first option.
 * @param {ReturnType<typeof startHarness> extends Promise<infer T> ? T : never} h
 * @param {string} runId
 * @param {any} current
 */
export async function answerFirstOptions(h, runId, current) {
  const question = current.question;
  const answer = {
    status: 'answered',
    answers: question.questions.map((q) => ({ questionId: q.id, selectedIds: [q.options[0].id], otherText: null })),
  };
  return h.api('POST', `/${runId}/questions/${encodeURIComponent(question.questionId)}/answer`, { answer });
}
