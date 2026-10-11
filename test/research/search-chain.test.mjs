/**
 * Research searchStructured provider chain and cache behavior.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  buildProviderChain,
  getLastSearchDiscardedUnrelated,
  getLastSearchError,
  getLastSearchProvider,
  searchStructured,
} from '../../server/research/search.js';
import { RESEARCH_CACHE_TTL_MS, getSearch, setSearch } from '../../server/research/cache.js';

describe('buildProviderChain', () => {
  it('deduplicates primary and fallback entries', () => {
    const chain = buildProviderChain('searxng', ['tavily', 'searxng', 'brave']);
    assert.deepEqual(chain, ['searxng', 'tavily', 'brave']);
  });
});

describe('searchStructured', () => {
  /** @type {string | undefined} */
  let tempHome;
  /** @type {typeof globalThis.fetch | undefined} */
  let originalFetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-research-'));
    process.env.MINNOW_HOME = tempHome;
    resetMinnowHomeCache();

    await fs.mkdir(path.join(tempHome, 'research', 'cache'), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, 'tools.json'),
      `${JSON.stringify({
        enabled: {},
        permissions: { default: {} },
        keys: { braveApiKey: '', tavilyApiKey: 'tv-test-key' },
        webSearchProvider: 'duckduckgo',
      })}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(tempHome, 'search.json'),
      `${JSON.stringify({
        provider: 'searxng',
        fallbackChain: ['tavily', 'duckduckgo'],
        searxngUrl: 'http://localhost:18080',
        keys: { braveApiKey: '', tavilyApiKey: 'tv-test-key' },
        resultCount: 5,
      })}\n`,
      'utf8',
    );
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
  });

  it('falls back from empty SearXNG to Tavily', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('localhost:18080')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (url.includes('api.tavily.com')) {
        assert.equal(init?.method, 'POST');
        return Response.json({
          results: [
            {
              title: 'Tavily hit',
              url: 'https://tavily.example/doc',
              content: 'From Tavily',
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const results = await searchStructured('chain fallback test', { useCache: false });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://tavily.example/doc');
    assert.equal(getLastSearchProvider(), 'tavily');
    assert.equal(getLastSearchError(), null);
  });

  it('records lastSearchError when all providers fail', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('duckduckgo.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<html><body>no hits</body></html>',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      };
    };

    const results = await searchStructured('no hits', { useCache: false });
    assert.equal(results.length, 0);
    assert.match(getLastSearchError() ?? '', /No SearXNG results|No Tavily|No DuckDuckGo/);
  });

  it('falls back to Tavily when SearXNG returns a decoy SERP', async () => {
    const decoy = [
      { title: 'Nick Jr. | Homepage', url: 'https://www.nickjr.com/', content: 'Preschool games' },
      { title: 'Convert m to cm', url: 'https://unitconverters.net/', content: 'Length units' },
      { title: 'Booking.com', url: 'https://www.booking.com/', content: 'Hotels and flights' },
      { title: 'Speedtest by Ookla', url: 'https://www.speedtest.net/', content: 'Internet speed' },
    ];

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('localhost:18080')) {
        return { ok: true, status: 200, json: async () => ({ results: decoy }) };
      }
      if (url.includes('api.tavily.com')) {
        return Response.json({
          results: [
            {
              title: 'chokidar v4 watch options',
              url: 'https://github.com/paulmillr/chokidar',
              content: 'chokidar watch options changed in v4',
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const results = await searchStructured('chokidar v4 watch options', { useCache: false });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, 'https://github.com/paulmillr/chokidar');
    assert.equal(getLastSearchProvider(), 'tavily');
    assert.equal(getLastSearchDiscardedUnrelated(), true);
  });

  it('ignores a cached result set that no longer matches its query', async () => {
    const chain = ['searxng', 'tavily', 'duckduckgo'];
    const key = JSON.stringify({ query: 'chokidar v4 watch options', chain, count: 5 });
    await setSearch(key, [
      { title: 'Nick Jr. | Homepage', url: 'https://www.nickjr.com/', snippet: 'Preschool games' },
      { title: 'Convert m to cm', url: 'https://unitconverters.net/', snippet: 'Length units' },
      { title: 'Booking.com', url: 'https://www.booking.com/', snippet: 'Hotels and flights' },
    ]);

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('localhost:18080')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                title: 'chokidar v4 release notes',
                url: 'https://github.com/paulmillr/chokidar/releases',
                content: 'New watch options in v4',
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const results = await searchStructured('chokidar v4 watch options');
    assert.equal(results.length, 1);
    assert.match(results[0].url, /chokidar/);
  });

  it('reads and writes disk search cache with TTL', async () => {
    const key = 'cache-test-key';
    await setSearch(key, [{ title: 'Cached', url: 'https://cached.test', snippet: 'x' }]);
    const hit = await getSearch(key);
    assert.equal(hit?.length, 1);
    assert.equal(hit[0].title, 'Cached');

    const cachePath = path.join(tempHome, 'research', 'cache');
    const files = await fs.readdir(cachePath);
    const cacheFile = files.find((name) => name.startsWith('search-'));
    assert.ok(cacheFile);

    const raw = JSON.parse(await fs.readFile(path.join(cachePath, cacheFile), 'utf8'));
    raw.savedAt = Date.now() - RESEARCH_CACHE_TTL_MS - 1000;
    await fs.writeFile(path.join(cachePath, cacheFile), JSON.stringify(raw), 'utf8');

    const expired = await getSearch(key);
    assert.equal(expired, null);
  });
});
