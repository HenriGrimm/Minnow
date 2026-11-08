/**
 * Legacy settings area slugs must resolve to visible panels (agent-center, etc.).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveSettingsSectionNavigation } = await import(
  '../../src/ui/settings-section-navigation.ts'
);

describe('resolveSettingsSectionNavigation', () => {
  test('old General field links follow their new pages', () => {
    for (const [key, area] of [
      ['general.backup', 'backups'],
      ['general.filesystem', 'access'], ['general.shellSandbox', 'access'], ['general.chat.terminal.defaultShell', 'terminal'],
      ['general.updates.channel', 'general'],
    ]) {
      assert.deepEqual(resolveSettingsSectionNavigation('general', key), { sectionId: area, searchKey: key });
    }
  });
  test('legacy Data links open the corresponding split page', () => {
    assert.deepEqual(resolveSettingsSectionNavigation('data'), { sectionId: 'backups', searchKey: undefined });
    for (const key of ['general.filesystem', 'general.shellSandbox']) {
      assert.deepEqual(resolveSettingsSectionNavigation('data', key), { sectionId: 'access', searchKey: key });
    }
  });
  test('the old Network access link opens Devices', () => {
    assert.deepEqual(resolveSettingsSectionNavigation('general', 'general.network.mode'), { sectionId: 'devices' });
  });
  test('hidden developer pages redirect to diagnostics', () => {
    for (const section of ['board-testing', 'capability-matrix']) {
      assert.deepEqual(resolveSettingsSectionNavigation(section), { sectionId: 'diagnostics' });
    }
  });
  test('maps sub-agents to agent-center with a scroll target', () => {
    assert.deepEqual(resolveSettingsSectionNavigation('sub-agents'), {
      sectionId: 'agent-center',
      searchKey: 'agents.subAgents',
    });
  });

  // Legacy mode links land on the replacement skills.
  test('maps modes to workflow skills', () => {
    assert.deepEqual(resolveSettingsSectionNavigation('modes'), {
      sectionId: 'agent-center',
      searchKey: 'agents.skills',
    });
  });

  test('preserves an explicit search key over legacy defaults', () => {
    assert.deepEqual(
      resolveSettingsSectionNavigation('sub-agents', 'agents.subAgents.limits'),
      {
        sectionId: 'agent-center',
        searchKey: 'agents.subAgents.limits',
      },
    );
  });

  test('leaves current sections unchanged', () => {
    assert.deepEqual(resolveSettingsSectionNavigation('diagnostics'), {
      sectionId: 'diagnostics',
      searchKey: undefined,
    });
  });
});
