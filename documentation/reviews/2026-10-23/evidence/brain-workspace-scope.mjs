// Run: node documentation/reviews/2026-10-23/evidence/brain-workspace-scope.mjs
// Creates a synthetic temporary MINNOW_HOME with embeddings disabled. No models/network.
// Scratch data is retained and its path printed; no live profile is read or deleted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-review-brain-scope-'));
process.env.MINNOW_HOME = home;
const { ensureMinnowLayout } = await import('../../../../server/config/home.js');
await ensureMinnowLayout();
const { writeConfigJson } = await import('../../../../server/config/store.js');
await writeConfigJson('config.json', { memory: { embeddings: { enabled: false } }, brain: { embeddings: { enabled: false } } });
const { createPage, readPage, listPages } = await import('../../../../server/brain/store.js');
const { retireSupersededPages } = await import('../../../../server/brain/synthesis.js');
const { addMemoryProposal } = await import('../../../../server/brain/proposals.js');
const { handleSynthesisRequest } = await import('../../../../server/brain/synthesis-routes.js');
const { runWithToolContext } = await import('../../../../server/runtime/path-access.js');
const { brainWorkspaceKeyFromPath } = await import('../../../../server/brain/paths.js');
const old = await createPage({ relPath: 'workspaces/project-b/port-policy.md', title: 'Vite preview port', body: 'Project B uses port 4000' });
await retireSupersededPages({ title: 'Vite preview port pinning', body: 'Project A uses port 3000' },
  'workspaces/project-a/port-policy.md', [{ meta: old.meta, body: old.body }], { embeddings: { enabled: false } });
const changed = await readPage(old.path);
assert.equal(changed.meta.status, 'stale');
const origin = path.join(home, 'project-a');
const accepting = path.join(home, 'project-b');
await fs.mkdir(origin); await fs.mkdir(accepting);
const proposal = await runWithToolContext(() => addMemoryProposal({ title: 'Project A convention', body: 'Use port 3000',
  scope: 'workspace', category: 'environment', sourceChatId: 'source-chat-A' }), { workspaceRoot: origin });
const req = Readable.from([Buffer.from('{}')]);
req.method = 'POST'; req.url = `/api/memory/proposals/${proposal.id}/accept`;
let result;
const res = { setHeader() {}, end(text) { result = JSON.parse(text); } };
await runWithToolContext(() => handleSynthesisRequest(req, res, req.url), { workspaceRoot: accepting });
assert.equal(result.ok, true);
const accepted = (await listPages()).find(page => page.title === 'Project A convention');
assert.ok(accepted.path.startsWith(`workspaces/${brainWorkspaceKeyFromPath(accepting)}/`));
console.log(JSON.stringify({ scratchHome: home, otherProjectRetired: changed.meta.status === 'stale',
  otherProjectLinkedTo: changed.meta.similarTo, proposalStoredOrigin: Object.hasOwn(proposal, 'workspaceKey'),
  acceptedIntoProjectB: true, acceptedPath: accepted.path }));
const { closeCodeDbForTests } = await import('../../../../server/brain/code/schema.js');
closeCodeDbForTests();
process.exit(0);
