/**
 * Unit tests for session-scoped tool result cache.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import {
  buildCacheKey,
  clearCacheScope,
  executeWithResultCache,
  getCachePolicyForTool,
  getCachedResult,
  invalidateAfterTool,
  invalidateCachedDirectoryListings,
  isErrorToolResult,
  normalizeToolArgs,
  changedPathAffectsDirectoryListing,
  pathMatchesBustPrefix,
  bindWorkspacePathForToolCache,
  getCacheScope,
  resetResultCacheForTests,
  setCachedResult,
  setResultCacheNowForTests,
} from '../../src/tools/result-cache.ts';

beforeEach(() => {
  resetResultCacheForTests();
  bindWorkspacePathForToolCache(() => '/test-workspace');
});

function testScope(): string {
  return getCacheScope({});
}

// ── normalizeToolArgs / ──────────────────────────────────────────────────────

describe('normalizeToolArgs / buildCacheKey', () => {
  test('same args with different key order produce the same cache key', () => {
    const a = normalizeToolArgs('read_file', { path: 'src/a.ts' });
    const b = normalizeToolArgs('read_file', { path: 'src/a.ts' });
    assert.equal(buildCacheKey('read_file', a), buildCacheKey('read_file', b));
  });

  test('path trim and ./ normalization produce the same key', () => {
    const a = normalizeToolArgs('read_file', { path: './src/a.ts' });
    const b = normalizeToolArgs('read_file', { path: 'src/a.ts' });
    assert.equal(buildCacheKey('read_file', a), buildCacheKey('read_file', b));
  });
});

// ── cache hit/miss ───────────────────────────────────────────────────────────

describe('cache hit/miss', () => {
  test('cache hit invokes inner only once', async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return { content: 'file-body' };
    };

    const args = { path: 'src/foo.ts' };
    const r1 = await executeWithResultCache('read_file', args, {}, inner);
    const r2 = await executeWithResultCache('read_file', args, {}, inner);

    assert.equal(calls, 1);
    assert.equal(r1.content, 'file-body');
    assert.equal(r2.content, 'file-body');
  });

  test('error results are not stored', async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return { content: 'Error: not found' };
    };

    await executeWithResultCache('read_file', { path: 'missing.ts' }, {}, inner);
    await executeWithResultCache('read_file', { path: 'missing.ts' }, {}, inner);

    assert.equal(calls, 2);
    assert.equal(isErrorToolResult({ content: 'Error: not found' }), true);
  });

  test('non-cacheable tools always invoke inner', async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return { content: 'ok' };
    };

    await executeWithResultCache('execute_command', { command: 'echo hi' }, {}, inner);
    await executeWithResultCache('execute_command', { command: 'echo hi' }, {}, inner);

    assert.equal(calls, 2);
    assert.equal(getCachePolicyForTool('execute_command').cacheable, false);
    assert.equal(getCachePolicyForTool('get_lsp_diagnostics').cacheable, false);
  });
});

// ── invalidation ─────────────────────────────────────────────────────────────

describe('invalidation', () => {
  test('save_file busts read_file for the same path', async () => {
    const policy = getCachePolicyForTool('read_file');
    const normalized = normalizeToolArgs('read_file', { path: 'src/foo.ts' });
    const key = buildCacheKey('read_file', normalized);

    const scope = testScope();
    setCachedResult(scope, key, { content: 'stale' }, policy);
    assert.equal(getCachedResult(scope, key)?.content, 'stale');

    invalidateAfterTool(
      scope,
      'save_file',
      { path: 'src/foo.ts' },
      { content: 'saved' },
    );

    assert.equal(getCachedResult(scope, key), undefined);
  });

  test('execute_command busts cached file and git reads', () => {
    const scope = testScope();
    const readKey = buildCacheKey(
      'read_file',
      normalizeToolArgs('read_file', { path: 'src/foo.ts' }),
    );
    const gitKey = buildCacheKey('git_status', normalizeToolArgs('git_status', {}));
    setCachedResult(scope, readKey, { content: 'pre-format' }, getCachePolicyForTool('read_file'));
    setCachedResult(scope, gitKey, { content: 'stale' }, getCachePolicyForTool('git_status'));

    invalidateAfterTool(
      scope,
      'execute_command',
      { command: 'npx prettier --write src/foo.ts' },
      { content: 'done' },
    );

    assert.equal(getCachedResult(scope, readKey), undefined);
    assert.equal(getCachedResult(scope, gitKey), undefined);
  });

  for (const shellTool of ['run_javascript', 'run_python', 'start_background_command']) {
    test(`${shellTool} busts cached reads`, () => {
      const scope = testScope();
      const readKey = buildCacheKey(
        'read_file',
        normalizeToolArgs('read_file', { path: 'src/foo.ts' }),
      );
      setCachedResult(scope, readKey, { content: 'stale' }, getCachePolicyForTool('read_file'));

      invalidateAfterTool(scope, shellTool, {}, { content: 'ok' });

      assert.equal(getCachedResult(scope, readKey), undefined);
    });
  }

  test('mcp and plugin tools bust cached reads', () => {
    for (const toolName of ['mcp__server__write_thing', 'plugin__pkg__edit']) {
      const scope = testScope();
      const readKey = buildCacheKey(
        'read_file',
        normalizeToolArgs('read_file', { path: 'src/foo.ts' }),
      );
      setCachedResult(scope, readKey, { content: 'stale' }, getCachePolicyForTool('read_file'));

      invalidateAfterTool(scope, toolName, {}, { content: 'ok' });

      assert.equal(getCachedResult(scope, readKey), undefined, toolName);
    }
  });

  test('a failed shell command leaves the cache intact', () => {
    const scope = testScope();
    const readKey = buildCacheKey(
      'read_file',
      normalizeToolArgs('read_file', { path: 'src/foo.ts' }),
    );
    setCachedResult(scope, readKey, { content: 'body' }, getCachePolicyForTool('read_file'));

    invalidateAfterTool(
      scope,
      'execute_command',
      { command: 'nope' },
      { content: 'Error: command not found' },
    );

    assert.equal(getCachedResult(scope, readKey)?.content, 'body');
  });

  test('read-only shell tools do not bust the cache', () => {
    const scope = testScope();
    const readKey = buildCacheKey(
      'read_file',
      normalizeToolArgs('read_file', { path: 'src/foo.ts' }),
    );
    setCachedResult(scope, readKey, { content: 'body' }, getCachePolicyForTool('read_file'));

    invalidateAfterTool(scope, 'list_running_commands', {}, { content: 'none' });

    assert.equal(getCachedResult(scope, readKey)?.content, 'body');
  });

  test('save_file busts cached git_status', () => {
    const policy = getCachePolicyForTool('git_status');
    const gitKey = buildCacheKey('git_status', normalizeToolArgs('git_status', {}));

    const scope = testScope();
    setCachedResult(scope, gitKey, { content: 'stale porcelain' }, policy);
    assert.equal(getCachedResult(scope, gitKey)?.content, 'stale porcelain');

    invalidateAfterTool(
      scope,
      'save_file',
      { path: 'new-untracked.ts' },
      { content: 'saved' },
    );

    assert.equal(getCachedResult(scope, gitKey), undefined);
  });

  test('move_file busts list_directory for parent folders', () => {
    const policy = getCachePolicyForTool('list_directory');
    const srcListingKey = buildCacheKey(
      'list_directory',
      normalizeToolArgs('list_directory', { path: 'src' }),
    );
    const rootListingKey = buildCacheKey(
      'list_directory',
      normalizeToolArgs('list_directory', { path: '.' }),
    );

    const scope = testScope();
    setCachedResult(scope, srcListingKey, { content: 'dirs: \nfiles: a.ts' }, policy);
    setCachedResult(scope, rootListingKey, { content: 'dirs: src\nfiles: ' }, policy);

    invalidateAfterTool(
      scope,
      'move_file',
      { source: 'src/a.ts', destination: 'src/b.ts' },
      { content: 'moved' },
    );

    assert.equal(getCachedResult(scope, srcListingKey), undefined);
    assert.equal(getCachedResult(scope, rootListingKey), undefined);
  });

  test('save_file in chat scope busts list_directory in __no_chat__ scope', () => {
    const policy = getCachePolicyForTool('list_directory');
    const listingKey = buildCacheKey(
      'list_directory',
      normalizeToolArgs('list_directory', { path: '.' }),
    );

    const chatScope = '/test-workspace:chat-abc';
    const treeScope = '/test-workspace:__no_chat__';
    setCachedResult(treeScope, listingKey, { content: 'dirs: \nfiles: old.ts' }, policy);
    setCachedResult(chatScope, listingKey, { content: 'dirs: \nfiles: old.ts' }, policy);

    invalidateAfterTool(
      chatScope,
      'save_file',
      { path: 'new.ts' },
      { content: 'saved' },
    );

    assert.equal(getCachedResult(treeScope, listingKey), undefined);
    assert.equal(getCachedResult(chatScope, listingKey), undefined);
  });

  test('move_file busts read_file for source and destination', () => {
    const policy = getCachePolicyForTool('read_file');
    const srcKey = buildCacheKey(
      'read_file',
      normalizeToolArgs('read_file', { path: 'old/a.ts' }),
    );
    const destKey = buildCacheKey(
      'read_file',
      normalizeToolArgs('read_file', { path: 'new/a.ts' }),
    );

    const scope = testScope();
    setCachedResult(scope, srcKey, { content: 'a' }, policy);
    setCachedResult(scope, destKey, { content: 'b' }, policy);

    invalidateAfterTool(
      scope,
      'move_file',
      { source: 'old/a.ts', destination: 'new/a.ts' },
      { content: 'moved' },
    );

    assert.equal(getCachedResult(scope, srcKey), undefined);
    assert.equal(getCachedResult(scope, destKey), undefined);
  });
});

// ── invalidateCachedDirectoryListings ────────────────────────────────────────

describe('invalidateCachedDirectoryListings', () => {
  test('removes list_directory and find_files in one workspace only', () => {
    const listPolicy = getCachePolicyForTool('list_directory');
    const findPolicy = getCachePolicyForTool('find_files');
    const readPolicy = getCachePolicyForTool('read_file');

    const scopeA = '/ws-a:__no_chat__';
    const scopeB = '/ws-b:__no_chat__';
    const listKey = buildCacheKey(
      'list_directory',
      normalizeToolArgs('list_directory', { path: '.' }),
    );
    const findKey = buildCacheKey(
      'find_files',
      normalizeToolArgs('find_files', { path: '.', pattern: '*.ts' }),
    );
    const readKey = buildCacheKey(
      'read_file',
      normalizeToolArgs('read_file', { path: 'a.ts' }),
    );

    setCachedResult(scopeA, listKey, { content: 'listing' }, listPolicy);
    setCachedResult(scopeA, findKey, { content: 'found' }, findPolicy);
    setCachedResult(scopeA, readKey, { content: 'body' }, readPolicy);
    setCachedResult(scopeB, listKey, { content: 'other ws' }, listPolicy);

    invalidateCachedDirectoryListings('/ws-a');

    assert.equal(getCachedResult(scopeA, listKey), undefined);
    assert.equal(getCachedResult(scopeA, findKey), undefined);
    assert.equal(getCachedResult(scopeA, readKey)?.content, 'body');
    assert.equal(getCachedResult(scopeB, listKey)?.content, 'other ws');
  });
});

// ── TTL and scope clear ──────────────────────────────────────────────────────

describe('TTL and scope clear', () => {
  test('TTL expiry causes miss after ttlMs', () => {
    const policy = { cacheable: true, ttlMs: 100 };
    const key = buildCacheKey('git_branch', normalizeToolArgs('git_branch', {}));

    setResultCacheNowForTests(1_000);
    const scope = testScope();
    setCachedResult(scope, key, { content: 'diag' }, policy);
    assert.equal(getCachedResult(scope, key)?.content, 'diag');

    setResultCacheNowForTests(1_150);
    assert.equal(getCachedResult(scope, key), undefined);
  });

  test('clearCacheScope removes all entries for scope', () => {
    const policy = getCachePolicyForTool('read_file');
    const key = buildCacheKey('read_file', normalizeToolArgs('read_file', { path: 'a.ts' }));
    const scope = testScope();
    setCachedResult(scope, key, { content: 'x' }, policy);
    clearCacheScope(scope);
    assert.equal(getCachedResult(scope, key), undefined);
  });
});

// ── getCacheScope workspaceRoot ──────────────────────────────────────────────

describe('getCacheScope workspaceRoot override', () => {
  test('scopes list_directory separately per workspaceRoot', async () => {
    bindWorkspacePathForToolCache(() => '/code-workspace');
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return { content: `listing-${calls}` };
    };
    const args = { path: '.' };

    const scopeA = getCacheScope({ workspaceRoot: '/desktop/a' });
    const scopeB = getCacheScope({ workspaceRoot: '/desktop/b' });
    assert.notEqual(scopeA, scopeB);

    const rA1 = await executeWithResultCache('list_directory', args, { workspaceRoot: '/desktop/a' }, inner);
    const rB1 = await executeWithResultCache('list_directory', args, { workspaceRoot: '/desktop/b' }, inner);
    const rA2 = await executeWithResultCache('list_directory', args, { workspaceRoot: '/desktop/a' }, inner);

    assert.equal(calls, 2);
    assert.equal(rA1.content, 'listing-1');
    assert.equal(rB1.content, 'listing-2');
    assert.equal(rA2.content, 'listing-1');
  });

  test('falls back to bound workspace when workspaceRoot is omitted', () => {
    bindWorkspacePathForToolCache(() => '/code-workspace');
    assert.equal(getCacheScope({}), '/code-workspace:__no_chat__');
  });
});

// ── changedPathAffectsDirectoryListing ───────────────────────────────────────

describe('changedPathAffectsDirectoryListing', () => {
  test('parent listing invalidates when child file changes', () => {
    assert.equal(changedPathAffectsDirectoryListing('src', 'src/foo.ts'), true);
    assert.equal(changedPathAffectsDirectoryListing('src', 'lib/foo.ts'), false);
  });

  test('root listing invalidates for top-level file changes', () => {
    assert.equal(changedPathAffectsDirectoryListing('.', 'readme.md'), true);
  });
});

// ── pathMatchesBustPrefix ────────────────────────────────────────────────────

describe('pathMatchesBustPrefix', () => {
  test('directory prefix matches nested file paths', () => {
    assert.equal(pathMatchesBustPrefix('src/pkg/foo.ts', 'src/pkg'), true);
    assert.equal(pathMatchesBustPrefix('other/foo.ts', 'src/pkg'), false);
  });
});
