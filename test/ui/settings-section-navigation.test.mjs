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
      ['general.backup', 'data'], ['general.network.mode', 'data'],
      ['general.filesystem', 'data'], ['general.chat.terminal.defaultShell', 'terminal'],
      ['general.updates.channel', 'updates'],
    ]) {
      assert.deepEqual(resolveSettingsSectionNavigation('general', key), { sectionId: area, searchKey: key });
    }
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

  // Super Plan is disabled for release, so modes lands on the Plan mode settings.
  test('maps modes to agent-center Plan mode settings', () => {
    assert.deepEqual(resolveSettingsSectionNavigation('modes'), {
      sectionId: 'agent-center',
      searchKey: 'modes.plan',
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
