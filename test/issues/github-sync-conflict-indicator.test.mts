/**
 * GitHub sync conflict markers on the Issues list.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import type { SyncConflict } from '../../src/state/issues-github.ts';

const conflict: SyncConflict = {
  issueId: 'MIN-9',
  number: 9,
  local: {
    title: 'Mine',
    body: 'Local body',
    closed: false,
    labels: [],
  },
  remote: {
    title: 'Theirs',
    body: 'Remote body',
    closed: false,
    labels: [],
  },
};

describe('GitHub sync conflict list indicator', () => {
  afterEach(async () => {
    const mod = await import('../../src/ui/issues-github-section.ts');
    mod.resetGithubSyncConflictsForTests();
  });

  test('hasGithubSyncConflict tracks pending conflicts', async () => {
    const mod = await import('../../src/ui/issues-github-section.ts');
    assert.equal(mod.hasGithubSyncConflict('MIN-9'), false);
    mod.presentGithubSyncConflict(conflict);
    assert.equal(mod.hasGithubSyncConflict('MIN-9'), true);
    assert.equal(mod.hasGithubSyncConflict('MIN-1'), false);
  });

  test('subscribeGithubSyncConflicts fires when conflicts are stored or cleared', async () => {
    const mod = await import('../../src/ui/issues-github-section.ts');
    let calls = 0;
    const unsub = mod.subscribeGithubSyncConflicts(() => {
      calls += 1;
    });

    mod.presentGithubSyncConflict(conflict);
    assert.equal(calls, 1);

    mod.presentGithubSyncConflict({
      ...conflict,
      local: { ...conflict.local, title: 'Still mine' },
    });
    assert.equal(calls, 2);

    unsub();
    mod.presentGithubSyncConflict(conflict);
    assert.equal(calls, 2);
  });

  test('closing one detail leaves the other surface registered for conflicts', async () => {
    const dom = new Window();
    globalThis.document = dom.document as unknown as Document;
    const mod = await import('../../src/ui/issues-github-section.ts');
    const app = document.createElement('aside');
    const sidebar = document.createElement('aside');
    const appHost = document.createElement('div');
    const sidebarHost = document.createElement('div');
    app.append(appHost);
    sidebar.append(sidebarHost);
    document.body.append(app, sidebar);
    mod.registerGithubConflictHost(conflict.issueId, appHost, () => {});
    mod.registerGithubConflictHost(conflict.issueId, sidebarHost, () => {});
    assert.equal(mod.presentGithubSyncConflict(conflict), true);
    assert.match(appHost.textContent ?? '', /Keep mine/);
    assert.match(sidebarHost.textContent ?? '', /Keep mine/);
    mod.clearGithubConflictHost(conflict.issueId, sidebar);
    sidebar.remove();
    appHost.replaceChildren();
    assert.equal(mod.presentGithubSyncConflict(conflict), true);
    assert.match(appHost.textContent ?? '', /Keep mine/);
    mod.clearGithubConflictHost(conflict.issueId, app);
    assert.equal(mod.presentGithubSyncConflict(conflict), false);
    await dom.happyDOM.close();
  });
});
