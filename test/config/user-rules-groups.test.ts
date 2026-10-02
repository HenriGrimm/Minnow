/**
 * removeUserRuleGroup: empty groups can be dropped; non-empty groups are blocked.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  removeUserRuleGroup,
  createUserRuleGroup,
  createUserRuleItem,
  type UserRulesSettings,
} from '../../src/config/user-rules.ts';

test('rules and groups can be created over LAN HTTP without crypto.randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  try {
    const group = createUserRuleGroup('Mobile');
    const rule = createUserRuleItem(group.id);
    assert.match(group.id, /^[0-9a-f-]{36}$/i);
    assert.match(rule.id, /^[0-9a-f-]{36}$/i);
    assert.notEqual(group.id, rule.id);
    assert.equal(rule.groupId, group.id);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

const GENERAL_RULE = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'TypeScript',
  text: 'Use strict TypeScript.',
  enabled: true,
  groupId: 'general',
};

const STYLE_RULE = {
  id: '22222222-2222-2222-2222-222222222222',
  title: 'Diff size',
  text: 'Prefer small diffs.',
  enabled: false,
  groupId: 'style',
};

function sampleSettings(overrides: Partial<UserRulesSettings> = {}): UserRulesSettings {
  return {
    version: 2,
    enabled: true,
    groups: [
      { id: 'general', name: 'General' },
      { id: 'style', name: 'Style' },
    ],
    rules: [GENERAL_RULE, STYLE_RULE],
    ...overrides,
  };
}

describe('removeUserRuleGroup', () => {
  test('deletes an empty group and leaves other groups\' rules untouched', () => {
    const settings = sampleSettings({
      rules: [GENERAL_RULE],
    });
    const snapshot = structuredClone(settings);

    const result = removeUserRuleGroup(settings, 'style');

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.settings.groups, [{ id: 'general', name: 'General' }]);
    assert.deepEqual(result.settings.rules, [GENERAL_RULE]);
    assert.equal(result.settings.rules[0].groupId, 'general');
    // Caller blob is not mutated so a cancelled confirm cannot leak a half-delete.
    assert.deepEqual(settings, snapshot);
  });

  test('blocks a group that still has one rule and explains why', () => {
    const settings = sampleSettings({
      rules: [GENERAL_RULE, STYLE_RULE],
    });

    const result = removeUserRuleGroup(settings, 'style');

    assert.deepEqual(result, {
      ok: false,
      error:
        'Cannot delete "Style": it still has 1 rule. Move or delete it first.',
    });
    assert.deepEqual(settings.groups.map((group) => group.id), ['general', 'style']);
    assert.deepEqual(
      settings.rules.map((rule) => ({ id: rule.id, groupId: rule.groupId })),
      [
        { id: GENERAL_RULE.id, groupId: 'general' },
        { id: STYLE_RULE.id, groupId: 'style' },
      ],
    );
  });

  test('blocks a group that still has several rules and uses plural copy', () => {
    const extraStyleRule = {
      id: '33333333-3333-3333-3333-333333333333',
      title: 'Comments',
      text: 'Comment the why.',
      enabled: true,
      groupId: 'style',
    };
    const settings = sampleSettings({
      rules: [GENERAL_RULE, STYLE_RULE, extraStyleRule],
    });

    const result = removeUserRuleGroup(settings, 'style');

    assert.deepEqual(result, {
      ok: false,
      error:
        'Cannot delete "Style": it still has 2 rules. Move or delete them first.',
    });
    assert.equal(settings.rules.length, 3);
  });

  test('blocks deleting the last remaining group', () => {
    const settings = sampleSettings({
      groups: [{ id: 'general', name: 'General' }],
      rules: [],
    });

    const result = removeUserRuleGroup(settings, 'general');

    assert.deepEqual(result, {
      ok: false,
      error: 'Keep at least one rule group.',
    });
  });

  test('reports when the group is already gone', () => {
    const settings = sampleSettings({ rules: [GENERAL_RULE] });
    const result = removeUserRuleGroup(settings, 'missing');
    assert.deepEqual(result, {
      ok: false,
      error: 'That rule group is already gone.',
    });
  });
});
