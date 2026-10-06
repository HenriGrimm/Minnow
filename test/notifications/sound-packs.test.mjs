import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('notification sound packs', () => {
  test('default pack maps kinds to expected cues', async () => {
    const packs = await import('../../src/notifications/sound-packs.ts');
    assert.equal(
      packs.resolveNotificationSoundUrl('default', 'chat_turn_complete'),
      './sounds/packs/default/turn-complete.wav',
    );
    assert.equal(
      packs.resolveNotificationSoundUrl('default', 'chat_question'),
      './sounds/packs/default/question.wav',
    );
    assert.equal(
      packs.resolveNotificationSoundUrl('default', 'chat_tool_failure'),
      './sounds/packs/default/tool-turn.mp3',
    );
    assert.equal(
      packs.resolveNotificationSoundUrl('default', 'agent_wait'),
      './sounds/packs/default/timer.wav',
    );
  });

  test('none pack resolves to undefined', async () => {
    const packs = await import('../../src/notifications/sound-packs.ts');
    assert.equal(packs.resolveNotificationSoundUrl('none', 'chat_turn_complete'), undefined);
    assert.equal(packs.resolveNotificationSoundUrl('none', 'agent_wait'), undefined);
  });
});
