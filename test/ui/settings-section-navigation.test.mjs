/**
 * Legacy settings area slugs must resolve to visible panels (agent-center, etc.).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { resolveSettingsSectionNavigation } = await import(
  '../../src/ui/settings-section-navigation.ts'
);

describe('resolveSettingsSectionNavigation', () => {
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
