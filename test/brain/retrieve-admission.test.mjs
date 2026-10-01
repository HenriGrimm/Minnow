import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let pages = [];
let reads = [];
let active = 0;
let maximum = 0;
mock.module('../../server/engine/embeddings.js', { namedExports: {
  ...await import('../../server/engine/embeddings.js'),
  getEmbedder: async () => ({ id: 'test', dim: 2 }),
  embedTexts: async () => [[1, 0]],
} });
mock.module('../../server/brain/store.js', { namedExports: {
  ...await import('../../server/brain/store.js'),
  listPages: async () => pages,
  readPage: async (path) => {
    reads.push(path);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (path.endsWith('corrupt.md')) throw new Error('corrupt');
    return { meta: pages.find((p) => p.path === path), body: 'topic useful body\n> source quote' };
  },
  loadBrainConfig: async () => ({ embeddings: { enabled: false } }),
  loadCatalog: async () => ({ pages: {} }),
  computeBacklinks: () => ({}),
} });
const { retrieveBrainBlockHybrid, loadAllPagesWithBodies, bindRetrieveVectorStore } = await import('../../server/brain/retrieve.js');
bindRetrieveVectorStore({
  loadVectorStore: async () => ({ vectors: Object.fromEntries(pages.map((p) => [p.id, [1, 0]])) }),
  getEntryVector: async () => [1, 0],
  isVectorStoreCompatible: () => true,
});
const config = { embeddings: { enabled: false } };
const paths = [
  'facts/global.md', 'experts/e/facts/topic.md', 'experts/f/facts/topic.md',
  'workspaces/a/facts/topic.md', 'workspaces/b/facts/topic.md',
  'workspaces/a/archive/chat-one/topic.md', 'workspaces/a/archive/chat-two/topic.md',
  'workspaces/a/concepts/topic.md', 'workspaces/b/archive/chat-one/topic.md',
];
function reset(input = paths) {
  pages = input.map((path, i) => ({ path, title: 'topic', tags: [], id: `id-${i}` }));
  reads = []; maximum = 0;
}
test('retrieval admits only metadata allowed by workspace/expert/archive/global scope', async () => {
  for (const [opts, expected] of [
    [{ workspaceKey: 'a' }, paths.filter((p) => !p.startsWith('workspaces/b/'))],
    [{}, paths.filter((p) => !p.startsWith('workspaces/'))],
    [{ workspaceKey: 'a', scope: { expertId: 'e' } }, ['experts/e/facts/topic.md']],
    [{ workspaceKey: 'a', scope: { chatId: 'chat-one' } }, ['workspaces/a/archive/chat-one/topic.md']],
    [{ workspaceKey: 'a', scope: { chatId: 'chat-one', includeGlobal: true } }, paths.filter((p) => !p.startsWith('workspaces/') || p.startsWith('workspaces/a/archive/chat-one/'))],
    [{ workspaceKey: 'a', scope: { mode: 'workspace' } }, paths.filter((p) => p.startsWith('workspaces/a/archive/') || p.startsWith('workspaces/a/concepts/'))],
    [{ workspaceKey: 'a', scope: { mode: 'workspace', includeGlobal: true } }, paths.filter((p) => !p.startsWith('workspaces/') || p.startsWith('workspaces/a/archive/') || p.startsWith('workspaces/a/concepts/'))],
  ]) {
    for (const enabled of [false, true]) {
      reset();
      const result = await retrieveBrainBlockHybrid({ query: 'topic', limit: 20, includeHits: true, ...opts }, { embeddings: { enabled } });
      assert.deepEqual(reads, expected);
      assert.deepEqual(new Set(result.hits.map((h) => h.path)), new Set(expected));
      assert.ok(result.hits.every((h) => h.sourceQuote === 'source quote'));
    }
  }
});
test('eligible reads are bounded, ordered, and skip corrupt pages', async () => {
  reset([...Array.from({ length: 30 }, (_, i) => `facts/${i}.md`), 'facts/corrupt.md']);
  const rows = await loadAllPagesWithBodies(pages);
  assert.equal(maximum, 8);
  assert.deepEqual(rows.map((r) => r.meta.path), pages.slice(0, -1).map((p) => p.path));
});
