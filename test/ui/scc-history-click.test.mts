import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { spatialTestDom } from './spatial-test-dom.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';

const sha = 'a'.repeat(40);
const patch = `diff --git a/example.txt b/example.txt
index 1111111..2222222 100644
--- a/example.txt
+++ b/example.txt
@@ -1 +1 @@
-before
+after
`;

const { createHistoryView } = await import('../../src/ui/scc-history.ts');

describe('Source Control history commit click', () => {
  let browser: Window;
  let dom: ReturnType<typeof spatialTestDom>;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousLocalStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  let failShowOnce = false;

  beforeEach(() => {
    dom = spatialTestDom();
    browser = dom.browser;
    globalThis.window = browser as unknown as Window & typeof globalThis;
    globalThis.document = browser.document as unknown as Document;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: browser.localStorage });
    browser.open = () => { throw new Error('Commit click must stay in Source Control'); };
    setLocalServerAvailableForTests(true);
    failShowOnce = false;
    globalThis.fetch = async (_url, init) => {
      const op = JSON.parse(String(init?.body)).op;
      if (op === 'show' && failShowOnce) {
        failShowOnce = false;
        return { ok: true, json: async () => ({ ok: false, error: 'Temporary failure' }) } as Response;
      }
      const result = op === 'log'
        ? { ok: true, commits: [{ hash: sha, parents: [], subject: 'Fix example', author: 'Tester', relativeTime: 'now', refs: ['HEAD -> main'] }] }
        : op === 'show'
          ? { ok: true, stdout: `commit ${sha}\nAuthor: Tester\nDate:   Today\n\n    Fix example\n\n${patch}`, patch, files: [{ path: 'example.txt', status: 'M' }] }
          : { ok: false, error: `Unexpected git op: ${op}` };
      return { ok: true, json: async () => result } as Response;
    };
  });

  afterEach(() => {
    dom.destroy();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousLocalStorage });
    globalThis.fetch = previousFetch;
    setLocalServerAvailableForTests(false);
  });

  test('selects the commit and opens its first side-by-side file diff below the map', async () => {
    const view = createHistoryView({
      getCwd: () => undefined,
      getBranch: () => 'main',
      refreshAll: async () => {},
      refreshSection: async () => {},
      goTo: () => {},
      setBadge: () => {},
    });
    document.body.appendChild(view.root);
    await view.refresh();

    const commit = view.root.querySelector<HTMLElement>(`.git-history-map__node[data-sha='${sha}']`);
    assert.ok(commit);
    commit.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(view.root.querySelector('.scc-commit-detail__subject')?.textContent, 'Fix example');
    assert.equal(view.root.querySelector('[role="tab"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(view.root.querySelector('.sbs-diff__cell--left.sbs-diff__cell--remove')?.textContent, 'before');
    assert.equal(view.root.querySelector('.sbs-diff__cell--right.sbs-diff__cell--add')?.textContent, 'after');
    assert.equal(view.root.firstElementChild?.className, 'scc-history__graph-col');
    assert.equal(view.root.lastElementChild?.className, 'scc-history__detail-col');
    assert.equal(view.root.querySelector('.scc-commit-file__row'), null, 'file patches are not accordions');
    view.destroy();
  });

  test('Retry reloads a selected commit after a transient git error', async () => {
    failShowOnce = true;
    const view = createHistoryView({
      getCwd: () => undefined,
      getBranch: () => 'main',
      refreshAll: async () => {},
      refreshSection: async () => {},
      goTo: () => {},
      setBadge: () => {},
    });
    document.body.appendChild(view.root);
    await view.refresh();
    view.root.querySelector<HTMLElement>(`.git-history-map__node[data-sha='${sha}']`)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(view.root.querySelector('.scc-error')?.textContent ?? '', /Temporary failure/);

    view.root.querySelector<HTMLButtonElement>('.scc-error button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(view.root.querySelector('.scc-commit-detail__subject')?.textContent, 'Fix example');
    view.destroy();
  });

  test('rapid A to B to A selection ignores older detail responses and does not reload history', async () => {
    const other = 'b'.repeat(40);
    let logs = 0;
    const pending: Array<{ sha: string; resolve: (value: Response) => void }> = [];
    globalThis.fetch = async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      if (input.op === 'log') {
        logs++;
        return { ok: true, json: async () => ({ ok: true, commits: [sha, other].map((hash) => ({ hash, parents: [], subject: hash, author: 'Tester', relativeTime: 'now', refs: [] })) }) } as Response;
      }
      return new Promise((resolve) => pending.push({ sha: input.sha, resolve }));
    };
    const view = createHistoryView({ getCwd: () => undefined, getBranch: () => 'main', refreshAll: async () => {}, refreshSection: async () => {}, goTo() {}, setBadge() {} });
    document.body.append(view.root);
    await view.refresh();
    const click = (hash: string) => view.root.querySelector<HTMLButtonElement>(`.git-history-map__node[data-sha="${hash}"]`)!.click();
    const reply = (index: number, subject: string) => pending[index].resolve({ ok: true, json: async () => ({ ok: true, stdout: `commit ${pending[index].sha}\nAuthor: Tester\nDate: Today\n\n    ${subject}\n`, patch, files: [] }) } as Response);
    const before = logs;
    click(sha); click(other); click(sha);
    reply(2, 'Latest A');
    await new Promise((resolve) => setTimeout(resolve, 0));
    reply(0, 'Old A'); reply(1, 'Late B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(view.root.querySelector('.scc-commit-detail__subject')?.textContent, 'Latest A');
    assert.equal(logs, before);
    view.destroy();
  });

  test('file tabs share Code diff wrapping, support arrow keys and survive background refresh', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (JSON.parse(String(init?.body)).op === 'log') return originalFetch(url, init);
      return { ok: true, json: async () => ({ ok: true,
        stdout: `commit ${sha}\nAuthor: Tester\nDate: Today\n\n    Two files\n`,
        patch: patch + patch.replaceAll('example.txt', 'other.txt').replace('-before', '-old second').replace('+after', '+new second'),
        files: [],
      }) } as Response;
    };
    const view = createHistoryView({ getCwd: () => undefined, getBranch: () => 'main', refreshAll: async () => {}, refreshSection: async () => {}, goTo() {}, setBadge() {} });
    document.body.append(view.root);
    await view.refresh();
    view.root.querySelector<HTMLButtonElement>(`.git-history-map__node[data-sha="${sha}"]`)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tabs = [...view.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.equal(tabs.length, 2);
    tabs[0].focus();
    tabs[0].dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement === tabs[1], true);
    assert.match(view.root.querySelector('[role="tabpanel"]')?.textContent ?? '', /new second/);
    const mount = view.root.querySelector<HTMLElement>('.sbs-diff')!;
    assert.equal(mount.classList.contains('sbs-diff--wrap'), true);
    view.root.querySelector<HTMLButtonElement>('[title="Toggle word wrap in commit diff"]')!.click();
    assert.equal(mount.classList.contains('sbs-diff--wrap'), false);
    assert.equal(localStorage.getItem('minnow.gitCommitDiffWordWrap'), '0');
    await view.refresh();
    assert.equal(view.root.querySelector('.sbs-diff') === mount, true, 'polling leaves review and its selected file intact');
    view.root.querySelector<HTMLButtonElement>('[title="Close commit review"]')!.click();
    assert.equal(view.root.querySelector<HTMLElement>('.scc-history__detail-col')!.hidden, true);
    view.destroy();
  });

  test('empty merge commits and binary changes remain reviewable in both history views', async () => {
    const originalFetch = globalThis.fetch;
    for (const binary of [false, true]) {
      globalThis.fetch = async (url, init) => {
        if (JSON.parse(String(init?.body)).op === 'log') return originalFetch(url, init);
        return { ok: true, json: async () => ({ ok: true,
          stdout: `commit ${sha}\nMerge: 1111111 2222222\nAuthor: Tester\nDate: Today\n\n    Merge example\n`,
          patch: binary ? 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n' : '',
          files: binary ? [{ path: 'image.png', status: 'M' }] : [],
        }) } as Response;
      };
      const view = createHistoryView({ getCwd: () => undefined, getBranch: () => 'main', refreshAll: async () => {}, refreshSection: async () => {}, goTo() {}, setBadge() {} });
      document.body.append(view.root);
      await view.refresh();
      const listSwitch = [...view.root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'List')!;
      listSwitch.click();
      view.root.querySelector<HTMLButtonElement>(`.git-history-map__list-row[data-sha="${sha}"]`)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(view.root.querySelector('.scc-commit-detail__subject')?.textContent, 'Merge example');
      assert.match(view.root.querySelector('.scc-history__detail-col')?.textContent ?? '', binary ? /Binary file changed/ : /No file changes/);
      view.destroy();
      localStorage.removeItem('minnow.git-history.view');
    }
  });
});
