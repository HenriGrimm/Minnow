import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import type { ContextBudget } from '../../src/chat/context-usage.ts';
import { closeContextUsageBreakdown, syncContextUsageBreakdownIfOpen, toggleContextUsageBreakdown } from '../../src/ui/context-usage-breakdown.ts';

const surface = { ringId: 'contextUsageRing', breakdownId: 'contextUsageBreakdown' };
const budget: ContextBudget = {
  modelId: 'model', modelDisplayName: '<Model & name>', used: 38761, limit: 1000000,
  remaining: 961239, percent: 4, compressAtTokens: 800000, willCompress: false, isEstimate: false,
  lastTurnPromptTokens: 38309, lastTurnCompletionTokens: 452, lastTurnTotalTokens: 38761,
  sessionUsage: { promptTokens: 586578, completionTokens: 6155, totalTokens: 592733, completionCount: 18 },
  breakdown: [{ key: 'system', label: 'System', tokens: 6763 }, { key: 'history', label: 'Conversation', tokens: 31998 }],
};
let dom: Window;
let panel: HTMLElement;
let ring: HTMLButtonElement;
beforeEach(() => {
  dom = new Window();
  installHappyDomGlobals(dom);
  document.body.innerHTML = '<div id="anchor"><button id="contextUsageRing"></button><div id="contextUsageBreakdown" class="hidden"></div></div>';
  panel = document.getElementById(surface.breakdownId)!;
  ring = document.getElementById(surface.ringId) as HTMLButtonElement;
  panel.getBoundingClientRect = () => ({ width: 620, height: 480 }) as DOMRect;
  ring.getBoundingClientRect = () => ({ top: 640, bottom: 668, right: 1000 }) as DOMRect;
});
afterEach(async () => { closeContextUsageBreakdown(); await teardownHappyDomAsync(dom); });

test('context opens all details together and keeps last-request usage separate from session totals', () => {
  toggleContextUsageBreakdown(budget, surface);
  assert.equal(panel.parentElement, document.body, 'panel escapes composer clipping');
  assert.equal(panel.querySelector('.context-usage-breakdown__model')?.textContent, '<Model & name>');
  assert.equal(panel.querySelectorAll('.context-usage-row').length, 2);
  const usage = panel.querySelector('table')!;
  assert.match(usage.textContent!, /Last request/);
  assert.match(usage.textContent!, /Session/);
  assert.match(usage.textContent!, /38,309/);
  assert.match(usage.textContent!, /592,733/);
  assert.ok(panel.querySelector('[data-context-action="compact"]'));
  assert.equal(panel.querySelectorAll('[data-context-profile]').length, 3);
  assert.equal(ring.getAttribute('aria-expanded'), 'true');
  assert.ok(parseFloat(panel.style.top) >= 8);
  assert.ok(parseFloat(panel.style.left) >= 8);
});

test('refresh preserves keyboard focus; Escape closes and restores panel and trigger focus', () => {
  toggleContextUsageBreakdown(budget, surface);
  panel.querySelector<HTMLButtonElement>('[data-context-profile="lite"]')!.focus();
  syncContextUsageBreakdownIfOpen({ ...budget, used: 42000 });
  assert.equal((document.activeElement as HTMLElement).dataset.contextProfile, 'lite');
  assert.match(panel.textContent!, /42,000/);
  document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.ok(panel.classList.contains('hidden'));
  assert.equal(panel.parentElement?.id, 'anchor');
  assert.equal(document.activeElement, ring);
  assert.equal(ring.getAttribute('aria-expanded'), 'false');
});

test('unknown windows and pending compaction have clear states', () => {
  toggleContextUsageBreakdown({ ...budget, limit: null, remaining: null, percent: null, compressAtTokens: null }, surface);
  assert.match(panel.textContent!, /Context window unknown/);
  assert.match(panel.textContent!, /Compaction disabled/);
  assert.doesNotMatch(panel.textContent!, /null/);
  syncContextUsageBreakdownIfOpen({ ...budget, willCompress: true });
  assert.match(panel.textContent!, /Older turns will be summarized on the next send/);
  panel.querySelector<HTMLButtonElement>('[data-context-action="close"]')!.click();
  assert.ok(panel.classList.contains('hidden'));
});

test('aggregate-only CLI usage shows unavailable request counts and retains session totals', () => {
  toggleContextUsageBreakdown({ ...budget,
    lastTurnPromptTokens: null, lastTurnCompletionTokens: null, lastTurnTotalTokens: null,
  }, surface);
  const rows = panel.querySelectorAll('tbody tr');
  assert.deepEqual(Array.from(rows, row => row.children[1].textContent), ['—', '—', '—']);
  assert.equal(rows[2].children[2].textContent, '592,733');
  assert.match(panel.textContent!, /Individual request counts are unavailable/);
});
