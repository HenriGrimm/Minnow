/**
 * Plan-complete handoff: buttons on the turn-changes card replace the question.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTurnChanges, findTurnPlanPath } from '../../src/ui/chat-turn-changes.ts';
import { Window } from 'happy-dom';

describe('turn-changes plan actions', () => {
  const plan = 'documentation/plans/issues/MIN-344.md';

  test('plan modes offer actions for a written plan file', () => {
    assert.equal(findTurnPlanPath({ modeId: 'plan' }, ['src/a.ts', plan]), plan);
    assert.equal(findTurnPlanPath({ modeId: 'super-plan' }, [plan]), plan);
  });

  test('other modes and non-plan files get no actions', () => {
    assert.equal(findTurnPlanPath({ modeId: 'build' }, [plan]), undefined);
    assert.equal(findTurnPlanPath({ modeId: 'plan' }, ['README.md']), undefined);
    assert.equal(
      findTurnPlanPath({ modeId: 'plan' }, ['documentation/plans/references/x.md']),
      undefined,
    );
  });

  test('saved plan actions read the current artifact in the chat workspace', async () => {
    const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    const urls = [];
    let markdown = '---\nplanType: build\n---\n# Build';
    globalThis.fetch = async (url) => { urls.push(String(url)); return new Response(markdown); };
    const chat = {
      id: 'planner', modeId: 'plan', workspacePath: 'C:/work/plan-project',
      history: [{ role: 'tool', content: 'Saved', codeChange: { path: plan, additions: 12, deletions: 0 } }],
    };
    try {
      for (const type of ['build', 'orchestrate']) {
        markdown = `---\nplanType: ${type}\n---\n# Plan`;
        const card = createTurnChanges(chat, 0, 0);
        await new Promise((resolve) => setImmediate(resolve));
        const buttons = [...card.querySelectorAll('.chat-turn-changes__plan-actions button')];
        assert.equal(buttons.find((button) => button.textContent === 'Orchestrate').hidden, type === 'build');
        assert.equal(buttons.find((button) => button.textContent === 'Build here').classList.contains('chat-turn-changes__action--primary'), type === 'build');
      }
      assert.ok(urls.every((url) => url.includes(encodeURIComponent(chat.workspacePath))));
    } finally {
      Object.assign(globalThis, previous);
      window.close();
    }
  });
});
