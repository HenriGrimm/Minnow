/**
 * Pinned skill resolution for sticky /caveman threads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ensurePinnedSkill,
  isCavemanStopPhrase,
  normalizeCavemanUserText,
  resolveTurnSkill,
} from '../../src/skills/pinned-skill.ts';
import { isPartyModeStopPhrase } from '../../src/skills/partymode-client.ts';

const alwaysEnabled = () => true;
const cavemanDisabled = (id: string) => id !== 'caveman';

describe('isCavemanStopPhrase', () => {
  it('detects stop phrases', () => {
    assert.equal(isCavemanStopPhrase('stop caveman'), true);
    assert.equal(isCavemanStopPhrase('please use normal mode now'), true);
    assert.equal(isCavemanStopPhrase('explain hooks'), false);
  });
});

describe('isPartyModeStopPhrase', () => {
  it('detects party stop phrases', () => {
    assert.equal(isPartyModeStopPhrase('stop party'), true);
    assert.equal(isPartyModeStopPhrase("party's over"), true);
    assert.equal(isPartyModeStopPhrase('explain hooks'), false);
  });
});

describe('resolveTurnSkill', () => {
  it('pins caveman from slash and parses intensity', () => {
    const out = resolveTurnSkill({
      slashSkillId: 'caveman',
      userText: 'ultra why rerender',
      pinned: null,
      isSkillEnabled: alwaysEnabled,
    });
    assert.equal(out.skillId, 'caveman');
    assert.equal(out.nextPinned?.id, 'caveman');
    assert.equal(out.nextPinned?.intensity, 'ultra');
    assert.equal(out.fromPin, false);
  });

  it('pins partymode from slash', () => {
    const out = resolveTurnSkill({
      slashSkillId: 'partymode',
      userText: 'lets go',
      pinned: null,
      isSkillEnabled: alwaysEnabled,
    });
    assert.equal(out.skillId, 'partymode');
    assert.equal(out.nextPinned?.id, 'partymode');
    assert.equal(out.fromPin, false);
  });

  it('clears partymode pin on stop phrase', () => {
    const out = resolveTurnSkill({
      slashSkillId: null,
      userText: 'stop party',
      pinned: { id: 'partymode' },
      isSkillEnabled: alwaysEnabled,
    });
    assert.equal(out.skillId, null);
    assert.equal(out.nextPinned, null);
  });

  it('uses pinned skill when no slash', () => {
    const out = resolveTurnSkill({
      slashSkillId: null,
      userText: 'next question',
      pinned: { id: 'caveman', intensity: 'full' },
      isSkillEnabled: alwaysEnabled,
    });
    assert.equal(out.skillId, 'caveman');
    assert.equal(out.fromPin, true);
  });

  it('clears caveman pin on stop phrase', () => {
    const out = resolveTurnSkill({
      slashSkillId: null,
      userText: 'stop caveman',
      pinned: { id: 'caveman', intensity: 'full' },
      isSkillEnabled: alwaysEnabled,
    });
    assert.equal(out.skillId, null);
    assert.equal(out.nextPinned, null);
  });

  it('uses an ordinary slash skill for one turn without replacing a chat pin', () => {
    const pinned = { id: 'caveman', intensity: 'ultra' };
    const out = resolveTurnSkill({
      slashSkillId: 'git-commit',
      userText: 'draft message',
      pinned,
      isSkillEnabled: alwaysEnabled,
    });
    assert.equal(out.skillId, 'git-commit');
    assert.equal(out.nextPinned, pinned);
    assert.equal(out.fromPin, false);
  });

  it('returns to the default workflow after a slash skill in an unpinned chat', () => {
    for (const id of ['plan', 'ask', 'debug', 'git-commit', 'custom-skill']) {
      const slash = resolveTurnSkill({ slashSkillId: id, userText: 'Inspect', pinned: null, isSkillEnabled: alwaysEnabled });
      assert.deepEqual(slash, { skillId: id, nextPinned: null, fromPin: false });
      const next = resolveTurnSkill({ slashSkillId: null, userText: 'Continue', pinned: slash.nextPinned, isSkillEnabled: alwaysEnabled });
      assert.deepEqual(next, { skillId: null, nextPinned: null, fromPin: false });
    }
  });

  it('drops pinned skill when disabled', () => {
    const out = resolveTurnSkill({
      slashSkillId: null,
      userText: 'hello',
      pinned: { id: 'caveman', intensity: 'full' },
      isSkillEnabled: cavemanDisabled,
    });
    assert.equal(out.skillId, null);
  });
});

describe('normalizeCavemanUserText', () => {
  it('strips intensity after slash caveman', () => {
    assert.equal(
      normalizeCavemanUserText('caveman', 'caveman', 'ultra explain foo'),
      'explain foo',
    );
  });
});

describe('ensurePinnedSkill', () => {
  it('normalizes persisted pin', () => {
    assert.deepEqual(ensurePinnedSkill({ id: 'caveman', intensity: 'ultra' }), {
      id: 'caveman',
      intensity: 'ultra',
    });
    assert.equal(ensurePinnedSkill({ id: 'Bad Id' }), null);
  });
});
