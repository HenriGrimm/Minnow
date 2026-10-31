/**
 * Provider marks for agents: picker logos, status badges, the one-shot settle
 * pop, and the provider stack on agent groups.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const {
  agentMarkStateFromLabel,
  agentModelId,
  createAgentMark,
  createAgentModelChip,
  syncAgentMark,
  syncAgentMarkStack,
  syncAgentModelChip,
} = await import('../../src/ui/agent-model-mark.ts');

beforeEach(() => {
  const window = new Window();
  globalThis.document = window.document as unknown as Document;
  globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
});

test('the model that ran wins over the one requested', () => {
  assert.equal(agentModelId({ modelId: 'review-pool', resolvedModel: { id: 'claude-sonnet-5-5' } }), 'claude-sonnet-5-5');
  assert.equal(agentModelId({ modelId: 'gpt-5' }), 'gpt-5');
  assert.equal(agentModelId({}), '');
});

test('status labels map onto mark states', () => {
  assert.equal(agentMarkStateFromLabel('Complete'), 'done');
  assert.equal(agentMarkStateFromLabel('Working'), 'running');
  assert.equal(agentMarkStateFromLabel('Loading model'), 'running');
  assert.equal(agentMarkStateFromLabel('Queued for agent slot'), 'queued');
  assert.equal(agentMarkStateFromLabel('Needs your answer'), 'waiting');
  assert.equal(agentMarkStateFromLabel('Failed'), 'failed');
  assert.equal(agentMarkStateFromLabel('Stopped'), 'stopped');
});

test('marks show the producer logo, falling back to the agent glyph', () => {
  const mark = createAgentMark();
  syncAgentMark(mark, 'claude-sonnet-5-5', 'running');
  const logo = mark.querySelector<HTMLElement>('.agent-mark__logo')!;
  assert.equal(logo.dataset.hasLogo, 'true');
  assert.ok(logo.querySelector('svg'));
  assert.equal(mark.getAttribute('aria-hidden'), 'true');

  syncAgentMark(mark, 'my-local-finetune', 'running');
  assert.equal(logo.dataset.hasLogo, 'false');
  assert.equal(logo.querySelector('svg'), null);
});

test('the badge pops only when a live agent settles in view', () => {
  const settledOnPaint = createAgentMark();
  syncAgentMark(settledOnPaint, 'gpt-5', 'done');
  assert.equal(settledOnPaint.classList.contains('agent-mark--settled'), false);
  assert.ok(settledOnPaint.querySelector('.agent-mark__badge .icon-svg'));

  const live = createAgentMark();
  syncAgentMark(live, 'gpt-5', 'running');
  assert.equal(live.querySelector('.agent-mark__badge')!.childElementCount, 0);
  syncAgentMark(live, 'gpt-5', 'failed');
  assert.equal(live.dataset.state, 'failed');
  assert.equal(live.classList.contains('agent-mark--settled'), true);
});

test('stacks show three providers then an overflow count', () => {
  const stack = document.createElement('span');
  syncAgentMarkStack(stack, ['claude-opus-5-5', 'gpt-5', 'gemini-2.5-pro', 'claude-haiku-5-5', 'gpt-5']);
  assert.equal(stack.querySelectorAll('.agent-mark__logo').length, 3);
  assert.equal(stack.querySelector('.agent-mark--more')?.textContent, '+2');
  const first = stack.firstElementChild;
  syncAgentMarkStack(stack, ['claude-opus-5-5', 'gpt-5', 'gemini-2.5-pro', 'claude-haiku-5-5', 'gpt-5']);
  assert.equal(stack.firstElementChild, first, 'unchanged models keep the same nodes');
});

test('model chips carry the picker logo and the full label', () => {
  const chip = createAgentModelChip();
  syncAgentModelChip(chip, 'gemini-2.5-pro', 'gemini-2.5-pro');
  assert.equal(chip.querySelector('.agent-model-chip__label')?.textContent, 'gemini-2.5-pro');
  assert.equal(chip.querySelector<HTMLElement>('.agent-model-chip__logo')!.hidden, false);
  syncAgentModelChip(chip, 'review-pool', 'Pool review-pool');
  assert.equal(chip.querySelector<HTMLElement>('.agent-model-chip__logo')!.hidden, true);
});
