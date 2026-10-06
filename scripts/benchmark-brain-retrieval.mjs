/** Reproducible body-I/O benchmark: node --experimental-test-module-mocks scripts/benchmark-brain-retrieval.mjs */
import { mock } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-retrieval-bench-'));
let pages = [];
let reads = 0;
const readPage = async (relative) => {
  reads++;
  const index = Number(relative.match(/page-(\d+)\.md$/)[1]);
  return { meta: pages[index], body: await fs.readFile(path.join(directory, `${index}.md`), 'utf8') };
};
mock.module('../server/brain/store.js', { namedExports: {
  ...await import('../server/brain/store.js'), listPages: async () => pages, readPage,
} });
const { retrieveBrainBlockHybrid, scopePagesToWorkspace, retrieveMemoryBlockHybrid } = await import('../server/brain/retrieve.js');
const config = { embeddings: { enabled: false } };
const opts = { workspaceKey: 'active', query: 'topic', limit: 12 };
async function baseline() {
  const all = [];
  for (const meta of pages) all.push(await readPage(meta.path));
  const eligible = new Set(scopePagesToWorkspace(pages, opts.workspaceKey).map((p) => p.path));
  return retrieveMemoryBlockHybrid(all.filter((r) => eligible.has(r.meta.path)), opts, config);
}
async function measure(run) {
  const timings = []; let count = 0;
  for (let i = 0; i < 10; i++) {
    reads = 0; const start = performance.now(); await run();
    timings.push(performance.now() - start); count = reads;
  }
  timings.sort((a, b) => a - b);
  return { p95Ms: Number(timings[Math.ceil(timings.length * 0.95) - 1].toFixed(2)), bodyReads: count };
}
try {
  for (const size of [1000, 10000]) {
    pages = Array.from({ length: size }, (_, i) => ({
      id: `page-${i}`, title: 'topic', tags: [],
      path: `${i % 20 === 0 ? 'facts' : `workspaces/${i % 20 === 1 ? 'active' : 'other'}/archive/chat`}/page-${i}.md`,
    }));
    // Bounded fixture creation too; body reads are real filesystem I/O in both variants.
    for (let i = 0; i < size; i += 64) await Promise.all(pages.slice(i, i + 64).map((_, j) => fs.writeFile(path.join(directory, `${i + j}.md`), 'topic archive note\n'.repeat(64))));
    await baseline(); await retrieveBrainBlockHybrid(opts, config); // warm filesystem
    const before = await measure(baseline);
    const after = await measure(() => retrieveBrainBlockHybrid(opts, config));
    console.log(JSON.stringify({ pages: size, samples: 10, fixture: `5% global, 5% active workspace, 90% foreign archives; ${Buffer.byteLength('topic archive note\n'.repeat(64))}-byte bodies; warm filesystem`, before, after }));
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
