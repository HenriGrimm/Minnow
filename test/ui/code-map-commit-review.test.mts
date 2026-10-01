import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import type { CodeMapFolder } from '../../src/brain/types.ts';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
diff --git a/lib/b.ts b/lib/b.ts
new file mode 100644
--- /dev/null
+++ b/lib/b.ts
@@ -0,0 +1 @@
+export const b = 1;
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
--- a/src/removed.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const removed = 1;
diff --git a/src/old.ts b/src/renamed.ts
similarity index 100%
rename from src/old.ts
rename to src/renamed.ts
diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
`;
let workspace = 'C:/workspace';
let nextFolder: ((path: string) => Promise<CodeMapFolder | null>) | null = null;
let editorOpens = 0;
let nextShow: (() => Promise<{ ok: boolean; patch: string }>) | null = null;
const folder = (path: string): CodeMapFolder => ({
  path, edges: [], hidden: [], calledFrom: [], callsInto: [], summary: null,
  nodes: path === 'src' ? ['a.ts', 'unchanged.ts'].map(name => ({
    id: `src/${name}`, path: `src/${name}`, name, kind: 'file' as const,
    symbols: 1, lines: 10, files: 1, outside: 0, callsIn: 0, callsOut: 0,
  })) : [],
});
mock.module('../../src/state/git-api.ts', { namedExports: {
  gitShow: async () => nextShow ? nextShow() : ({ ok: true, patch: PATCH }),
  gitDiff: async () => ({ ok: true, patch: PATCH }),
}});
mock.module('../../src/state/workspace.ts', { namedExports: { getWorkspacePath: () => workspace } });
mock.module('../../src/ui/file-layout.ts', { namedExports: { showViewerSplit() {}, hideViewerSplit() {} } });
mock.module('../../src/ui/file-viewer.ts', { namedExports: { dismissFileViewerForPreview: async () => true } });
mock.module('../../src/ui/app-dialog.ts', { namedExports: { appConfirm: async () => false } });
mock.module('../../src/ui/code-ref-link.ts', { namedExports: { openCodeRefInViewer: () => { editorOpens++; } } });
mock.module('../../src/ui/code-map/export.ts', { namedExports: { sceneToPng: async () => null } });
mock.module('../../src/ui/code-map/viewport.ts', { namedExports: {
  createViewport: () => ({
    setContent() {}, fit() {}, zoomBy() {}, reveal() {}, getState: () => ({ x: 0, y: 0, k: 1 }),
    consumeDrag: () => false, setMinimapShapes() {}, setRightInset() {}, onChange() {}, destroy() {},
  }),
}});
mock.module('../../src/brain/client.ts', { namedExports: {
  fetchBrainCodeStatus: async () => ({ enabled: true, fileCount: 2, symbolCount: 2 }),
  fetchCodeMapArchitecture: async () => ({
    repo: 'demo', base: 'src', fileCount: 2, symbolCount: 2, edges: [], externals: [],
    groups: [{ id: 'src', path: 'src', name: 'src', test: false, files: 2, symbols: 2 }],
    modules: [{ id: 'src', group: 'src', path: 'src', name: 'src', loose: true, test: false, files: 2, symbols: 2, lines: 20 }],
  }),
  fetchCodeMapFolder: async (path: string) => nextFolder ? nextFolder(path) : folder(path),
  fetchCodeMapFile: async () => null,
  fetchBrainCodeReadSymbol: async () => null, fetchBrainCodeWhoCalls: async () => null,
  fetchBrainCodeCallsOf: async () => null, fetchBrainCodeExplain: async () => null,
  findBrainCodeSymbol: async () => [], searchCodeMapPaths: async () => [],
  reindexBrainCode: async () => null, clearBrainCodeIndex: async () => null,
}});

const { openGitCommitDiffPanel, closeGitCommitDiffPanel, openGitWorkingFileDiffPanel } =
  await import('../../src/ui/git-commit-diff-panel.ts');
const { renderCodeMapPage } = await import('../../src/ui/code-map/page.ts');
const { getGitCommitReview, selectGitCommitReviewFile } = await import('../../src/ui/git-commit-review.ts');
const win = new Window({ url: 'http://localhost' });
const originals = Object.fromEntries(['window', 'document', 'HTMLElement', 'Element', 'CustomEvent', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
before(() => {
  for (const key of Object.keys(originals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: (win as any)[key] });
  }
  document.body.innerHTML = `
    <div id="chatArea" class="chat-area--code-brain-map">
      <div id="codeMap"><div class="code-map-bar"></div>
        <div id="codeMapTabs"><button data-view="architecture">Architecture</button><button data-view="files">Files</button></div>
        <div id="codeMapStage"><div id="codeMapViewport"><div id="codeMapScene">
          <svg id="codeMapEdges"></svg><div id="codeMapNodes"></div>
        </div></div><div id="codeMapInspector"></div><div id="codeMapEmpty" hidden></div></div>
      </div>
    </div><div id="fileViewerPane"><div id="fileViewerHost"></div></div>`;
});
after(() => {
  closeGitCommitDiffPanel();
  win.happyDOM.abort();
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
beforeEach(async () => {
  closeGitCommitDiffPanel();
  nextFolder = null;
  nextShow = null;
  editorOpens = 0;
  workspace += '/next';
  document.getElementById('chatArea')!.classList.add('chat-area--code-brain-map');
  await renderCodeMapPage();
});
const card = (path: string) => [...document.querySelectorAll<HTMLButtonElement>('.code-map-card')].find(el => el.dataset.id === path);
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.git-commit-diff__file-tab')].find(el => el.textContent?.startsWith(name))!;
const openCommit = async () => {
  assert.deepEqual(await openGitCommitDiffPanel({ sha: 'abcdef123', cwd: workspace }), { ok: true });
  await settle();
};

test('commit opening and file selections stay synchronized in both directions across folders', async () => {
  await openCommit();
  assert.equal(card('src/a.ts')?.getAttribute('aria-pressed'), 'true');
  assert.equal(document.getElementById('codeMapInspector')!.hidden, true);
  card('src/removed.ts')!.click();
  assert.equal(tab('removed.ts').getAttribute('aria-selected'), 'true');
  assert.match(document.getElementById('fileViewerHost')!.textContent!, /export const removed/);
  tab('b.ts').click();
  await settle();
  assert.equal(card('lib/b.ts')?.getAttribute('aria-pressed'), 'true');
  assert.equal(card('lib/b.ts')?.dataset.commitStatus, 'Added');
  tab('renamed.ts').click();
  await settle();
  assert.equal(card('src/renamed.ts')?.getAttribute('aria-pressed'), 'true');
  assert.match(card('src/renamed.ts')!.textContent!, /was src\/old.ts/);
  card('src/renamed.ts')!.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }) as unknown as Event);
  await settle();
  assert.equal(editorOpens, 0);
  assert.ok(document.querySelector('.git-commit-diff'));
  tab('logo.png').click();
  await settle();
  assert.equal(card('assets/logo.png')?.getAttribute('aria-pressed'), 'true');
  assert.match(document.getElementById('fileViewerHost')!.textContent!, /Binary file changed/);
});

test('unchanged map files show an explicit empty diff, and selecting a changed file restores the patch', async () => {
  await openCommit();
  card('src/unchanged.ts')!.click();
  assert.equal(getGitCommitReview()?.selectedPath, 'src/unchanged.ts');
  assert.match(document.getElementById('fileViewerHost')!.textContent!, /src\/unchanged.ts: No changes in this commit/);
  assert.equal(document.querySelectorAll('.git-commit-diff__file-tab.is-active').length, 0);
  tab('a.ts').click();
  assert.equal(card('src/a.ts')?.getAttribute('aria-pressed'), 'true');
  assert.ok(document.querySelector('.sbs-diff'));
});

test('closing or replacing commit review clears badges and commit-only nodes', async () => {
  await openCommit();
  assert.equal(card('src/removed.ts')?.dataset.commitStatus, 'Deleted');
  closeGitCommitDiffPanel();
  await settle();
  assert.equal(getGitCommitReview(), null);
  assert.equal(document.querySelector('.code-map-card__change'), null);
  assert.equal(card('src/removed.ts'), undefined);
  assert.equal(document.getElementById('codeMapCommitContext'), null);
  await openCommit();
  await openGitWorkingFileDiffPanel({ path: 'src/a.ts', staged: false, cwd: workspace });
  await settle();
  assert.equal(getGitCommitReview(), null);
  assert.equal(document.querySelector('.code-map-card__change'), null);
});

test('superseded folder reads cannot replace a more recent diff selection', async () => {
  await openCommit();
  let finish!: (value: CodeMapFolder) => void;
  nextFolder = async path => path === 'lib' ? new Promise(resolve => { finish = resolve; }) : folder(path);
  tab('b.ts').click();
  await settle();
  tab('removed.ts').click();
  await settle();
  finish(folder('lib'));
  await settle();
  assert.equal(card('src/removed.ts')?.getAttribute('aria-pressed'), 'true');
  assert.equal(card('lib/b.ts'), undefined);
  assert.equal(getGitCommitReview()?.selectedPath, 'src/removed.ts');
});

test('review opened before the map follows the selected file when the map opens', async () => {
  document.getElementById('chatArea')!.classList.remove('chat-area--code-brain-map');
  await openCommit();
  tab('b.ts').click();
  document.getElementById('chatArea')!.classList.add('chat-area--code-brain-map');
  await renderCodeMapPage();
  assert.equal(card('lib/b.ts')?.getAttribute('aria-pressed'), 'true');
});

test('a commit from another worktree does not decorate or navigate this map', async () => {
  await openGitCommitDiffPanel({ sha: 'other', cwd: 'C:/another-worktree' });
  await settle();
  assert.equal(document.querySelector('.code-map-card__change'), null);
  assert.equal(document.getElementById('codeMapCommitContext'), null);
  assert.equal(getGitCommitReview()?.selectedPath, 'src/a.ts');
  selectGitCommitReviewFile('lib/b.ts');
  await settle();
  assert.equal(card('lib/b.ts'), undefined);
});

test('late commit loads and closing a pending load cannot restore stale review', async () => {
  let finish!: (value: { ok: boolean; patch: string }) => void;
  nextShow = () => new Promise(resolve => { finish = resolve; });
  const oldRequest = openGitCommitDiffPanel({ sha: 'older', cwd: workspace });
  await settle();
  nextShow = null;
  await openCommit();
  finish({ ok: true, patch: PATCH });
  assert.deepEqual(await oldRequest, { ok: false, cancelled: true });
  assert.equal(getGitCommitReview()?.sha, 'abcdef123');
  nextShow = () => new Promise(resolve => { finish = resolve; });
  const pending = openGitCommitDiffPanel({ sha: 'pending', cwd: workspace });
  await settle();
  closeGitCommitDiffPanel();
  finish({ ok: true, patch: PATCH });
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.equal(getGitCommitReview(), null);
});

test('default workspace scope is captured and an empty commit has an explicit empty diff', async () => {
  nextShow = async () => ({ ok: true, patch: '' });
  await openGitCommitDiffPanel({ sha: 'empty' });
  assert.equal(getGitCommitReview()?.cwd, workspace);
  assert.equal(getGitCommitReview()?.selectedPath, null);
  assert.match(document.getElementById('fileViewerHost')!.textContent!, /No file changes in this commit/);
});
