import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createActionsView } from '../../src/ui/scc-actions.ts';
import { createReleasesView } from '../../src/ui/scc-releases.ts';
import type { SccContext, SccView } from '../../src/ui/scc-shared.ts';
const originalFetch = globalThis.fetch;
let win: Window;
let view: SccView | undefined;
afterEach(async () => {
  view?.destroy();
  view = undefined;
  globalThis.fetch = originalFetch;
  await win?.happyDOM.close();
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
function setup(reply: (body: any) => any) {
  win = new Window();
  installHappyDomGlobals(win);
  Object.assign(globalThis, {
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
  });
  globalThis.fetch = async (_url, init) =>
    new Response(JSON.stringify(await reply(JSON.parse(String(init?.body)))));
  let cwd = '/repo';
  const ctx: SccContext = {
    getCwd: () => cwd,
    getBranch: () => 'main',
    refreshAll: async () => {},
    refreshSection: async () => {},
    goTo: () => {},
    setBadge: () => {},
  };
  return {
    ctx,
    switchRoot: () => {
      cwd = '/other';
    },
  };
}
function click(label: string) {
  const node = [...view!.root.querySelectorAll('button')].find((n) => n.textContent === label);
  assert(node, label);
  node.click();
}
test('command editor survives polling and local launch uses selected worktree', async () => {
  const calls: any[] = [];
  const { ctx } = setup((body) => {
    calls.push(body);
    if (body.op === 'commandList')
      return {
        ok: true,
        commands: [
          { id: 'build', label: 'Build', command: 'npm run build', cwd: '.', env: {}, secrets: {} },
        ],
      };
    return { ok: true, workflows: [], runs: [] };
  });
  view = createActionsView(ctx, { getForgeStatus: () => null });
  win.document.body.append(view.root);
  await flush();
  click('Commands');
  await flush();
  click('Build');
  const label = view.root.querySelector<HTMLInputElement>('input[aria-label="Label"]')!;
  label.value = 'Unfinished draft';
  await view.refresh();
  assert.equal(view.root.querySelector('input[aria-label="Label"]'), label);
  assert.equal(label.value, 'Unfinished draft');
  click('Run saved command');
  await flush();
  assert(
    calls.some(
      (call) => call.op === 'localRunStart' && call.cwd === '/repo' && call.commandId === 'build',
    ),
  );
});
test('workspace change clears command editor', async () => {
  const { ctx, switchRoot } = setup(() => ({ ok: true, workflows: [], commands: [] }));
  view = createActionsView(ctx, { getForgeStatus: () => null });
  await flush();
  click('Commands');
  await flush();
  click('New command');
  assert(view.root.querySelector('textarea'));
  switchRoot();
  await view.refresh();
  assert.equal(view.root.querySelector('textarea'), null);
});
test('release edits survive refresh and immutable releases have no mutation controls', async () => {
  let immutable = false;
  const release = {
    id: 1,
    tag: 'v1',
    title: 'Release 1',
    body: 'Notes',
    target: 'main',
    draft: true,
    prerelease: false,
    url: 'https://github.com/o/r/releases/tag/v1',
    assets: [],
    createdAt: '',
  };
  const { ctx } = setup((body) =>
    body.op === 'releaseList'
      ? { ok: true, releases: [release] }
      : { ok: true, release: { ...release, immutable }, canWrite: true },
  );
  view = createReleasesView(ctx);
  await flush();
  click('Release 1 · v1 · Draft');
  await flush();
  const notes = view.root.querySelector<HTMLTextAreaElement>('textarea')!;
  notes.value = 'Unsaved notes';
  await view.refresh();
  assert.equal(notes.value, 'Unsaved notes');
  immutable = true;
  click('Release 1 · v1 · Draft');
  await flush();
  assert(!view.root.textContent?.includes('Publish release'));
  assert(view.root.textContent?.includes('immutable'));
});
