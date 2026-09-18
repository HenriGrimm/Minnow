/**
 * Peek panel DOM contract: description-first sticky, one header row per rail
 * section, and a body only where the section has content.
 *
 * Cards are injected via `setIssuesStateForTests` so addIssue cannot schedule a
 * persist that hangs the runner waiting on /api.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import type { IssueCard } from '../../src/types.ts';
import { ISSUES_COMPAT_VERSION, ISSUES_SCHEMA_VERSION } from '../../src/types.ts';
import type { Chat, SessionState } from '../../src/types.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';

const { findIssueById, setIssuesStateForTests } = await import('../../src/state/issues-store.ts');
const { closeIssueDetail, openIssueDetail } = await import('../../src/ui/issues-detail.ts');
const { resetIssuesDetailLayoutForTests } = await import('../../src/ui/issues-detail-layout.ts');
const { resetDetailSectionsForTests } = await import('../../src/ui/issues-detail-section.ts');
const { resetGhAvailableCache } = await import('../../src/chat/issues/git-actions.ts');
const { resetIssuesGithubForTests, setIssuesGithubMode } = await import(
  '../../src/state/issues-github.ts'
);
const { setLocalServerAvailableForTests, setToolConfigForTests } = await import(
  '../../src/tools/config.ts'
);
const { defaultToolConfig } = await import('../../src/config/defaults.ts');

const FIXED_NOW = 1_710_000_006_000;

let domWindow: Window | null = null;

function setupDom(): void {
  const window = new Window({ url: 'http://localhost/' });
  domWindow = window;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.Element = window.Element;
  globalThis.SVGElement = window.SVGElement;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  setLocalServerAvailableForTests(false);
  setToolConfigForTests(defaultToolConfig());
  resetIssuesGithubForTests();
  setIssuesGithubMode('off');

  document.body.innerHTML = `
    <main id="issuesView" class="issues-page">
      <div class="issues-shell">
        <div class="issues-body"></div>
      </div>
    </main>
  `;
}

function seedIssues(issues: IssueCard[]): void {
  setIssuesStateForTests({
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 5,
    issues,
    workspaces: {},
  });
}

function headingTexts(root: Element): string[] {
  return [...root.querySelectorAll('.issues-detail__section-title')].map(
    (el) => el.textContent ?? '',
  );
}

/** Count pill beside a rail section's name, or undefined when it has none. */
function sectionCount(root: Element, key: string): string | undefined {
  return (
    root
      .querySelector(`[data-section="${key}"] .issues-detail__row-value`)
      ?.textContent ?? undefined
  );
}

function sectionBody(root: Element, key: string): HTMLElement | null {
  return root.querySelector(`[data-section="${key}"] .issues-detail__section-body`);
}

/** Body children the reader can actually see (latent pickers/fields excluded). */
function visibleBodyChildren(root: Element, key: string): Element[] {
  const body = sectionBody(root, key);
  return [...(body?.children ?? [])].filter((el) => !el.hasAttribute('hidden'));
}

function buttonByLabel(root: Element, label: string): HTMLButtonElement | null {
  return root.querySelector(`button[aria-label="${label}"]`);
}

afterEach(() => {
  closeIssueDetail();
  resetIssuesDetailLayoutForTests();
  resetDetailSectionsForTests();
  resetGhAvailableCache();
  resetIssuesGithubForTests();
  setIssuesStateForTests(null);
  setSessionStateForTests(null);
  domWindow?.close();
  domWindow = null;
});

