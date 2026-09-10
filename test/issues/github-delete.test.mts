import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  getIssuesGithubDeleteBehavior,
  resetIssuesGithubForTests,
} from '../../src/state/issues-github.ts';
import {
  findIssueById,
  setIssuesStateForTests,
} from '../../src/state/issues-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import type { IssueCard } from '../../src/types.ts';

const originalFetch = globalThis.fetch;
let domWindow: Window | null = null;

function card(): IssueCard {
  return {
    id: 'MIN-1',
    type: 'task',
    title: 'Linked issue',
    description: '',
    status: 'todo',
    priority: 'none',
    labels: [],
    workspacePath: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    github: {
      number: 12,
      url: 'https://github.com/acme/app/issues/12',
      syncedAt: 1,
    },
  } as IssueCard;
}

async function setup(): Promise<void> {
  const win = new Window({ url: 'http://localhost/' });
  domWindow = win;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.document = win.document;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.localStorage = win.localStorage;
  setLocalServerAvailableForTests(true);
  resetIssuesGithubForTests();
  setIssuesStateForTests({ version: 2, nextId: 2, issues: [card()], workspaces: {} });
  const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
  resetAppDialogForTests();
}

async function waitForButton(action: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-dialog-action="${action}"]`,
    );
    if (button) return button;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for dialog action ${action}`);
}

beforeEach(setup);

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
  setLocalServerAvailableForTests(false);
  resetIssuesGithubForTests();
  const { resetAppDialogForTests } = await import('../../src/ui/app-dialog.ts');
  resetAppDialogForTests();
  domWindow?.close();
  domWindow = null;
});

describe('linked GitHub issue deletion', () => {
  test('local-only can be remembered from the delete popup', async () => {
    const { confirmAndDeleteIssues } = await import('../../src/ui/issues-delete.ts');
    const deletion = confirmAndDeleteIssues(['MIN-1']);
    await Promise.resolve();

    assert.match(document.body.textContent ?? '', /Delete GitHub issue #12 too/);
    const remember = document.querySelector<HTMLInputElement>('#appDialogRemember');
    assert.ok(remember);
    remember.checked = true;
    document.querySelector<HTMLButtonElement>('[data-dialog-action="local"]')?.click();

    assert.deepEqual(await deletion, { deletedIds: ['MIN-1'], failedIds: [] });
    assert.equal(findIssueById('MIN-1'), undefined);
    assert.equal(getIssuesGithubDeleteBehavior(), 'local');
  });

  test('delete everywhere waits for GitHub before removing the local card', async () => {
    let requestedOp = '';
    globalThis.fetch = async (_input, init) => {
      assert.ok(findIssueById('MIN-1'));
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string };
      requestedOp = body.op ?? '';
      return new Response(JSON.stringify({ ok: true, number: 12 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { confirmAndDeleteIssues } = await import('../../src/ui/issues-delete.ts');
    const deletion = confirmAndDeleteIssues(['MIN-1']);
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>('[data-dialog-action="github"]')?.click();

    assert.deepEqual(await deletion, { deletedIds: ['MIN-1'], failedIds: [] });
    assert.equal(requestedOp, 'issueDelete');
    assert.equal(findIssueById('MIN-1'), undefined);
  });

  test('a GitHub failure keeps the local card', async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: false, error: 'permission denied' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );

    const { confirmAndDeleteIssues } = await import('../../src/ui/issues-delete.ts');
    const deletion = confirmAndDeleteIssues(['MIN-1']);
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>('[data-dialog-action="github"]')?.click();
    (await waitForButton('ok')).click();

    assert.deepEqual(await deletion, { deletedIds: [], failedIds: ['MIN-1'] });
    assert.ok(findIssueById('MIN-1'));
  });
});
