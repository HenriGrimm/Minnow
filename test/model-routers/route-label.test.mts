import '../tools/install-dom-before-imports.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRouterRouteLabel,
  FIRST_PICK_MS,
  renderRouterRouteLabel,
  routerDecisionLevelLabel,
} from '../../src/ui/router-route-label.ts';
import type { RouterDecision, RouterRouteState } from '../../src/models/routers.ts';

const decision: RouterDecision = {
  tier: 'frontier', effort: 'high', confidence: 0.91, reason: 'Multi-file refactor',
  judgedBy: 'Jev 1.13', source: 'evaluator', modelLabel: 'big-70b',
};
const deciding = (overrides: Partial<RouterRouteState> = {}): RouterRouteState => ({
  phase: 'deciding', judgedBy: 'Jev 1.13', first: true, candidates: ['small-4b', 'big-70b'], startedAt: 1000, ...overrides,
});
const host = (): HTMLElement => { const el = document.createElement('span'); document.body.append(el); return el; };
const text = (el: HTMLElement, part: string): string => el.querySelector(`.mn-route__${part}`)?.textContent ?? '';
const root = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.mn-route')!;

test('idle Auto pool names the pool', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse' });
  assert.equal(text(el, 'level'), 'Auto');
  assert.equal(text(el, 'model'), 'Workhorse');
  assert.match(el.title, /task evaluator/);
  clearRouterRouteLabel(el); el.remove();
});

test('first pick rolls candidates, then settles on the decision once the hold ends', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: deciding(), now: 1000, reducedMotion: false });
  assert.equal(text(el, 'level'), 'Deciding');
  assert.equal(root(el).classList.contains('is-deciding'), true);
  assert.ok(['small-4b', 'big-70b'].includes(text(el, 'model')));
  assert.match(el.title, /Jev 1.13 is choosing/);

  // Decision lands early: the pick stays on screen until the hold ends.
  const decided = deciding({ phase: 'decided', decision });
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: decided, now: 1200, reducedMotion: false });
  assert.equal(text(el, 'level'), 'Deciding');

  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: decided, now: 1000 + FIRST_PICK_MS + 1, reducedMotion: false });
  assert.equal(text(el, 'level'), 'High');
  assert.equal(text(el, 'model'), 'big-70b');
  assert.equal(root(el).classList.contains('is-deciding'), false, 'no shimmer once decided');
  assert.equal(el.querySelector('.mn-route__model')!.classList.contains('is-tick'), false);
  assert.equal(root(el).classList.contains('is-flash'), true);
  assert.equal(el.title, 'Judged by Jev 1.13 · 91% — Multi-file refactor');
  clearRouterRouteLabel(el); el.remove();
});

test('later turns shimmer on the current model without rolling', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: deciding({ first: false, decision }), now: 1000, reducedMotion: false });
  assert.equal(text(el, 'level'), 'Deciding');
  assert.equal(text(el, 'model'), 'big-70b');
  clearRouterRouteLabel(el); el.remove();
});

test('reduced motion skips the roll and the flash', () => {
  const el = host();
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: deciding(), now: 1000, reducedMotion: true });
  assert.equal(text(el, 'model'), 'Workhorse');
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: deciding({ phase: 'decided', decision }), now: 5000, reducedMotion: true });
  assert.equal(root(el).classList.contains('is-flash'), false);
  clearRouterRouteLabel(el); el.remove();
});

test('fallback decisions explain themselves; models without reasoning show the tier', () => {
  const el = host();
  const fallback: RouterDecision = { ...decision, tier: null, effort: null, source: 'fallback', reason: 'Evaluator HTTP 503', modelLabel: 'small-4b' };
  renderRouterRouteLabel(el, { poolName: 'Workhorse', route: { ...deciding(), phase: 'decided', decision: fallback, startedAt: 0 }, now: 9000 });
  assert.equal(text(el, 'level'), 'Auto');
  assert.equal(el.title, 'Evaluator HTTP 503');
  assert.equal(routerDecisionLevelLabel({ ...decision, effort: null }), 'Frontier');
  clearRouterRouteLabel(el); el.remove();
});
