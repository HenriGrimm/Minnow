import { ASK_QUESTION_TIMEOUT_ERROR, DEFAULT_ASK_TIMEOUT_MS } from '../runner/ask-question-tool.js';
import { confirmSpecIdentity } from './artifacts.js';
import { makeEvent } from './events.js';
import { emitLive } from './live-events.js';

const waiting = new Map();
const keyFor = (runId, gateId) => `${runId}/${gateId}`;

/** Persist before delivery; replay, rather than the live channel, owns the question. */
export function createJournaledAsk({ engine, runId, attemptId, deliver = emitLive }) {
  let index = engine.getState().gateHistory.filter((gate) => gate.attemptId === attemptId).length;
  return async function ask(input, options = {}) {
    const gateId = `${attemptId}:${++index}`;
    const kind = input.kind ?? 'question';
    const signal = options.signal ?? input.signal;
    const timeoutMs = options.timeoutMs ?? input.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    let settle;
    const answer = new Promise((resolve) => { settle = resolve; });
    const key = keyFor(runId, gateId);
    waiting.set(key, settle);
    let timer;
    const expire = async () => {
      if (!waiting.delete(key)) return;
      try {
        await engine.append([makeEvent('gate.expired', { gateId, attemptId, kind })]);
      } catch (error) { console.warn('[super-plan] could not expire question:', error); } finally { settle(ASK_QUESTION_TIMEOUT_ERROR); }
    };
    try {
      await engine.append([makeEvent('gate.opened', {
        gateId, attemptId, kind, question: String(input.question ?? input.prompt ?? input.questions?.map((q) => `${q.prompt}\n${q.options?.map((o) => `${o.label}: ${o.description ?? ''}`).join('\n') ?? ''}`).join('\n\n') ?? ''),
        choices: Array.isArray(input.choices) ? input.choices.map(String) : [],
        ...(Array.isArray(input.questions) ? { questions: input.questions } : {}),
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
      })]);
      options.onOpened?.(gateId);
      deliver({ runId, stage: kind, event: { type: 'gate', gateId, attemptId, kind, question: input.question, choices: input.choices } });
      timer = setTimeout(() => { void expire(); }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', expire, { once: true });
      if (signal?.aborted) void expire();
      return await answer;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', expire);
      waiting.delete(key);
    }
  };
}

/** Answers to dead attempts remain facts, but cannot settle a new question. */
export async function answerJournaledGate({ engine, runId, gateId, answer, errors = [] }) {
  const state = engine.getState();
  const gate = state.gate?.gateId === gateId ? state.gate : null;
  if (!gate && state.gateHistory.some((g) => g.gateId === gateId)) return { ok: false, status: 409, error: 'This question is no longer active.' };
  if (!gate) return { ok: false, status: 404, error: 'no such gate' };
  const allowed = { spec: ['confirm', 'revise'], accept: ['accept', 'reject'] };
  if (allowed[gate.kind] && !allowed[gate.kind].includes(answer)) return { ok: false, status: 400, error: 'invalid gate answer' };
  const identity = gate.kind === 'spec' && answer === 'confirm' && state.gate?.gateId === gateId ? await confirmSpecIdentity(state) : [];
  await engine.append([...identity, makeEvent('gate.answered', {
    gateId, attemptId: gate.attemptId, kind: gate.kind, verdict: answer, errors,
  })]);
  const key = keyFor(runId, gateId);
  const settle = waiting.get(key);
  waiting.delete(key);
  settle?.(answer);
  return { ok: true, status: 200 };
}
