import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { renderHarnessEvalsSettingsSection, disposeHarnessEvalsSettingsSection } from '../../src/ui/settings-harness-evals';

test('settings gates paid runs, sends chosen limits, and renders independent results safely', async t => {
  const window = new Window();
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, Option: globalThis.Option };
  Object.assign(globalThis, { window, document: window.document, Option: window.Option });
  window.document.body.innerHTML = '<div id="settingsHarnessEvalsBody"></div>';
  t.after(() => { disposeHarnessEvalsSettingsSection(); Object.assign(globalThis, previous); window.happyDOM.abort(); });
  let ready = false;
  let running = false;
  const requests: Array<{ url: string; body: any }> = [];
  const summary = { build: { passed: 1, trials: 3, errors: 1, ungraded: 1, total_cost_usd: null } };
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url) === '/api/providers') return Response.json({ activeProviderId: 'local', providers: [
      { id: 'local', label: 'Local', apiKind: 'openai-v1', enabled: true },
      { id: 'other', label: 'Unsupported', apiKind: 'anthropic-v1', enabled: true },
    ] });
    if (String(url).endsWith('/status')) return Response.json({ available: true, installed: true, runtime: ready, datasets: true,
      checks: { uv: true, git: true, node: true, docker: ready }, active: running ? {
        id: 'gui-running', action: 'run', status: 'running', startedAt: new Date(Date.now() - 65_000).toISOString(), expectedTrials: 20,
        config: { model: 'local-model' }, progress: { currentProfile: 'build', completed: 7, total: 20, errors: 1, running: 1, pending: 12,
          profiles: [{ profile: 'build', status: 'running', completed: 7, total: 10, errors: 1, running: 1, pending: 2 },
            { profile: 'minimal', status: 'pending', completed: 0, total: 10, errors: 0, running: 0, pending: 10 }] },
      } : null, history: [{
        id: 'gui-fixture', action: 'run', status: 'completed', startedAt: new Date().toISOString(), expectedTrials: 20,
        config: { model: '<img src=x onerror=alert(1)>' }, summary,
      }] });
    if (String(url).endsWith('/run')) { running = true; return Response.json({ id: 'gui-running' }); }
    return Response.json({});
  }) as typeof fetch;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await renderHarnessEvalsSettingsSection(); await flush(); await flush();
  const button = (text: string) => [...window.document.querySelectorAll('button')].find(b => b.textContent === text)!;
  assert.equal(button('Start comparison').disabled, true);
  assert.equal(window.document.querySelectorAll('img').length, 0);
  assert.match(window.document.body.textContent, /1\/3/);
  assert.match(window.document.body.textContent, /Not reported/);
  assert.equal(window.document.querySelector('select')!.options.length, 1);
  ready = true; button('Check setup').click(); await flush(); await flush();
  assert.equal(button('Start comparison').disabled, false);
  const form = window.document.querySelector('form')!;
  const model = form.querySelector('input')!; model.value = 'local-model';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(); await flush();
  const run = requests.find(r => r.url.endsWith('/run'))!;
  assert.equal(run.body.model, 'local-model'); assert.equal(run.body.providerId, 'local');
  assert.equal(run.body.context_window, 32768); assert.equal(run.body.attempts, 1);
  assert.equal(run.body.preset, 'smoke');
  assert.match(window.document.body.textContent, /7 of 20 attempts finished/);
  assert.match(window.document.body.textContent, /7\/10 · Running/);
  assert.equal(window.document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '7');
});
