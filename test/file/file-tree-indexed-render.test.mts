import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { setFilterQueryValue } from '../../src/ui/file-tree-filter.ts';
import { setFileTreeServerAvailable } from '../../src/ui/file-tree-server.ts';

test('sidebar paints indexed names without directory requests and cancels old content searches', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="fileTreeHost"></div>';
  let finishContent!: (result: { content: string }) => void;
  let searchSignal: AbortSignal | undefined;
  const toolCalls: string[] = [];
  mock.module('../../src/tools/client.ts', {
    namedExports: {
      executeTool: (name: string, _args: unknown, context: { signal?: AbortSignal }) => {
        toolCalls.push(name);
        searchSignal = context.signal;
        return new Promise<{ content: string }>((resolve) => { finishContent = resolve; });
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ files: ['src/app.ts', 'notes.md'] });
  const tree = await import('../../src/ui/file-tree.ts');
  try {
    setFileTreeServerAvailable(true);
    setFilterQueryValue('app');
    tree.renderFileTree();
    for (let i = 0; i < 50 && !searchSignal; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(toolCalls, ['grep']);
    assert.ok(document.querySelector('[data-path="src/app.ts"]'));
    assert.match(document.getElementById('fileTreeHost')?.textContent ?? '', /Searching file contents/);
    setFileTreeServerAvailable(false);
    tree.renderFileTree();
    assert.equal(searchSignal?.aborted, true);
    finishContent({ content: 'src/app.ts:1:obsolete' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('[data-path="src/app.ts"]'), null);
  } finally {
    setFilterQueryValue('');
    setFileTreeServerAvailable(false);
    tree.stopFileTreeGitStatusPollForTests();
    globalThis.fetch = originalFetch;
    mock.reset();
    await teardownHappyDomAsync(win);
  }
});
