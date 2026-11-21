import { listPages, readPage } from './store.js';

/** Load eligible pages with at most eight concurrent reads, preserving catalog order. */
export async function loadAllPagesWithBodies(metas = null) {
  const candidates = metas ?? await listPages();
  const out = new Array(candidates.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (next < candidates.length) {
      const index = next++;
      try {
        const row = await readPage(candidates[index].path);
        out[index] = { meta: row.meta, body: row.body };
      } catch {
        /* skip corrupt */
      }
    }
  }));
  return out.filter(Boolean);
}
