import { randomUUID } from 'node:crypto';
import { listApps, readApp, updateApp, TERMINAL, serialize, boundedText, appRoot, safePath } from './store.js';
import { recordEvent } from './events.js';
import { buildApp } from './pipeline.js';
import { runAgent } from './agent.js';
import { stopAllApps } from './runtime.js';
import { createRunActivity } from './activity.js';

export const RUN_TIMEOUT_MS = 45 * 60000;
export class ReefSupervisor {
  constructor({ build = buildApp, timeout = RUN_TIMEOUT_MS } = {}) {
    this.build = build; this.timeout = timeout; this.active = null; this.stopped = true; this.baseUrl = '';
  }
  async start(baseUrl) {
    this.baseUrl = baseUrl; this.stopped = false;
    for (const app of await listApps()) {
      await updateApp(app.id, current => {
        for (const run of current.runs) {
          if (!TERMINAL.has(run.state) && run.state !== 'queued') {
            run.failedStage = run.state;
            run.state = 'interrupted'; run.error = 'Minnow stopped before this build finished.';
            run.completedAt = Date.now(); current.status = 'interrupted';
          }
        }
        for (const item of current.exports) if (['queued', 'building'].includes(item.status)) item.status = 'interrupted';
      });
    }
    this.wake();
  }
  stop() {
    this.stopped = true;
    this.active?.controller.abort(Object.assign(new Error('Minnow stopped'), { interrupted: true }));
    stopAllApps();
  }
  async enqueue(id, prompt, chatController) {
    return serialize('reef-admission', async () => {
      if (chatRuns.has(id) && chatRuns.get(id) !== chatController) throw Object.assign(new Error('Wait for the current reply before starting a build'), { statusCode: 409 });
      const app = await readApp(id);
      if (app.runs.some(run => !TERMINAL.has(run.state))) throw Object.assign(new Error('This app already has a build in progress'), { statusCode: 409 });
      return this.createRun(id, prompt);
    });
  }
  async createRun(id, prompt) {
    const run = { id: randomUUID(), prompt: boundedText(prompt, 'Prompt'), state: 'queued', progress: 0, createdAt: Date.now(), log: '', attempt: 0, chatIds: [] };
    await updateApp(id, current => { current.runs.push(run); current.status = 'queued'; });
    await recordEvent(id, { type: 'stage', runId: run.id, state: 'queued', progress: 0 });
    this.wake(); return run;
  }
  async cancel(id, runId) {
    return serialize('reef-admission', async () => {
      const app = await readApp(id);
      const run = app.runs.find(item => item.id === runId);
      if (!run) throw new Error('Unknown build');
      if (TERMINAL.has(run.state)) return;
      if (this.active?.runId === runId) this.active.controller.abort(new Error('Build cancelled'));
      else await this.setStage(id, runId, 'cancelled', run.progress);
    });
  }
  async recover(id, runId, action = 'resume') {
    if (!['resume', 'reset-phase', 'reset-build'].includes(action)) throw new Error('Unknown build recovery action');
    return serialize('reef-admission', async () => {
      if (chatRuns.has(id)) throw Object.assign(new Error('Wait for the current reply before recovering a build'), { statusCode: 409 });
      const app = await readApp(id);
      const run = app.runs.at(-1);
      if (!run || run.id !== runId || !['failed', 'cancelled', 'interrupted'].includes(run.state) || this.active?.appId === id) {
        throw Object.assign(new Error('Only the latest stopped build can be recovered'), { statusCode: 409 });
      }
      if (action === 'reset-build') return this.createRun(id, run.prompt);
      const updated = await updateApp(id, current => {
        const run = current.runs.at(-1);
        run.recovery = action;
        run.state = 'queued'; run.queuedAt = Date.now();
        delete run.error; delete run.completedAt; delete run.startedAt;
        if (action === 'reset-phase') run.progress = 0;
        current.status = 'queued';
      });
      await recordEvent(id, { type: 'stage', runId, state: 'queued', progress: updated.runs.at(-1).progress });
      this.wake(); return updated.runs.at(-1);
    });
  }
  async setStage(id, runId, state, progress, attempt, error) {
    await updateApp(id, app => {
      const run = app.runs.find(item => item.id === runId);
      if (!run) throw new Error('Unknown build');
      if (['failed', 'interrupted', 'cancelled'].includes(state) && run.state !== 'queued' && !TERMINAL.has(run.state)) run.failedStage = run.state;
      run.state = state; run.progress = Math.max(run.progress, progress);
      if (!run.startedAt && state !== 'queued' && !TERMINAL.has(state)) run.startedAt = Date.now();
      run.lastActivityAt = Date.now();
      if (attempt !== undefined) run.attempt = attempt;
      if (error) run.error = error;
      if (TERMINAL.has(state)) run.completedAt = Date.now();
      app.status = state;
    });
    await recordEvent(id, { type: 'stage', runId, state, progress, error });
  }
  wake() {
    if (this.stopped) return;
    if (this.pumping) { this.wakeRequested = true; return; }
    this.pumping = true;
    void this.drain().catch(error => console.error('[reef]', error)).finally(() => {
      this.pumping = false;
      if (this.wakeRequested) { this.wakeRequested = false; this.wake(); }
    });
  }
  async drain() {
    while (!this.stopped) {
      const candidates = (await listApps()).flatMap(app => app.runs.filter(run => run.state === 'queued').map(run => ({ app, run })));
      candidates.sort((a, b) => (a.run.queuedAt ?? a.run.createdAt) - (b.run.queuedAt ?? b.run.createdAt));
      const next = candidates[0];
      if (!next) return;
      const { app, run } = next;
      const controller = new AbortController();
      const admitted = await serialize('reef-admission', async () => {
        const latest = await readApp(app.id);
        if (this.stopped || latest.runs.find(x => x.id === run.id)?.state !== 'queued') return false;
        this.active = { appId: app.id, runId: run.id, controller };
        await this.setStage(app.id, run.id, run.recovery ? run.failedStage ?? 'scaffolding' : 'scaffolding', run.progress);
        return true;
      });
      if (!admitted) continue;
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('Build exceeded the 45-minute deadline'), { timeout: true })), this.timeout);
      const activity = createRunActivity(app.id, run.id);
      try {
        controller.signal.throwIfAborted();
        const release = await this.build({ app, run, baseUrl: this.baseUrl, signal: controller.signal, log: activity.log, stream: activity.stream, event: activity.event,
          stage: (state, progress, attempt) => this.setStage(app.id, run.id, state, progress, attempt) });
        controller.signal.throwIfAborted();
        await activity.flush();
        controller.signal.throwIfAborted();
        await updateApp(app.id, current => { current.release = release; });
        await this.setStage(app.id, run.id, 'ready', 100);
      } catch (error) {
        await activity.flush().catch(error => console.warn('[reef] activity persistence failed', error));
        const reason = controller.signal.reason;
        const state = reason?.interrupted ? 'interrupted' : controller.signal.aborted && !reason?.timeout ? 'cancelled' : 'failed';
        await this.setStage(app.id, run.id, state, 0, undefined, String(reason?.message ?? error.message));
      } finally {
        clearTimeout(timer); this.active = null;
      }
    }
  }
}

