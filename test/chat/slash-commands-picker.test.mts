import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  filterSlashCommands,
  getSlashCommandCatalog,
  registerCoreSlashCommand,
} from '../../src/chat/slash-commands/registry.ts';
import {
  listSlashPickerRows,
  rankSlashMatch,
  recordSlashRecent,
} from '../../src/chat/slash-commands/picker-catalog.ts';
import { refreshSkillCatalog } from '../../src/skills/client.ts';

describe('slash command registry', () => {
  test('includes goal commands', () => {
    const ids = getSlashCommandCatalog().map((command) => command.id);
    assert.ok(ids.includes('goal'));
    assert.ok(ids.includes('goal-clear'));
  });

  test('filterSlashCommands matches partial token', () => {
    const matches = filterSlashCommands('go');
    assert.ok(matches.some((command) => command.id === 'goal'));
  });

  test('includes the /followup command (MIN-206)', () => {
    const followup = getSlashCommandCatalog().find((command) => command.id === 'followup');
    assert.ok(followup);
    assert.equal(followup?.insertion, '/followup ');
    assert.ok(filterSlashCommands('follow').some((command) => command.id === 'followup'));
  });
});

describe('slash picker catalog', () => {
  test('merges commands with skills without duplicate skill ids', async () => {
    await refreshSkillCatalog();
    const rows = listSlashPickerRows('');
    assert.ok(rows.some((row) => row.kind === 'command' && row.command.id === 'goal'));
    assert.ok(rows.some((row) => row.kind === 'skill'));
    const goalSkill = rows.find(
      (row) => row.kind === 'skill' && row.skill.id === 'goal',
    );
    assert.equal(goalSkill, undefined);
  });

  test('filters commands by query', () => {
    const rows = listSlashPickerRows('goal');
    assert.ok(rows.some((row) => row.kind === 'command' && row.command.id === 'goal'));
    assert.ok(rows.some((row) => row.kind === 'command' && row.command.id === 'goal-clear'));
  });

  test('shows /followup as a command row', () => {
    const rows = listSlashPickerRows('follow');
    assert.ok(rows.some((row) => row.kind === 'command' && row.command.id === 'followup'));
  });
});

describe('slash menu redesign', () => {
  test('/ask, /plan and /debug lead the Commands section; other skills follow under Skills', async () => {
    await refreshSkillCatalog();
    const rows = listSlashPickerRows('');
    const commands = rows.filter((row) => row.section === 'commands');
    const firstSkills = commands.filter((row) => row.kind === 'skill').map((row) => row.kind === 'skill' && row.skill.id);
    assert.deepEqual(firstSkills.slice(0, 3), ['ask', 'plan', 'debug']);
    const sections = rows.map((row) => row.section).filter((s) => s !== 'recent');
    assert.equal(sections.indexOf('skills') > sections.lastIndexOf('commands'), true, 'skills come after commands');
  });

  test('ranks an id prefix ahead of a description match', () => {
    assert.equal(rankSlashMatch('pl', 'plan', '/plan', 'Write a plan'), 0);
    assert.equal(rankSlashMatch('pl', 'loop', 'Loop', 'Re-run a plan'), 3);
    assert.equal(rankSlashMatch('zz', 'loop', 'Loop', 'Re-run'), -1);
    const rows = listSlashPickerRows('pla');
    assert.equal(rows[0]?.kind === 'skill' && rows[0].skill.id, 'plan');
  });

  test('recently used rows lead an empty query', async () => {
    await refreshSkillCatalog();
    const store = new Map<string, string>();
    const previous = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(), key: () => null, length: 0,
    } as Storage;
    try {
      const loop = listSlashPickerRows('loop').find((row) => row.kind === 'command' && row.command.id === 'loop');
      assert.ok(loop);
      recordSlashRecent(loop);
      const rows = listSlashPickerRows('');
      assert.equal(rows[0]?.section, 'recent');
      assert.equal(rows[0]?.kind === 'command' && rows[0].command.id, 'loop');
      assert.equal(rows.filter((row) => row.kind === 'command' && row.command.id === 'loop').length, 1);
    } finally {
      globalThis.localStorage = previous;
    }
  });

  test('core commands carry values and submenus', () => {
    const unregister = registerCoreSlashCommand({
      id: 'permissions', label: 'Permissions', description: 'Level', insertion: '', order: 21,
      value: () => 'Auto',
      submenu: () => [{ id: 'auto', label: 'Auto', selected: true }],
    });
    try {
      const row = listSlashPickerRows('perm').find((r) => r.kind === 'command' && r.command.id === 'permissions');
      assert.ok(row && row.kind === 'command');
      assert.equal(row.command.value?.(), 'Auto');
      assert.equal(row.command.submenu?.()[0]?.selected, true);
    } finally {
      unregister();
    }
  });
});
