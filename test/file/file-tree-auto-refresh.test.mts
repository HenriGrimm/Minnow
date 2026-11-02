/**
 * Tests for debounced file tree refresh after mutating tool results.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS,
  FILE_TREE_INTERACTION_FLUSH_MS,
  resetFileTreeAutoRefreshForTests,
  scheduleFileTreeRefreshAfterTool,
  setFileTreeAutoRefreshRunnerForTests,
  setFileTreeUserInteractingForTests,
  shouldScheduleFileTreeRefresh,
} from '../../src/ui/file-tree-auto-refresh.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';

afterEach(() => {
  resetFileTreeAutoRefreshForTests();
  setFileTreeServerAvailable(false);
});

describe('shouldScheduleFileTreeRefresh', () => {
  test('true for mutating tool with success content when server is up', () => {
    setFileTreeServerAvailable(true);
    assert.equal(
      shouldScheduleFileTreeRefresh('save_file', { content: 'Wrote file.' }),
      true,
    );
    assert.equal(
      shouldScheduleFileTreeRefresh('make_directory', { content: 'Created dir' }),
      true,
    );
  });

  test('false when file tree server is unavailable', () => {
    setFileTreeServerAvailable(false);
    assert.equal(
      shouldScheduleFileTreeRefresh('save_file', { content: 'ok' }),
      false,
    );
  });

  test('false for non-mutating tools', () => {
    setFileTreeServerAvailable(true);
    assert.equal(shouldScheduleFileTreeRefresh('read_file', { content: 'body' }), false);
    assert.equal(shouldScheduleFileTreeRefresh('list_directory', { content: 'a\nb' }), false);
  });

  test('false when content starts with Error:', () => {
    setFileTreeServerAvailable(true);
    assert.equal(
      shouldScheduleFileTreeRefresh('save_file', { content: 'Error: denied' }),
      false,
    );
  });
});

describe('scheduleFileTreeRefreshAfterTool', () => {
  test('slow refreshes coalesce later tool bursts into one trailing refresh', async () => {
    setFileTreeServerAvailable(true);
    let complete!: () => void;
    let calls = 0;
    setFileTreeAutoRefreshRunnerForTests(async () => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { complete = resolve; });
    });
    scheduleFileTreeRefreshAfterTool('save_file', { content: 'ok' });
    await new Promise(resolve => setTimeout(resolve, FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS + 40));
    assert.equal(calls, 1);
    for (let i = 0; i < 20; i++) scheduleFileTreeRefreshAfterTool('save_file', { content: 'ok' });
    await new Promise(resolve => setTimeout(resolve, FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS + 40));
    assert.equal(calls, 1, 'a slow refresh must not overlap the next tool burst');
    complete();
    await new Promise(resolve => setTimeout(resolve, FILE_TREE_INTERACTION_FLUSH_MS + 40));
    assert.equal(calls, 2);
  });
  test('debounces two rapid schedules into one runner invocation', async () => {
    setFileTreeServerAvailable(true);
    let refreshCount = 0;
    setFileTreeAutoRefreshRunnerForTests(async () => {
      refreshCount += 1;
    });

    scheduleFileTreeRefreshAfterTool('save_file', { content: 'ok' }, undefined, {
      path: 'src/a.ts',
    });
    scheduleFileTreeRefreshAfterTool('save_file', { content: 'ok' }, undefined, {
      path: 'src/b.ts',
    });
    assert.equal(refreshCount, 0);

    await new Promise<void>((resolve) =>
      setTimeout(resolve, FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS + 40),
    );
    assert.equal(refreshCount, 1);
  });

  test('passes affected parent dirs to the refresh runner', async () => {
    setFileTreeServerAvailable(true);
    const seen: Array<string[] | null> = [];
    setFileTreeAutoRefreshRunnerForTests(async (dirs) => {
      seen.push(dirs);
    });

    scheduleFileTreeRefreshAfterTool(
      'save_file',
      { content: 'ok' },
      undefined,
      { path: 'src/ui/file-tree.ts' },
    );

    await new Promise<void>((resolve) =>
      setTimeout(resolve, FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS + 40),
    );
    assert.deepEqual(seen, [['src/ui']]);
  });

  test('defers refresh while user is interacting with the tree', async () => {
    setFileTreeServerAvailable(true);
    let refreshCount = 0;
    setFileTreeAutoRefreshRunnerForTests(async () => {
      refreshCount += 1;
    });
    setFileTreeUserInteractingForTests(true);

    scheduleFileTreeRefreshAfterTool('save_file', { content: 'ok' }, undefined, {
      path: 'docs/readme.md',
    });

    await new Promise<void>((resolve) =>
      setTimeout(resolve, FILE_TREE_AUTO_REFRESH_DEBOUNCE_MS + 40),
    );
    assert.equal(refreshCount, 0);

    setFileTreeUserInteractingForTests(false);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, FILE_TREE_INTERACTION_FLUSH_MS + 40),
    );
    assert.equal(refreshCount, 1);
  });

  test('ending tree interaction without a scheduled refresh does not reload the tree', async () => {
    setFileTreeServerAvailable(true);
    let refreshCount = 0;
    setFileTreeAutoRefreshRunnerForTests(async () => {
      refreshCount += 1;
    });

    setFileTreeUserInteractingForTests(true);
    setFileTreeUserInteractingForTests(false);

    await new Promise<void>((resolve) =>
      setTimeout(resolve, FILE_TREE_INTERACTION_FLUSH_MS + 40),
    );
    assert.equal(refreshCount, 0);
  });
});
