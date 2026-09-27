import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { APPS, listReleasedApps } from '../../src/os/app-registry';
import type { AppId, LaunchOptions } from '../../src/os/types';
import { BRAIN_SECTIONS } from '../../src/ui/brain-section-ids';
import { MODELS_SECTIONS } from '../../src/ui/models-section-ids';
import { SETTINGS_SECTIONS } from '../../src/ui/settings-page-types';
import {
  ISSUES_COMMAND_DESTINATIONS,
  buildShellNavigationCommands,
} from '../../src/ui/shell-navigation-commands';

describe('shell navigation command index', () => {
  test('indexes every released app and excludes every hidden app', () => {
    const commands = buildShellNavigationCommands({ launchApp: () => {} }, listReleasedApps());
    const appIds = commands
      .filter((command) => command.id.startsWith('app.'))
      .map((command) => command.id.slice('app.'.length));

    assert.deepEqual(appIds, listReleasedApps().map((app) => app.id));
    for (const hidden of APPS.filter((app) => app.releaseState === 'hidden')) {
      assert.equal(commands.some((command) => command.id === `app.${hidden.id}`), false);
      assert.equal(commands.some((command) => command.title.includes(hidden.name)), false);
    }
  });

  test('indexes all Models, Brain, Issues, and visible Settings destinations once', () => {
    const commands = buildShellNavigationCommands({ launchApp: () => {} }, listReleasedApps());
    const ids = commands.map((command) => command.id);

    assert.equal(new Set(ids).size, ids.length, 'command ids stay unique');
    for (const section of MODELS_SECTIONS) {
      assert.ok(ids.includes(`navigate.models.${section}`), `Models ${section}`);
    }
    for (const section of BRAIN_SECTIONS) {
      assert.ok(ids.includes(`navigate.brain.${section}`), `Brain ${section}`);
    }
    for (const section of SETTINGS_SECTIONS) {
      assert.ok(ids.includes(`navigate.settings.${section}`), `Settings ${section}`);
    }
    assert.equal(
      commands.filter((command) => command.group === 'Navigate · Issues').length,
      ISSUES_COMMAND_DESTINATIONS.length,
    );
    assert.ok(
      commands
        .filter((command) => command.group.startsWith('Navigate ·'))
        .every((command) => command.presentation === 'search-only'),
    );
  });

  test('advanced destinations retain context keywords and launch structured targets', () => {
    const launches: Array<{ appId: AppId; options?: LaunchOptions }> = [];
    const commands = buildShellNavigationCommands(
      { launchApp: (appId, options) => launches.push({ appId, options }) },
      listReleasedApps(),
    );

    const voice = commands.find((command) => command.id === 'navigate.models.voice');
    assert.match(voice?.keywords ?? '', /advanced/);
    voice?.run();
    assert.deepEqual(launches.pop(), {
      appId: 'models',
      options: { modelsSection: 'voice' },
    });

    const schema = commands.find((command) => command.id === 'navigate.brain.schema');
    assert.match(schema?.keywords ?? '', /more advanced/);
    schema?.run();
    assert.deepEqual(launches.pop(), {
      appId: 'brain',
      options: { brainSection: 'schema' },
    });

    const board = commands.find((command) => command.id === 'issues.view.board');
    board?.run();
    assert.deepEqual(launches.pop(), {
      appId: 'issues',
      options: { issuesViewMode: 'board' },
    });
  });

  test('does not add destructive actions to the global index', () => {
    const commands = buildShellNavigationCommands({ launchApp: () => {} }, listReleasedApps());
    const destructive = commands.filter((command) =>
      /^(delete|remove|clear|reset|discard)\b/i.test(command.title),
    );
    assert.deepEqual(destructive, []);
  });
});
