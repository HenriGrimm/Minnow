/**
 * Issues command-palette source.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { listCommands, registerCommandSource, resetCommandRegistryForTests } from '../../src/ui/command-registry.ts';
import { buildIssuesCommands } from '../../src/ui/issues-commands.ts';
import { BUILTIN_VIEW_TRIAGE } from '../../src/issues/saved-views.ts';

afterEach(() => {
  resetCommandRegistryForTests();
});

describe('issues command source', () => {
  test('registers surface commands while Issues is open', () => {
    const unregister = registerCommandSource(
      'issues',
      () =>
        buildIssuesCommands({
          isOpen: () => true,
          newIssue: () => {},
          setViewMode: () => {},
          setGroupBy: () => {},
          setActiveView: () => {},
          goToFocused: () => {},
          expandFocused: () => {},
          acceptTriage: () => {},
          declineTriage: () => {},
          listUserViews: () => [{ id: 'view-1', name: 'Bugs' }],
        }),
      { order: 20 },
    );

    const ids = listCommands().map((command) => command.id);
    assert.ok(ids.includes('issues.new'));
    assert.ok(ids.includes('issues.expand'));
    assert.equal(listCommands().find((command) => command.id === 'issues.expand')?.shortcut, 'E');
    assert.ok(ids.includes('issues.view.triage'));
    assert.ok(ids.includes('issues.triage.accept'));
    assert.ok(ids.includes('issues.group.status'));
    assert.ok(ids.includes('issues.view.user.view-1'));
    assert.equal(listCommands().find((command) => command.id === 'issues.new')?.shortcut, 'C');
    assert.equal(
      listCommands().find((command) => command.id === 'issues.view.triage')?.run !== undefined,
      true,
    );
    unregister();
    assert.equal(listCommands().some((command) => command.id.startsWith('issues.')), false);
  });

  test('returns no commands when the Issues surface is closed', () => {
    registerCommandSource('issues', () =>
      buildIssuesCommands({
        isOpen: () => false,
        newIssue: () => {},
        setViewMode: () => {},
        setGroupBy: () => {},
        setActiveView: () => {},
        goToFocused: () => {},
        expandFocused: () => {},
        acceptTriage: () => {},
        declineTriage: () => {},
        listUserViews: () => [],
      }),
    );
    assert.equal(listCommands().some((command) => command.id.startsWith('issues.')), false);
    assert.ok(BUILTIN_VIEW_TRIAGE.startsWith('builtin:'));
  });
});
