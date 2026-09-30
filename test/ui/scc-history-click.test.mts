import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
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
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousLocalStorage = globalThis.localStorage;
  const previousFetch = globalThis.fetch;
  let failShowOnce = false;

  beforeEach(() => {
    browser = new Window({ url: 'http://localhost/' });
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
    browser.close();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousLocalStorage });
    globalThis.fetch = previousFetch;
    setLocalServerAvailableForTests(false);
  });

  test('selects the commit and opens its first file diff in the detail column', async () => {
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

    const commit = view.root.querySelector<HTMLElement>(`.git-graph__row[data-sha='${sha}']`);
    assert.ok(commit);
    commit.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(view.root.querySelector('.scc-commit-detail__subject')?.textContent, 'Fix example');
    assert.equal(view.root.querySelector('.scc-commit-file__row')?.getAttribute('aria-expanded'), 'true');
    assert.equal(view.root.querySelector<HTMLElement>('.scc-commit-file__diff')?.hidden, false);
    assert.match(view.root.querySelector('.scc-commit-file__diff')?.textContent ?? '', /after/);
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
    view.root.querySelector<HTMLElement>(`.git-graph__row[data-sha='${sha}']`)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(view.root.querySelector('.scc-error')?.textContent ?? '', /Temporary failure/);

    view.root.querySelector<HTMLButtonElement>('.scc-error button')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(view.root.querySelector('.scc-commit-detail__subject')?.textContent, 'Fix example');
    view.destroy();
  });
});
