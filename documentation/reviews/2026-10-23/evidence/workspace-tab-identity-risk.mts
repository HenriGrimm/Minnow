// Review-only API invariant reproduction, NOT proof of an end-to-end user defect.
// Run: node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/workspace-tab-identity-risk.mts
import assert from 'node:assert/strict';
import { resetFilePanelStateForTests } from '../../../../src/state/file-panel.ts';
import { openViewerTab, resetViewerTabStoreForTests, snapshotViewerTabEditorContent, listViewerTabs }
  from '../../../../src/ui/file-viewer-tab-store.ts';
globalThis.fetch = (async () => Response.json({})) as typeof fetch;
resetFilePanelStateForTests();
resetViewerTabStoreForTests();
const a = await openViewerTab('src/shared.ts', { workspaceRoot: 'C:/review/checkout-a',
  content: 'same baseline', skipUnsavedGuard: true });
snapshotViewerTabEditorContent('src/shared.ts', 'unsaved change for checkout A', true);
const b = await openViewerTab('src/shared.ts', { workspaceRoot: 'C:/review/checkout-b',
  content: 'different B file', skipUnsavedGuard: true });
assert.equal(a!.tab, b!.tab);
assert.equal(b!.tab.workspaceRoot, 'C:/review/checkout-b');
assert.equal(b!.tab.cachedEditorContent, 'unsaved change for checkout A');
console.log(JSON.stringify({ tabs: listViewerTabs().length, secondOpenFocusedExisting: b!.focusedExisting,
  newSaveTarget: b!.tab.workspaceRoot, retainedDraft: b!.tab.cachedEditorContent,
  qualification: 'presented-file-cards currently uses absolute paths for cross-root files, avoiding this API misuse' }));
process.exit(0);
