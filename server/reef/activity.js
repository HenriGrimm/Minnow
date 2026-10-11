import { updateApp } from './store.js';
import { recordEvent } from './events.js';
import { applyAgentEvent } from './agent-stream.js';

/** Coalesce fast token chunks before persisting and notifying the renderer. */
export function createRunActivity(appId, runId) {
  let logText = '', agentText = '', at = 0, timer;
  let pending = Promise.resolve();
  let events = [];
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!logText && !agentText && !events.length) return pending;
    const log = logText, agentLog = agentText, time = at;
    logText = ''; agentText = '';
    const batch = events; events = [];
    pending = pending.then(async () => {
      await updateApp(appId, app => {
        const run = app.runs.find(item => item.id === runId);
        run.log = ((run.log ?? '') + log).slice(-64000);
        run.agentLog = ((run.agentLog ?? '') + agentLog).slice(-64000);
        run.lastActivityAt = Math.max(run.lastActivityAt ?? 0, time);
        for (const event of batch) applyAgentEvent(run, event);
      });
      await recordEvent(appId, { type: 'activity', runId, time });
    });
    return pending;
  }
  function append(text, agent) {
    if (!text) return;
    if (agent) agentText = (agentText + text).slice(-64000);
    else logText = (logText + text).slice(-64000);
    at = Date.now();
    timer ??= setTimeout(() => { void flush().catch(error => console.warn('[reef] activity persistence failed', error)); }, 200);
  }
  function event(value) {
    // Cumulative text can be coalesced without dropping tool/round boundaries.
    const previous = events.at(-1);
    if (previous?.type === value.type && previous.chatId === value.chatId && ['delta', 'thinking', 'context_usage'].includes(value.type)) events[events.length - 1] = value;
    else events.push(value);
    at = Date.now();
    timer ??= setTimeout(() => { void flush().catch(error => console.warn('[reef] activity persistence failed', error)); }, 200);
  }
  return { log: text => append(text, false), stream: text => append(text, true), event, flush };
}
