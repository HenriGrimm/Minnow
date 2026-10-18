import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from './dom-helpers.mts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { mountWorkChanges } from '../../src/home/work-changes.ts';
import { mountHomeTerminal } from '../../src/home/command-console.ts';

test('review keeps its target checkout, includes committed files and renders patches as text', async () => {
  const win = new Window();
  const requests: Record<string, unknown>[] = [];
  const patch = 'diff --git a/view.ts b/view.ts\n--- a/view.ts\n+++ b/view.ts\n@@ -1 +1 @@\n-old\n+<script>alert(1)</script>\n';
  installHappyDomGlobals(win, { fetch: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, isolated: true, sourceHead: 'committed', targetHead: 'base', fingerprint: 'clean', dirty: false, targetBranch: 'main', files: ['view.ts'], patch }));
  }) as typeof fetch });
  setLocalServerAvailableForTests(true);
  document.body.innerHTML = '<div id="review"></div>';
  const view = mountWorkChanges(document.getElementById('review')!, { workspace: '/repo', checkout: () => '/repo-worktree', target: () => 'main', openCode() {} });
  try {
    view.refresh(); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(requests[0].cwd, '/repo');
    assert.equal(requests[0].worktreePath, '/repo-worktree');
    assert.equal(requests[0].comparisonBranch, 'main');
    assert.match(document.body.textContent!, /1 file changed/);
    assert.match(document.body.textContent!, /includes committed changes/);
    assert.match(document.body.textContent!, /<script>alert\(1\)<\/script>/);
    assert.equal(document.querySelector('script'), null);
    assert.equal(document.querySelectorAll('.home-diff-line--add').length, 1);
  } finally { view.dispose(); setLocalServerAvailableForTests(false); await teardownHappyDomAsync(win); }
});

test('a command remains visible and stoppable after its console is remounted', async () => {
  const win = new Window();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  installHappyDomGlobals(win, { fetch: (async (url, init) => {
    if (String(url).includes('/cancel/')) { cancelled = true; controller.close(); return new Response('{"ok":true}'); }
    if (String(url).includes('/stream/')) return new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('data: {"type":"stdout","text":"still running"}\n\n')); } }));
    assert.equal(JSON.parse(String(init?.body)).workspaceRoot, '/isolated-checkout');
    return new Response('{"runId":"run-retained","startedAt":1}');
  }) as typeof fetch });
  document.body.innerHTML = '<div id="console"></div>';
  const host = document.getElementById('console')!;
  let dispose = mountHomeTerminal(host, '/isolated-checkout');
  try {
    host.querySelector('input')!.value = 'example command';
    host.querySelector('form')!.dispatchEvent(new win.Event('submit', { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 25));
    dispose(); host.replaceChildren();
    dispose = mountHomeTerminal(host, '/isolated-checkout');
    assert.match(host.textContent!, /still running/);
    const stop = [...host.querySelectorAll('button')].find(button => button.textContent === 'Stop')!;
    assert.equal(stop.disabled, false);
    stop.click(); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(cancelled, true);
    assert.equal(stop.disabled, true);
  } finally { dispose(); await teardownHappyDomAsync(win); }
});
