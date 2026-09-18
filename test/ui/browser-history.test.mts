import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  BROWSER_HISTORY_STORAGE_KEY,
  clearBrowserHistory,
  listBrowserHistory,
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeHistoryUrl,
  recordBrowserTitle,
  recordBrowserVisit,
  removeBrowserHistoryEntry,
  resetBrowserHistoryForTests,
  suggestBrowserUrls,
} from '../../src/ui/browser-history.ts';
import { resetFilePanelStateForTests } from '../../src/state/file-panel.ts';
import {
  openPreviewTab,
  resetPreviewTabStoreForTests,
  setPreviewTabTitle,
  updatePreviewTabSource,
} from '../../src/ui/preview-tab-store.ts';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const NOW = Date.UTC(2026, 8, 18, 12);
const DAY = 24 * 60 * 60 * 1000;

describe('browser-history', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
    resetBrowserHistoryForTests();
  });

  afterEach(() => {
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    resetBrowserHistoryForTests();
  });

  test('normalizeHistoryUrl keeps web/file URLs and drops fragments and credentials', () => {
    assert.equal(normalizeHistoryUrl('https://user:pw@example.com/a#top'), 'https://example.com/a');
    assert.equal(normalizeHistoryUrl('file:///C:/site/index.html'), 'file:///C:/site/index.html');
    assert.equal(normalizeHistoryUrl('about:blank'), null);
    assert.equal(normalizeHistoryUrl('chrome-error://chromewebdata/'), null);
    assert.equal(normalizeHistoryUrl('index.html'), null);
  });

  test('repeat visits bump the count, titles attach, and it survives a reload', () => {
    recordBrowserVisit('https://example.com/', NOW - DAY);
    recordBrowserVisit('https://example.com/#section', NOW);
    recordBrowserTitle('https://example.com/', 'Example Domain');

    resetBrowserHistoryForTests();
    const [entry] = listBrowserHistory();
    assert.equal(entry.url, 'https://example.com/');
    assert.equal(entry.visitCount, 2);
    assert.equal(entry.lastVisitedAt, NOW);
    assert.equal(entry.title, 'Example Domain');
  });

  test('suggestions rank URL prefixes over title and substring matches', () => {
    recordBrowserVisit('https://docs.github.com/en/actions', NOW);
    recordBrowserVisit('https://github.com/', NOW);
    recordBrowserVisit('https://www.example.com/github-tips', NOW);
    recordBrowserVisit('https://news.ycombinator.com/', NOW);
    recordBrowserTitle('https://news.ycombinator.com/', 'Hacker News');

    const urls = suggestBrowserUrls('git', 8, NOW).map((e) => e.url);
    assert.equal(urls[0], 'https://github.com/');
    assert.ok(urls.includes('https://docs.github.com/en/actions'));
    assert.ok(!urls.includes('https://news.ycombinator.com/'));

    assert.deepEqual(
      suggestBrowserUrls('hacker', 8, NOW).map((e) => e.url),
      ['https://news.ycombinator.com/'],
    );
    // www. and scheme are ignored when matching what was typed.
    assert.equal(suggestBrowserUrls('www.example', 8, NOW)[0]?.url, 'https://www.example.com/github-tips');
    // Every term must match.
    assert.deepEqual(suggestBrowserUrls('github actions', 8, NOW).map((e) => e.url), [
      'https://docs.github.com/en/actions',
    ]);
  });

  test('empty query favours frequent, recent pages', () => {
    recordBrowserVisit('https://old.test/', NOW - 60 * DAY);
    for (let i = 0; i < 5; i++) recordBrowserVisit('https://often.test/', NOW - i * 1000);
    recordBrowserVisit('https://once.test/', NOW);
    assert.deepEqual(suggestBrowserUrls('', 2, NOW).map((e) => e.url), [
      'https://often.test/',
      'https://once.test/',
    ]);
  });

  test('remove and clear forget entries', () => {
    recordBrowserVisit('https://a.test/', NOW);
    recordBrowserVisit('https://b.test/', NOW);
    removeBrowserHistoryEntry('https://a.test/');
    assert.deepEqual(listBrowserHistory().map((e) => e.url), ['https://b.test/']);
    clearBrowserHistory();
    assert.equal(listBrowserHistory().length, 0);
    assert.equal(globalThis.localStorage.getItem(BROWSER_HISTORY_STORAGE_KEY), '[]');
  });

  test('history is capped, keeping the most recent pages', () => {
    for (let i = 0; i <= MAX_BROWSER_HISTORY_ENTRIES; i++) {
      recordBrowserVisit(`https://site${i}.test/`, NOW + i);
    }
    const all = listBrowserHistory();
    assert.equal(all.length, MAX_BROWSER_HISTORY_ENTRIES);
    assert.ok(!all.some((e) => e.url === 'https://site0.test/'));
  });

  test('corrupt storage starts empty instead of throwing', () => {
    globalThis.localStorage.setItem(BROWSER_HISTORY_STORAGE_KEY, '{not json');
    resetBrowserHistoryForTests();
    assert.deepEqual(listBrowserHistory(), []);
  });

  describe('preview tab integration', () => {
    beforeEach(() => {
      resetPreviewTabStoreForTests();
      resetFilePanelStateForTests();
      globalThis.fetch = (async () =>
        ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
    });

    test('tab navigations record one visit per URL change, plus the page title', () => {
      const tab = openPreviewTab({ kind: 'url', url: 'https://a.test/' });
      assert.ok(tab);
      // Address-bar load followed by the guest's own navigation event: one visit.
      updatePreviewTabSource(tab.id, { kind: 'url', url: 'https://a.test/' });
      updatePreviewTabSource(tab.id, { kind: 'url', url: 'https://b.test/' });
      updatePreviewTabSource(tab.id, { kind: 'workspace', path: 'index.html' });
      setPreviewTabTitle(tab.id, 'Ignored for workspace files');
      updatePreviewTabSource(tab.id, { kind: 'url', url: 'https://a.test/' });
      setPreviewTabTitle(tab.id, 'Site A');

      const byUrl = new Map(listBrowserHistory().map((e) => [e.url, e]));
      assert.equal(byUrl.size, 2);
      assert.equal(byUrl.get('https://a.test/')?.visitCount, 2);
      assert.equal(byUrl.get('https://a.test/')?.title, 'Site A');
      assert.equal(byUrl.get('https://b.test/')?.visitCount, 1);
    });
  });
});