export const reefSupervisor = new ReefSupervisor();
const chatRuns = new Map();
export const appHasChat = id => chatRuns.has(id);
export async function chatAboutApp(id, prompt) {
  if (chatRuns.has(id)) throw Object.assign(new Error('A reply is already in progress'), { statusCode: 409 });
  const controller = new AbortController();
  chatRuns.set(id, controller);
  const timer = setTimeout(() => controller.abort(new Error('Chat timed out')), 10 * 60000);
  try {
    const app = await readApp(id);
    if (app.runs.some(run => !TERMINAL.has(run.state))) throw Object.assign(new Error('Wait for the current build or cancel it before chatting'), { statusCode: 409 });
    const message = boundedText(prompt, 'Message');
    await updateApp(id, current => { current.messages.push({ role: 'user', content: message }); });
    const workspace = await safePath(appRoot(id), 'repo');
    const reply = await runAgent({ app, runId: null, workspace, phase: 'chat', baseUrl: reefSupervisor.baseUrl, signal: controller.signal,
      prompt: `Discuss this Reef utility. Read source if useful. Return JSON only: {"action":"reply"|"build","reply":"your response","request":"self-contained requested change"}. Use build only for an explicit request to change or fix the app, not a question. Do not edit files.\nApp: ${app.description}\nConversation: ${JSON.stringify(app.messages.slice(-20))}\nUser: ${message}` });
    let result;
    try { result = JSON.parse(reply.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch { result = { action: 'reply', reply: reply.text }; }
    const text = typeof result.reply === 'string' ? result.reply : reply.text;
    await updateApp(id, current => { current.messages.push({ role: 'assistant', content: text }); });
    if (result.action === 'build') await reefSupervisor.enqueue(id, boundedText(result.request, 'Revision request'), controller);
    await recordEvent(id, { type: 'chat' });
    return { reply: text };
  } finally { clearTimeout(timer); chatRuns.delete(id); }
}
export function stopReefForHost() {
  reefSupervisor.stop();
  for (const controller of chatRuns.values()) controller.abort(new Error('Minnow stopped'));
}
export const startReefForHost = baseUrl => reefSupervisor.start(baseUrl);
