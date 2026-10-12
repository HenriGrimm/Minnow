import '../tools/install-dom-before-imports.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearRouterRouteLabel, renderRouterRouteLabel, routerDecisionLevelLabel } from '../../src/ui/router-route-label.ts';
import { syncRouterReevaluateAction } from '../../src/ui/router-reevaluate-action.ts';
import { noteRouterDecision, routerRouteState, loadRouterConfig } from '../../src/models/routers.ts';
import type { RouterDecision, RouterRouteState } from '../../src/models/routers.ts';

const decision: RouterDecision = {
  tier: 'frontier', effort: 'high', requestedEffort: 'high', reasoningStatus: 'applied', confidence: 0.91,
  reason: 'Multi-file refactor', judgedBy: 'Jev 1.13', source: 'evaluator', modelLabel: 'big-70b',
};
const route = (overrides: Partial<RouterRouteState> = {}): RouterRouteState => ({
  phase: 'deciding', judgedBy: 'Jev 1.13', first: true, candidates: ['small-4b', 'big-70b'], startedAt: 1000, ...overrides,
});
const host = (): HTMLElement => { const el = document.createElement('span'); document.body.append(el); return el; };
const text = (el: HTMLElement, part: string): string => el.querySelector(`.mn-route__${part}`)?.textContent ?? '';

test('idle Auto pool names the pool and explains chat-scoped evaluation', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse' });
  assert.equal(text(el, 'level'), 'Auto');
  assert.equal(text(el, 'model'), 'Workhorse');
  assert.match(el.title, /once for this chat/);
  el.remove();
});

test('the real evaluator phase ends immediately with the model and reasoning visible', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route() });
  assert.equal(text(el, 'level'), 'Evaluating');
  assert.equal(text(el, 'model'), 'Workhorse', 'candidate names never roll');
  assert.ok(el.querySelector('.is-deciding'));
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ phase: 'decided', decision }) });
  assert.equal(text(el, 'level'), 'High reasoning');
  assert.equal(text(el, 'model'), 'big-70b');
  assert.equal(el.querySelector('.is-deciding'), null);
  assert.equal(el.querySelector('.mn-route')!.getAttribute('aria-busy'), 'false');
  assert.match(el.title, /Judged by Jev 1.13 \(91%\)/);
  assert.match(el.title, /Frontier tier/);
  el.remove();
});

test('re-evaluation retains the current reasoning and model until the new decision arrives', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ first: false, decision }) });
  assert.equal(text(el, 'level'), 'High reasoning');
  assert.equal(text(el, 'model'), 'big-70b');
  clearRouterRouteLabel(el);
  assert.equal(el.querySelector('.is-deciding'), null);
  el.remove();
});

test('composer refreshes preserve the constellation and text nodes during evaluation', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route(), scopeKey: 'chat-a' });
  const spark = el.querySelector('.mn-route__spark svg');
  const label = el.querySelector('.mn-route__level')!.firstChild;
  for (let i = 0; i < 5; i += 1) {
    renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route(), scopeKey: 'chat-a' });
  }
  assert.equal(el.querySelector('.mn-route__spark svg'), spark);
  assert.equal(el.querySelector('.mn-route__level')!.firstChild, label);
  assert.equal(el.querySelector('.mn-route__spark')!.getAttribute('aria-hidden'), 'true');
  clearRouterRouteLabel(el);
  assert.equal(el.querySelector('.mn-route')!.getAttribute('aria-busy'), 'false');
  el.remove();
});

test('completion settles once, cancels on a new evaluation, and never celebrates switching chats', () => {
  const el = host();
  const animations: { frames: Keyframe[]; cancelled: boolean; onfinish?: () => void; oncancel?: () => void }[] = [];
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route(), scopeKey: 'chat-a' });
  for (const element of el.querySelectorAll('.mn-route__spark svg > *, .mn-route__level, .mn-route__model')) {
    Object.defineProperty(element, 'animate', { value: (frames: Keyframe[]) => {
      const animation = { frames, cancelled: false, cancel() { this.cancelled = true; this.oncancel?.(); },
        onfinish: undefined as (() => void) | undefined, oncancel: undefined as (() => void) | undefined };
      animations.push(animation);
      return animation;
    } });
  }
  const completed = { poolName: 'Workhorse', route: route({ phase: 'decided', decision }), scopeKey: 'chat-a' };
  renderRouterRouteLabel(el, completed);
  assert.ok(animations.length > 0);
  assert.equal(text(el, 'model'), 'big-70b', 'decision is visible immediately');
  const count = animations.length;
  renderRouterRouteLabel(el, completed);
  assert.equal(animations.length, count, 'refreshing a finished decision does not replay it');
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ startedAt: 2000 }), scopeKey: 'chat-a' });
  assert.ok(animations.every((animation) => animation.cancelled));
  renderRouterRouteLabel(el, { ...completed, route: route({ phase: 'decided', decision, startedAt: 2000 }), scopeKey: 'chat-b' });
  assert.equal(animations.length, count, 'another chat cannot finish the previous chat animation');
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route(), scopeKey: 'chat-b' });
  renderRouterRouteLabel(el, { ...completed, scopeKey: 'chat-b' });
  clearRouterRouteLabel(el);
  assert.ok(animations.every((animation) => animation.cancelled));
  el.remove();
});

