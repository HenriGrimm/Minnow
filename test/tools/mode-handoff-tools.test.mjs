/**
 * Plan-complete handoff: buttons on the turn-changes card replace the question.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findTurnPlanPath } from '../../src/ui/chat-turn-changes.ts';

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
});
