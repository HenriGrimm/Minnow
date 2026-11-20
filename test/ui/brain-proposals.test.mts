import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mountMemoryProposalsPanel } from '../../src/ui/memory-proposals-panel.ts';
import { isLocalServerAvailable, setLocalServerAvailableForTests } from '../../src/tools/config.ts';

test('Brain proposals show skills only and never fetch or change stored memory proposals', async t => {
  const win = new Window();
  const previous = { window: globalThis.window, document: globalThis.document,
    HTMLElement: globalThis.HTMLElement, fetch: globalThis.fetch, available: isLocalServerAvailable() };
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  setLocalServerAvailableForTests(true);
  t.after(() => {
    Object.assign(globalThis, { window: previous.window, document: previous.document,
      HTMLElement: previous.HTMLElement, fetch: previous.fetch });
    setLocalServerAvailableForTests(previous.available);
    win.happyDOM.abort();
  });
  document.body.innerHTML = '<div id="settingsMemoryProposalsList"></div><p id="settingsMemoryProposalsCount"></p>' +
    '<p id="settingsMemoryProposalsOffline"></p><span id="settingsMemoryProposalsBadge"></span>';
  let proposals = [{ id: 's1', title: 'Reusable setup', skillMdDraft: '# Setup', confidence: 0.9, rationale: 'Repeated workflow.' }];
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/api/skills/proposals')) return Response.json({ proposals });
    if (url.includes('/api/memory/synthesis/status')) return Response.json({ memoryPending: 10, skillPending: proposals.length, totalPending: 10 + proposals.length });
    throw new Error(`Unexpected request: ${url}`);
  };
  await mountMemoryProposalsPanel(document.body, () => {});
  assert.equal(document.querySelectorAll('[data-proposal-kind="skill"]').length, 1);
  assert.equal(document.querySelector('[data-proposal-kind="memory"]'), null);
  assert.equal(document.getElementById('settingsMemoryProposalsCount')?.textContent, 'Pending: 1');
  assert.equal(document.getElementById('settingsMemoryProposalsBadge')?.textContent, '1');
  proposals = [];
  await mountMemoryProposalsPanel(document.body, () => {});
  assert.equal(document.getElementById('settingsMemoryProposalsCount')?.textContent, 'Pending: 0');
  assert.equal(document.getElementById('settingsMemoryProposalsBadge')?.classList.contains('hidden'), true);
  assert.ok(requests.every(request => !request.includes('/api/memory/proposals')));
});
