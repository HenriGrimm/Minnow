import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { modelCache } from '../../src/app-state.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { mergeReasoningPatch, type BoardReasoningFields } from '../../src/orchestrator/board-journal-reasoning.ts';
import { teardownBoardHeaderReasoning, wireBoardHeaderReasoningSource } from '../../src/ui/orchestrate-board-reasoning.ts';
import { attachV2BoardHeaderInstruments, teardownV2BoardHeaderInstruments } from '../../src/orchestrator/board-header-v2.ts';
import type { BoardState } from '../../server/orchestrator/core/types';

let activeWindow: Window | undefined;

afterEach(() => {
  teardownV2BoardHeaderInstruments();
  teardownBoardHeaderReasoning();
  modelCache.clear();
  activeWindow?.close();
});

for (const level of ['xhigh', 'max'] as const) {
  test(`V2 board selects and retains the last reasoning option (${level}) after refresh`, () => {
    activeWindow = new Window();
    installHappyDomGlobals(activeWindow);
    modelCache.set(encodeModelSelectKey('test-provider', 'test-reasoner'), {
      id: 'test-reasoner', type: 'llm',
      reasoning: { allowed_options: ['off', 'low', level], default: 'low' },
    });
    const controls = document.createElement('div');
    document.body.appendChild(controls);
    let state = {
      status: 'running',
      model: { providerId: 'test-provider', id: 'test-reasoner', reasoning: 'low' },
    } as BoardState;
    const posted: string[] = [];
    const commands = {
      setModel: async (providerId: string, id: string, reasoning: string) => {
        posted.push(reasoning);
        state = { ...state, model: { providerId, id, reasoning } };
      },
      onNeedModel: () => assert.fail('board already has a model'),
    };
    attachV2BoardHeaderInstruments(controls, state, commands);
    const select = controls.querySelector('select') as HTMLSelectElement;
    assert.equal(select.options[select.options.length - 1].value, level);
    select.value = level;
    select.dispatchEvent(new activeWindow.Event('change'));
    assert.deepEqual(posted, [level]);
    assert.equal(select.value, level);
    attachV2BoardHeaderInstruments(controls, state, commands);
    assert.equal(select.value, level);
  });
}

test('running board reasoning selector and toggle persist without stopping the board', () => {
  activeWindow = new Window();
  installHappyDomGlobals(activeWindow);
  modelCache.set(encodeModelSelectKey('test-provider', 'test-reasoner'), {
    id: 'test-reasoner', type: 'llm',
    reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' },
  });
  let fields: BoardReasoningFields = { reasoningEffort: 'medium' };
  let changes = 0;
  const controls = document.createElement('div');
  document.body.appendChild(controls);
  wireBoardHeaderReasoningSource(controls, {
    resolveBinding: () => ({ providerId: 'test-provider', modelId: 'test-reasoner' }),
    getBoard: () => fields,
    isRunning: () => true,
    persist: (patch) => { fields = mergeReasoningPatch(fields, patch); },
    onChanged: () => { changes += 1; },
  });
  const select = controls.querySelector('select') as HTMLSelectElement;
  const toggle = controls.querySelector('button') as HTMLButtonElement;
  assert.equal(select.disabled, false);
  assert.equal(toggle.disabled, false);
  assert.match(select.title, /new attempts/);
  select.value = 'high';
  select.dispatchEvent(new activeWindow.Event('change'));
  assert.equal(fields.reasoningEffort, 'high');
  assert.equal(select.value, 'high');
  toggle.click();
  assert.equal(fields.reasoningEffort, 'off');
  assert.equal(toggle.disabled, false);
  toggle.click();
  assert.notEqual(fields.reasoningEffort, 'off');
  assert.equal(changes, 3);
});
