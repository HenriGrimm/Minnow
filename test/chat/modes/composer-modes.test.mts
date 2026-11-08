import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { listComposerModes, listModes } from '../../../src/chat/modes/registry.ts';

describe('listComposerModes', () => {
  test('offers no modes in the composer while legacy ids remain registered', () => {
    assert.deepEqual(listComposerModes(), []);
    const all = listModes().map(mode => mode.id);
    for (const id of ['build', 'plan', 'debug', 'orchestrate', 'onboarding']) {
      assert.ok(all.includes(id as typeof all[number]), `${id} remains registered`);
    }
  });
});