test('reduced motion shows the result immediately without a settling animation', () => {
  const el = host();
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = (() => ({ matches: true })) as typeof window.matchMedia;
  try {
    renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route() });
    for (const element of el.querySelectorAll('.mn-route__spark svg > *, .mn-route__level, .mn-route__model')) {
      Object.defineProperty(element, 'animate', { value: () => { assert.fail('reduced motion must not animate'); } });
    }
    renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ phase: 'decided', decision }) });
    assert.equal(text(el, 'level'), 'High reasoning');
    assert.equal(el.querySelector('.is-deciding'), null);
  } finally { window.matchMedia = originalMatchMedia; el.remove(); }
});

test('unadvertised reasoning levels show the requested level, never masquerading as a tier', () => {
  const el = host();
  const unknown: RouterDecision = { ...decision, effort: null, reasoningStatus: 'default' };
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ phase: 'decided', decision: unknown }) });
  assert.equal(text(el, 'level'), 'High requested');
  assert.match(el.title, /using its default/);
  assert.equal(routerDecisionLevelLabel({ ...unknown, reasoningStatus: 'unsupported' }), 'No reasoning');
  assert.equal(routerDecisionLevelLabel({ ...unknown, requestedEffort: null }), 'Model default');
  el.remove();
});

test('fallback and queued re-evaluation explain their state', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ phase: 'decided', reevaluate: true,
    decision: { ...decision, source: 'fallback', reason: 'Evaluator HTTP 503. Kept the last choice.' } }) });
  assert.equal(text(el, 'level'), 'High reasoning');
  assert.match(el.title, /Task evaluator unavailable/);
  assert.match(el.title, /Evaluator HTTP 503/);
  assert.match(el.title, /Re-evaluates on your next message/);
  el.remove();
});

test('an initial evaluator failure displays Fallback beside the selected model', () => {
  const el = host();
  const fallback: RouterDecision = { ...decision, tier: null, effort: null, requestedEffort: null,
    reasoningStatus: 'default', source: 'fallback', reason: 'Evaluator HTTP 503', modelLabel: 'small-4b' };
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: route({ phase: 'decided', decision: fallback }) });
  assert.equal(text(el, 'level'), 'Fallback');
  assert.equal(text(el, 'model'), 'small-4b');
  assert.match(el.title, /Task evaluator unavailable/);
  assert.match(el.title, /Evaluator HTTP 503/);
  assert.match(el.title, /Kept for this chat/);
  el.remove();
});

test('Re-evaluate action uses the intended chat and pool, preserves the choice, and handles errors', async () => {
  const el = host();
  const originalFetch = globalThis.fetch;
  let request;
  noteRouterDecision('action-chat', 'auto', decision);
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options!.body as string), method: options!.method };
    return new Response(JSON.stringify({ decisions: [{ chatId: 'action-chat', routerId: 'auto', reevaluate: true }] }));
  };
  try {
    syncRouterReevaluateAction(el, { chatId: 'action-chat', routerId: 'auto', route: route({ phase: 'decided', decision }), busy: true });
    assert.equal(el.querySelector('button')!.disabled, true);
    syncRouterReevaluateAction(el, { chatId: 'action-chat', routerId: 'auto', route: route({ phase: 'decided', decision }), busy: false });
    const button = el.querySelector('button')!;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(request, { url: '/api/generations/routers/auto/reevaluate', body: { chatId: 'action-chat' }, method: 'POST' });
    assert.equal(button.textContent, 'Re-evaluation queued');
    assert.equal(button.disabled, true);
    assert.equal(routerRouteState('action-chat', 'auto')!.decision!.effort, 'high');
    assert.equal(routerRouteState('action-chat', 'auto')!.reevaluate, true);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Pool is pinned' }), { status: 400 });
    syncRouterReevaluateAction(el, { chatId: 'action-chat', routerId: 'auto', route: route({ phase: 'decided', decision }), busy: false });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(el.querySelector('[role=status]')!.textContent!, /Pool is pinned/);
    assert.equal(button.disabled, false);
    syncRouterReevaluateAction(el);
    assert.equal(el.querySelector<HTMLElement>('.router-reevaluate-action')!.hidden, true);
  } finally { globalThis.fetch = originalFetch; el.remove(); }
});

test('loading router config restores the composer reasoning and queued action without animation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ routers: [], revision: 0, defaultRouterId: null,
    decisions: [{ chatId: 'restored', routerId: 'auto', display: decision, reevaluate: true }] }));
  const el = host();
  try {
    await loadRouterConfig();
    const restored = routerRouteState('restored', 'auto');
    assert.equal(restored?.reevaluate, true);
    renderRouterRouteLabel(el, { poolName: 'Workhorse', route: restored });
    assert.equal(text(el, 'level'), 'High reasoning');
    assert.equal(el.querySelector('.is-deciding'), null);
  } finally { globalThis.fetch = originalFetch; el.remove(); }
});

test('a persisted pinned override does not display the previous evaluator choice after reload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ revision: 0, defaultRouterId: null,
    routers: [{ id: 'auto', entries: [{ id: 'pinned', modelId: 'small-4b' }] }],
    assignments: [{ chatId: 'pinned-chat', routerId: 'auto', assignmentMode: 'override', assignedEntryId: 'pinned' }],
    decisions: [{ chatId: 'pinned-chat', routerId: 'auto', display: decision, reevaluate: true }] }));
  try {
    await loadRouterConfig();
    const restored = routerRouteState('pinned-chat', 'auto')!;
    assert.equal(restored.decision!.modelLabel, 'small-4b');
    assert.equal(restored.decision!.source, 'override');
    assert.equal(restored.reevaluate, false);
  } finally { globalThis.fetch = originalFetch; }
});
