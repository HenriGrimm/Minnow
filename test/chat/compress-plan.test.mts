/**
 * `/compress` split over history rows (context compaction v2, P0-E).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planCompress } from '../../src/chat/context/compress-plan.ts';
import { historyToApiMessagesForEstimate } from '../../src/chat/prompts/token-estimate-core.ts';
import type { Message } from '../../src/types.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function screenshotTurn(n: number): Message[] {
  return [
    { role: 'user', content: `request ${n}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `shot${n}`, type: 'function', function: { name: 'browser_screenshot', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: `shot${n}`,
      content: 'saved',
      attachments: [{ type: 'image', dataUrl: PNG, mimeType: 'image/png' }],
    },
    { role: 'assistant', content: `answer ${n}` },
  ] as Message[];
}

describe('planCompress', () => {
  test('a screenshot tool row before the cut still keeps exactly the last turns', () => {
    const history: Message[] = [
      ...screenshotTurn(1),
      { role: 'context', policy: 'slide', droppedTurns: 1, createdAt: 1 },
      ...screenshotTurn(2),
      ...screenshotTurn(3),
    ];
    // The fixture must reproduce the drift: screenshots add API rows.
    assert.ok(
      historyToApiMessagesForEstimate(history).length > history.filter((m) => m.role !== 'context').length,
    );

    const plan = planCompress(history, 1);
    assert.ok(plan);
    assert.equal(plan.droppedTurns, 2);
    assert.deepEqual(plan.kept, screenshotTurn(3));
    assert.match(plan.droppedText, /request 1[\s\S]*answer 1[\s\S]*request 2[\s\S]*answer 2/);
    assert.doesNotMatch(plan.droppedText, /request 3/);
  });

  test('kept rows never start with an orphaned tool result', () => {
    const plan = planCompress([...screenshotTurn(1), ...screenshotTurn(2), ...screenshotTurn(3)], 2);
    assert.ok(plan);
    assert.equal(plan.kept[0].role, 'user');
    assert.equal((plan.kept[0] as { content: string }).content, 'request 2');
  });

  test('UI-only notice rows are filtered once, and a short chat has nothing to fold', () => {
    const history: Message[] = [
      ...screenshotTurn(1),
      { role: 'context', policy: 'summarize', droppedTurns: 2, createdAt: 1 },
    ];
    assert.equal(planCompress(history, 1), null);
  });
});
