import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from './dom-helpers.mts';
import { resetAppPreferencesForTests } from '../../src/os/app-preferences.ts';
import { resetInstancesForTests } from '../../src/os/instances.ts';
import {
  setWorkspaceFromServer,
  resetWorkspaceStateForTests,
} from '../../src/state/workspace.ts';
import { setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { setIssuesTaxonomyForTests } from '../../src/state/issues-taxonomy-store.ts';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';
import { emitIssuesChange, clearIssuesListenersForTests } from '../../src/state/issues-events.ts';
import type { IssueCard } from '../../src/types.ts';

const CURRENT_WS = '/ws/current';
const OTHER_WS = '/ws/other';

let win: InstanceType<typeof Window> | undefined;

function makeIssue(
  overrides: Partial<IssueCard> & Pick<IssueCard, 'id' | 'workspacePath'>,
): IssueCard {
  return {
    type: 'bug',
    title: `Issue ${overrides.id}`,
    description: '',
    status: 'triage',
    priority: 'none',
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setupRail(): HTMLElement {
  win = new Window();
  installHappyDomGlobals(win);
  resetAppPreferencesForTests();
  resetInstancesForTests();
  resetWorkspaceStateForTests();
  const root = document.createElement('nav');
  document.body.appendChild(root);
  return root;
}

/** Poll until `fn` is truthy (the rail's issues store import resolves lazily). */
async function waitFor(fn: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  clearIssuesListenersForTests();
  setIssuesStateForTests(null);
  setIssuesTaxonomyForTests(null);
  resetWorkspaceStateForTests();
  resetAppPreferencesForTests();
  resetInstancesForTests();
  if (win) {
    await teardownHappyDomAsync(win);
    win = undefined;
  }
});

describe('app rail issues badge workspace scoping (MIN-373)', { concurrency: false }, () => {
  test('counts only current-workspace issues, not every workspace', async () => {
    const root = setupRail();
    setWorkspaceFromServer({ path: CURRENT_WS, label: 'current', isDefault: false });
    setIssuesTaxonomyForTests(createDefaultIssuesTaxonomy());
    setIssuesStateForTests({
      version: 2,
      nextId: 5,
      issues: [
        // Unreviewed triage in the current workspace → counted.
        makeIssue({ id: 'ISS-1', workspacePath: CURRENT_WS, status: 'triage', source: 'crash' }),
        // Unreviewed triage in another workspace → must NOT count (the regression).
        makeIssue({ id: 'ISS-2', workspacePath: OTHER_WS, status: 'triage', source: 'crash' }),
        // Agent blocked waiting on the user, current workspace → counted.
        makeIssue({
          id: 'ISS-3',
          workspacePath: CURRENT_WS,
          status: 'in_progress',
          source: 'agent',
          triagedAt: 1,
          agent: { agentId: 'builder', phase: 'awaiting_input', startedAt: 1, updatedAt: 1 },
        }),
        // Closed work → never counted.
        makeIssue({ id: 'ISS-4', workspacePath: CURRENT_WS, status: 'done', source: 'user' }),
      ],
    });

    const { initAppRail } = await import('../../src/os/app-rail.ts');
    initAppRail(root);

    const badge = root.querySelector('[data-app-id="issues"] .mn-os-app-rail__badge');
    assert.ok(badge, 'issues tile badge element exists');
    await waitFor(() => badge!.textContent === '2');
    assert.equal(badge.textContent, '2');
    assert.equal(badge.hidden, false);
  });

  test('hides when no current-workspace issues remain (live re-sync)', async () => {
    const root = setupRail();
    setWorkspaceFromServer({ path: CURRENT_WS, label: 'current', isDefault: false });
    setIssuesTaxonomyForTests(createDefaultIssuesTaxonomy());
    setIssuesStateForTests({
      version: 2,
      nextId: 3,
      issues: [
        makeIssue({ id: 'ISS-1', workspacePath: CURRENT_WS, status: 'triage', source: 'crash' }),
        makeIssue({
          id: 'ISS-3',
          workspacePath: CURRENT_WS,
          status: 'in_progress',
          source: 'agent',
          triagedAt: 1,
          agent: { agentId: 'builder', phase: 'awaiting_input', startedAt: 1, updatedAt: 1 },
        }),
      ],
    });

    const { initAppRail } = await import('../../src/os/app-rail.ts');
    initAppRail(root);

    const badge = root.querySelector('[data-app-id="issues"] .mn-os-app-rail__badge');
    assert.ok(badge, 'issues tile badge element exists');
    await waitFor(() => badge!.textContent === '2');
    assert.equal(badge.textContent, '2');

    // The current workspace's queue drains; only an other-workspace issue remains.
    setIssuesStateForTests({
      version: 2,
      nextId: 3,
      issues: [
        makeIssue({ id: 'ISS-2', workspacePath: OTHER_WS, status: 'triage', source: 'crash' }),
      ],
    });
    emitIssuesChange();

    await waitFor(() => badge!.hidden === true && badge!.textContent === '');
    assert.equal(badge.hidden, true);
    assert.equal(badge.textContent, '');
  });
});
