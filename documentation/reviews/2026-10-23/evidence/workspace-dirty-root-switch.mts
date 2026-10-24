// Review-only reproduction using the real worktree file-tree sync and viewer teardown.
// Run: node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-dirty-root-switch.mts
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const dom = new Window({ url: 'http://localhost:9473' });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
globalThis.fetch = (async () => Response.json({})) as typeof fetch;
const { setWorkspaceFromServer } = await import('../../../../src/state/workspace.ts');
const { openViewerTab, snapshotViewerTabEditorContent, listViewerTabs } =
  await import('../../../../src/ui/file-viewer-tab-store.ts');
const { syncFileTreeToPanelWorktree } = await import('../../../../src/ui/file-tree.ts');
setWorkspaceFromServer({ path: 'C:/review/main', label: 'main', isDefault: false });
await openViewerTab('src/draft.ts', { content: 'loaded text', skipUnsavedGuard: true });
snapshotViewerTabEditorContent('src/draft.ts', 'unsaved human draft', true);
assert.equal(listViewerTabs()[0].isDirty, true);
await syncFileTreeToPanelWorktree('C:/review/other-checkout');
assert.equal(listViewerTabs().length, 0, 'Current bug: root switch clears the dirty draft without asking');
console.log(JSON.stringify({ dirtyTabsBefore: 1, tabsAfterWorktreeRootSwitch: listViewerTabs().length,
  dialogCount: document.querySelectorAll('[role="dialog"]').length }));
dom.close();
process.exit(0);
