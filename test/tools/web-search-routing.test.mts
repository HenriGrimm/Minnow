import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SEARCH_CONFIG } from '../../src/config/search-config.ts';
import {
  hasBraveApiKey,
  hasTavilyApiKey,
  normalizeWebSearchProvider,
  resolveWebSearchExecution,
} from '../../src/tools/web-search-routing.ts';
import type { ToolConfig } from '../../src/tools/tool-settings-types.ts';

/** Minimal ToolConfig for routing tests (avoids importing the full defaults graph). */
function config(overrides: Partial<ToolConfig> = {}): ToolConfig {
  const base: ToolConfig = {
    keys: { braveApiKey: '', tavilyApiKey: '' },
    webSearchProvider: 'duckduckgo',
  };
  return {
    ...base,
    ...overrides,
    keys: { ...base.keys, ...overrides.keys },
  };
}

describe('normalizeWebSearchProvider', () => {
  it('keeps known providers', () => {
    assert.equal(normalizeWebSearchProvider('brave'), 'brave');
    assert.equal(normalizeWebSearchProvider('tavily'), 'tavily');
    assert.equal(normalizeWebSearchProvider('duckduckgo'), 'duckduckgo');
  });

  it('falls back to duckduckgo for unknown values', () => {
    assert.equal(normalizeWebSearchProvider('google'), 'duckduckgo');
    assert.equal(normalizeWebSearchProvider(undefined), 'duckduckgo');
  });
});

describe('resolveWebSearchExecution', () => {
  it('routes brave when key is present', () => {
    const route = resolveWebSearchExecution(
      config({
        webSearchProvider: 'brave',
        keys: { braveApiKey: 'brave-test', tavilyApiKey: '' },
      }),
      {},
      false,
    );
    assert.equal(route.kind, 'brave');
  });

  it('errors for brave without key', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'brave' }),
      {},
      true,
    );
    assert.equal(route.kind, 'error');
    if (route.kind === 'error') {
      assert.match(route.message, /Brave/i);
    }
  });

  it('routes tavily when key and server are available', () => {
    const route = resolveWebSearchExecution(
      config({
        webSearchProvider: 'tavily',
        keys: { braveApiKey: '', tavilyApiKey: 'tvly-test' },
      }),
      {},
      true,
    );
    assert.equal(route.kind, 'tavily');
  });

  it('errors for tavily without key', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'tavily' }),
      {},
      true,
    );
    assert.equal(route.kind, 'error');
    if (route.kind === 'error') {
      assert.match(route.message, /Tavily/i);
    }
  });

  it('errors for tavily without server', () => {
    const route = resolveWebSearchExecution(
      config({
        webSearchProvider: 'tavily',
        keys: { braveApiKey: '', tavilyApiKey: 'tvly-test' },
      }),
      {},
      false,
    );
    assert.equal(route.kind, 'error');
    if (route.kind === 'error') {
      assert.match(route.message, /Minnow/i);
    }
  });

  it('routes duckduckgo when server is available', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'duckduckgo' }),
      {},
      true,
    );
    assert.equal(route.kind, 'ddg');
  });

  it('errors for duckduckgo without server', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'duckduckgo' }),
      {},
      false,
    );
    assert.equal(route.kind, 'error');
    if (route.kind === 'error') {
      assert.match(route.message, /DuckDuckGo/i);
    }
  });

  it('does not fall back from tavily to brave when brave key exists', () => {
    const route = resolveWebSearchExecution(
      config({
        webSearchProvider: 'tavily',
        keys: { braveApiKey: 'brave-test', tavilyApiKey: '' },
      }),
      {},
      true,
    );
    assert.equal(route.kind, 'error');
  });

  it('prefers search.json provider over tools.json', () => {
    const route = resolveWebSearchExecution(
      config({
        webSearchProvider: 'brave',
        keys: { braveApiKey: 'brave-test', tavilyApiKey: '' },
      }),
      {},
      true,
      { ...DEFAULT_SEARCH_CONFIG, provider: 'duckduckgo' },
    );
    assert.equal(route.kind, 'ddg');
  });

  it('errors when search.json provider is disabled', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'duckduckgo' }),
      {},
      true,
      { ...DEFAULT_SEARCH_CONFIG, provider: 'disabled' },
    );
    assert.equal(route.kind, 'error');
    if (route.kind === 'error') {
      assert.match(route.message, /disabled/i);
    }
  });

  it('routes searxng when server is available', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'duckduckgo' }),
      {},
      true,
      { ...DEFAULT_SEARCH_CONFIG, provider: 'searxng' },
    );
    assert.equal(route.kind, 'searxng');
  });

  it('errors for searxng without server', () => {
    const route = resolveWebSearchExecution(
      config({ webSearchProvider: 'duckduckgo' }),
      {},
      false,
      { ...DEFAULT_SEARCH_CONFIG, provider: 'searxng' },
    );
    assert.equal(route.kind, 'error');
    if (route.kind === 'error') {
      assert.match(route.message, /SearXNG/i);
      assert.match(route.message, /Minnow/i);
    }
  });
});

describe('hasBraveApiKey / hasTavilyApiKey', () => {
  it('detects brave key from config and args', () => {
    const keys = { braveApiKey: 'x', tavilyApiKey: '' };
    assert.equal(hasBraveApiKey({}, keys), true);
    assert.equal(hasBraveApiKey({ api_key: 'y' }, { braveApiKey: '', tavilyApiKey: '' }), true);
    assert.equal(hasTavilyApiKey({ braveApiKey: '', tavilyApiKey: 'z' }), true);
  });
});