describe('issues detail display', () => {
  test('empty peek is identity, description, and one row per rail section', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-3',
        type: 'task',
        title: 'test',
        description: '',
        status: 'backlog',
        priority: 'none',
        labels: ['TEST'],
        workspacePath: 'C:/Users/dukky/Projects/getsitdone',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
      },
    ]);

    openIssueDetail('GET-3');

    const sticky = document.querySelector('.issues-detail__sticky');
    const scroll = document.querySelector('.issues-detail__scroll');
    assert.ok(sticky);
    assert.ok(scroll);

    assert.equal(sticky.querySelector('.issues-detail__id')?.textContent, 'GET-3');
    assert.equal(
      sticky.querySelector('.issues-detail__id')?.getAttribute('aria-label'),
      'Copy issue id GET-3',
    );
    assert.equal(
      sticky.querySelector('.issues-detail__close')?.getAttribute('aria-label'),
      'Close issue detail',
    );
    assert.ok(sticky.querySelector('.issues-detail__layout-expand'));
    assert.equal(
      sticky.querySelector('.issues-detail__more')?.getAttribute('aria-label'),
      'Issue actions',
    );
    assert.equal(sticky.querySelector('.issues-detail__delete'), null);
    assert.equal(sticky.querySelectorAll('select').length, 0);
    assert.ok(sticky.querySelector('.issues-detail__prop[aria-label="Type: Task"]'));
    assert.ok(sticky.querySelector('.issues-detail__prop[aria-haspopup="menu"]'));
    const workflowMenus = sticky.querySelectorAll('.issues-workflow-menu-wrap');
    assert.equal(workflowMenus.length, 1);
    assert.equal(workflowMenus[0]?.textContent?.includes('Send to chat'), true);
    assert.equal(sticky.textContent?.includes('Send to background'), false);
    // Priority is a picker like the others, so it carries a glyph too.
    assert.ok(sticky.querySelector('.issues-priority-chip .issues-priority-chip__icon'));

    // Three zones: document, links rail, conversation.
    assert.ok(scroll.querySelector('.issues-detail__doc'));
    assert.ok(scroll.querySelector('.issues-detail__rail'));
    assert.ok(scroll.querySelector('.issues-detail__talk'));

    const titles = headingTexts(scroll);
    assert.equal(titles.includes('Description'), false);
    assert.equal(titles.includes('Plan'), false, 'no plan file, no Plan section');
    assert.equal(titles.includes('Related'), false, 'no refs, no Related section');
    // Everything else is one labelled row, so nothing is an orphan form control.
    for (const heading of ['Code', 'Attachments', 'Git', 'Chats']) {
      assert.ok(titles.includes(heading), `${heading} row is missing`);
    }

    // No counts and no bodies for the sections with nothing in them.
    for (const key of ['code', 'attachments', 'sub-issues', 'chats']) {
      assert.equal(sectionCount(scroll, key), undefined, `${key} should have no count`);
      assert.equal(visibleBodyChildren(scroll, key).length, 0, `${key} body should be latent`);
    }

    const copy = scroll.textContent ?? '';
    assert.equal(copy.includes('No code links yet.'), false);
    assert.equal(copy.includes('No sub-issues yet.'), false);
    assert.equal(copy.includes('No chats yet.'), false);
    assert.equal(copy.includes('No plan yet.'), false);
    assert.equal(copy.includes('No related issues yet.'), false);

    // Add affordances live in the header, and the code field waits behind one.
    assert.ok(buttonByLabel(scroll, 'Add code link'));
    assert.ok(buttonByLabel(scroll, 'Attach files'));
    assert.ok(buttonByLabel(scroll, 'Add a sub-issue'));
    assert.ok(buttonByLabel(scroll, 'Add a chat'));
    const gitActions = buttonByLabel(scroll, 'Git actions');
    assert.ok(gitActions);

    let pasteRow = scroll.querySelector(
      '[data-section="code"] .issues-detail__add-code',
    ) as HTMLElement | null;
    assert.equal(pasteRow, null, 'the paste field is created by +, not always present');
    buttonByLabel(scroll, 'Add code link')?.click();
    pasteRow = scroll.querySelector('[data-section="code"] .issues-detail__add-code');
    assert.ok(pasteRow);
    assert.equal(pasteRow.hidden, false);

    gitActions?.click();
    assert.ok(
      [...document.querySelectorAll('[role="menu"] button')].some(
        (btn) => btn.textContent?.includes('Create branch'),
      ),
    );
    assert.ok(scroll.querySelector('.issues-detail__section--document'));
    assert.ok(scroll.querySelector('.issues-detail__section--meta'));
  });

  test('filled peek counts what a section holds and folds it away on demand', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-4',
        type: 'task',
        title: 'Has body',
        description: 'A real description.',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
        planPath: 'documentation/plans/issues/GET-4.md',
        codeRefs: [{ path: 'src/ui/issues-detail.ts', startLine: 12 }],
        issueRefs: [{ issueId: 'GET-3', kind: 'related', addedAt: FIXED_NOW }],
      },
    ]);

    openIssueDetail('GET-4');

    const scroll = document.querySelector('.issues-detail__scroll');
    assert.ok(scroll);
    const titles = headingTexts(scroll);
    assert.ok(titles.includes('Code'));
    assert.ok(titles.includes('Plan'));
    assert.ok(titles.includes('Related'));
    assert.equal(titles.includes('Description'), false);

    assert.equal(sectionCount(scroll, 'code'), 'issues-detail.ts');
    assert.equal(sectionCount(scroll, 'related'), '1');
    assert.equal(sectionCount(scroll, 'attachments'), undefined);

    // A section with content folds, and the fold survives a re-render.
    const codeLabel = scroll.querySelector(
      '[data-section="code"] button.issues-detail__row',
    ) as HTMLButtonElement | null;
    assert.ok(codeLabel, 'a section with content is collapsible');
    assert.equal(codeLabel.getAttribute('aria-expanded'), 'false');
    codeLabel.click();
    assert.equal(codeLabel.getAttribute('aria-expanded'), 'true');
    assert.equal(sectionBody(scroll, 'code')?.hidden, false);

    openIssueDetail('GET-4');
    const repainted = document.querySelector('.issues-detail__scroll');
    assert.ok(repainted);
    assert.equal(
      repainted
        .querySelector('[data-section="code"] button.issues-detail__row')
        ?.getAttribute('aria-expanded'),
      'true',
      'the fold is remembered across renders',
    );

    // Empty sections still expose an add action, so their row is a button.
    assert.ok(repainted.querySelector('[data-section="attachments"] button.issues-detail__row'));
  });

  test('linked GitHub issue lives in Git, not a second GITHUB block', () => {
    setupDom();
    setIssuesGithubMode('mirror');
    seedIssues([
      {
        id: 'GET-7',
        type: 'task',
        title: 'Linked',
        description: '',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'github',
        github: {
          number: 5,
          url: 'https://github.com/acme/app/issues/5',
          syncedAt: FIXED_NOW,
          localUpdatedAt: FIXED_NOW,
        },
        gitLinks: [
          {
            kind: 'github-issue',
            ref: '#5',
            url: 'https://github.com/acme/app/issues/5',
            title: 'GH issue: #5',
            addedAt: FIXED_NOW,
          },
        ],
      },
    ]);

    openIssueDetail('GET-7');

    const scroll = document.querySelector('.issues-detail__scroll');
    assert.ok(scroll);
    const titles = headingTexts(scroll);
    assert.ok(titles.includes('Git'));
    assert.equal(titles.includes('GitHub'), false);
    const copy = scroll.textContent ?? '';
    assert.equal(copy.includes('Linked to #5'), false);
    assert.equal(copy.includes('GH issue: #5'), false);
    assert.equal(copy.includes('Sync this issue'), false);
    assert.match(copy, /#5/);
    assert.match(copy, /synced/);
    const githubRow = scroll.querySelector('.issues-detail__git-chip--github');
    assert.ok(githubRow);
    assert.ok([...githubRow.querySelectorAll('button')].some((btn) => btn.textContent === 'Open'));
    assert.ok([...githubRow.querySelectorAll('button')].some((btn) => btn.textContent === 'Sync'));
    assert.equal(githubRow.querySelector('a'), null);
    assert.equal(scroll.querySelectorAll('.issues-detail__git-chip').length, 1);
  });

  test('Push to GitHub is in the Git toolbar only when mirror is on and unlinked', () => {
    setupDom();
    setIssuesGithubMode('mirror');
    seedIssues([
      {
        id: 'GET-8',
        type: 'task',
        title: 'Unlinked',
        description: '',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
      },
    ]);

    openIssueDetail('GET-8');

    const scroll = document.querySelector('.issues-detail__scroll');
    assert.ok(scroll);
    assert.ok(headingTexts(scroll).includes('Git'));
    const gitActions = scroll.querySelector(
      '[data-section="git"] .issues-detail__sec-btn[aria-label="Git actions"]',
    ) as HTMLButtonElement | null;
    assert.ok(gitActions);
    gitActions.click();
    assert.ok(
      [...document.querySelectorAll('[role="menu"] button')].some(
        (btn) => btn.textContent?.includes('Push to GitHub'),
      ),
    );
  });

  test('typing a description in peek is written to the store on close', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-3',
        type: 'task',
        title: 'test',
        description: '',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
      },
    ]);

    openIssueDetail('GET-3');
    const para = document.querySelector('.mn-editor__para');
    assert.ok(para);
    para.textContent = 'Repro: save from peek.';
    closeIssueDetail();

    assert.equal(findIssueById('GET-3')?.description, 'Repro: save from peek.');
  });

  test('editing an existing description is written to the store on close', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-4',
        type: 'task',
        title: 'Has body',
        description: 'A real description.',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
      },
    ]);

    openIssueDetail('GET-4');
    const para = document.querySelector('.mn-editor__para');
    assert.ok(para);
    para.textContent = 'Updated description.';
    closeIssueDetail();

    assert.equal(findIssueById('GET-4')?.description, 'Updated description.');
  });

  test('agent comments and activity are rendered, not silently stored', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-5',
        type: 'task',
        title: 'agent reported back',
        description: '',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
        comments: [
          {
            id: 'cmt-1',
            authorKind: 'agent',
            author: 'builder',
            body: 'Found it: **two** parses.',
            createdAt: FIXED_NOW,
          },
        ],
        activity: [
          { id: 'act-1', kind: 'moved', at: FIXED_NOW + 1000, actorKind: 'agent' },
        ],
      },
    ]);

    openIssueDetail('GET-5');

    const comment = document.querySelector('.issues-comment');
    assert.ok(comment, 'an agent comment must be visible in the panel');
    assert.ok(comment.classList.contains('issues-comment--agent'));
    assert.match(comment.textContent ?? '', /builder/);
    assert.match(comment.textContent ?? '', /two/);
    assert.ok(comment.querySelector('strong'), 'comment markdown is rendered');
    assert.ok(document.querySelector('.issues-activity-row'), 'activity is shown too');
    assert.ok(document.querySelector('.issues-comments__input'), 'a composer is offered');
    assert.ok(headingTexts(document.body).includes('Comments'));
    assert.equal(sectionCount(document.body, 'comments'), '1');
  });

  test('an issue with no comments is a labelled Activity row and a composer', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-6',
        type: 'task',
        title: 'quiet',
        description: '',
        status: 'backlog',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
      },
    ]);

    openIssueDetail('GET-6');

    assert.equal(document.querySelector('.issues-comment'), null);
    assert.ok(document.querySelector('.issues-comments__input'));
    const titles = headingTexts(document.body);
    assert.ok(titles.includes('Activity'), 'the composer keeps a name');
    assert.equal(titles.includes('Comments'), false);
    assert.equal(sectionCount(document.body, 'comments'), undefined);
  });

  test('Chats section lists linked sessions and unlinks without deleting the chat', () => {
    setupDom();
    const chat: Chat = {
      id: 'chat-issue-1',
      name: 'Fix header',
      workspacePath: '/repo',
      modelId: '',
      modeId: 'debug',
      history: [],
      historyLoaded: true,
      lastStats: null,
      modelInfo: {},
      updatedAt: FIXED_NOW,
      lastMessageAt: FIXED_NOW,
    };
    const sessions: SessionState = { ...defaultSessionState(), version: 6, activeId: chat.id, chats: [chat] };
    setSessionStateForTests(sessions);
    seedIssues([
      {
        id: 'GET-9',
        type: 'task',
        title: 'Header',
        description: '',
        status: 'todo',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
        chatIds: ['chat-issue-1', 'gone-chat'],
      },
    ]);

    openIssueDetail('GET-9');

    const scroll = document.querySelector('.issues-detail__scroll');
    assert.ok(scroll);
    assert.ok(headingTexts(scroll).includes('Chats'));
    assert.equal(sectionCount(scroll, 'chats'), '2');
    const copy = scroll.textContent ?? '';
    assert.match(copy, /Fix header/);
    assert.match(copy, /Debug/);
    assert.match(copy, /Done/);
    assert.match(copy, /Chat unavailable/);
    assert.ok(buttonByLabel(scroll, 'Add a chat'));

    const removeLive = [...scroll.querySelectorAll('.issues-detail__chat-remove')].find(
      (btn) => btn.getAttribute('aria-label') === 'Remove chat Fix header from this issue',
    );
    assert.ok(removeLive);
    removeLive.click();

    assert.deepEqual(findIssueById('GET-9')?.chatIds, ['gone-chat']);
    assert.equal(sessions.chats.some((row) => row.id === 'chat-issue-1'), true);
  });

  test('empty Chats section is one row with a + control', () => {
    setupDom();
    seedIssues([
      {
        id: 'GET-10',
        type: 'task',
        title: 'Fresh',
        description: '',
        status: 'todo',
        priority: 'none',
        labels: [],
        workspacePath: '/repo',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        source: 'user',
      },
    ]);

    openIssueDetail('GET-10');
    const scroll = document.querySelector('.issues-detail__scroll');
    assert.ok(scroll);
    assert.ok(headingTexts(scroll).includes('Chats'));
    assert.equal(scroll.textContent?.includes('No chats yet.'), false);
    assert.equal(sectionCount(scroll, 'chats'), undefined);
    assert.equal(visibleBodyChildren(scroll, 'chats').length, 0);
    assert.ok(buttonByLabel(scroll, 'Add a chat'));
  });
});
