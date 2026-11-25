/**
 * Plan-complete handoff: buttons on the turn-changes card replace the question.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTurnChanges, findTurnPlanPath } from '../../src/ui/chat-turn-changes.ts';
import { Window } from 'happy-dom';

describe('turn-changes plan actions', () => {
  const plan = 'documentation/plans/issues/MIN-344.md';

  test('saved plans offer actions without a chat mode or pinned skill', () => {
    assert.equal(findTurnPlanPath(['src/a.ts', plan]), plan);
  });

  test('ordinary files and plan references get no plan actions', () => {
    assert.equal(findTurnPlanPath(['README.md']), undefined);
    assert.equal(
      findTurnPlanPath(['documentation/plans/references/x.md']),
      undefined,
    );
  });

  test('saved plan actions offer interactive and unattended builds', async () => {
    const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    const chat = {
      id: 'planner', modeId: 'build', workspacePath: 'C:/work/plan-project',
      history: [{ role: 'tool', content: 'Saved', codeChange: { path: plan, additions: 12, deletions: 0 } }],
    };
    try {
      const card = createTurnChanges(chat, 0, 0);
      const buttons = [...card.querySelectorAll('.chat-turn-changes__plan-actions button')];
      assert.deepEqual(buttons.map(button => button.textContent), ['Open plan', 'Build here', 'Run factory']);
      assert.ok(buttons[1].classList.contains('chat-turn-changes__action--primary'));
    } finally {
      Object.assign(globalThis, previous);
      window.close();
    }
  });
});
