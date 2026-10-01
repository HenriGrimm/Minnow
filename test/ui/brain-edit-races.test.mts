import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { Window } from 'happy-dom';

const window = new Window();
Object.assign(globalThis, { window, document: window.document });
document.body.innerHTML = ['brainEditPath', 'brainEditTitle', 'brainEditTags', 'brainEditBody'].map((id) => `<input id="${id}">`).join('')
  + '<button id="brainEditLoad"></button><button id="brainEditNew"></button><button id="brainEditSave"></button><div id="brainEditStatus"></div>';
const pending = new Map<string, ((page: any) => void)[]>();
let finishSave: (page: any) => void;
let lastSave: any;
let confirmDiscard = false;
class Conflict extends Error {}
mock.module('../../src/brain/client.ts', { namedExports: {
  BrainRevisionConflictError: Conflict,
  fetchBrainPage: (path: string) => new Promise((resolve) => { pending.set(path, [...(pending.get(path) ?? []), resolve]); }),
  saveBrainPage: (input: any) => { lastSave = input; return new Promise((resolve) => { finishSave = resolve; }); },
} });
mock.module('../../src/ui/brain/graph-section.ts', { namedExports: { getGraphSelectedPath: () => null, setGraphSelectedPath() {} } });
mock.module('../../src/ui/brain/wikilink-markdown.ts', { namedExports: { renderBrainMarkdown() {} } });
mock.module('../../src/ui/app-dialog.ts', { namedExports: { appConfirm: async () => confirmDiscard } });
mock.module('../../src/ui/memory-saved-toast.ts', { namedExports: { memorySavedPayloadFromBrainPage: (p: any) => p, showMemorySavedToast() {} } });
const { renderEditSection } = await import('../../src/ui/brain/edit-section.ts');
const field = (id: string) => document.getElementById(`brainEdit${id}`) as HTMLInputElement;
const tick = () => new Promise((r) => setImmediate(r));
const page = (path: string, body = path) => ({ path, revision: `rev-${path}`, meta: { title: path, tags: [] }, body });
function resolve(path: string, value: any = page(path)) { pending.get(path)!.shift()!(value); }
function input(id: string, value: string) { field(id).value = value; field(id).dispatchEvent(new window.Event('input')); }
after(() => window.happyDOM.abort());

test('reordered loads cannot overwrite selected page, edits, or save revision', async () => {
  const a = renderEditSection('facts/a.md');
  const b = renderEditSection('facts/b.md');
  resolve('facts/b.md'); await b;
  input('Body', 'B draft');
  resolve('facts/a.md'); await a;
  assert.equal(field('Path').value, 'facts/b.md'); assert.equal(field('Body').value, 'B draft');
  field('Save').click(); await tick();
  assert.equal(lastSave.expectedRevision, 'rev-facts/b.md');
  finishSave!(page('facts/b.md', 'B draft')); await tick();
});
test('late success and missing page preserve edits made after request', async () => {
  for (const [path, result] of [['facts/late.md', page('facts/late.md')], ['facts/missing.md', null]] as const) {
    const load = renderEditSection(path);
    input('Title', 'my title'); input('Body', `draft ${path}`);
    resolve(path, result); await load;
    assert.equal(field('Title').value, 'my title'); assert.equal(field('Body').value, `draft ${path}`);
  }
});
test('navigation restores dirty drafts and New invalidates pending loads', async () => {
  const c = renderEditSection('facts/c.md'); resolve('facts/c.md'); await c;
  input('Body', 'unsaved C');
  const d = renderEditSection('facts/d.md'); resolve('facts/d.md'); await d;
  await renderEditSection('facts/c.md');
  assert.equal(field('Body').value, 'unsaved C');
  const late = renderEditSection('facts/new-pending.md');
  field('New').click(); await tick();
  const values = [field('Path').value, field('Title').value, field('Body').value];
  resolve('facts/new-pending.md'); await late;
  assert.deepEqual([field('Path').value, field('Title').value, field('Body').value], values);
});
test('canceled reload and failed save retain draft; stale save does not rebind next page', async () => {
  await renderEditSection('facts/c.md');
  confirmDiscard = false;
  field('Load').click(); await tick();
  assert.equal(field('Body').value, 'unsaved C');
  field('Save').click(); await tick(); finishSave!(null); await tick();
  assert.equal(field('Body').value, 'unsaved C');
  field('Save').click(); await tick();
  const e = renderEditSection('facts/e.md'); resolve('facts/e.md'); await e;
  finishSave!(page('facts/c.md')); await tick();
  field('Save').click(); await tick();
  assert.equal(lastSave.expectedRevision, 'rev-facts/e.md');
  finishSave!(page('facts/e.md')); await tick();
});
test('A resolving first still leaves B selected; edits during save retain their draft', async () => {
  const a = renderEditSection('facts/order-a.md');
  const b = renderEditSection('facts/order-b.md');
  resolve('facts/order-a.md'); await a;
  assert.equal(field('Path').value, 'facts/order-b.md');
  resolve('facts/order-b.md'); await b;
  input('Body', 'submitted'); field('Save').click(); await tick();
  input('Body', 'newer draft');
  finishSave!({ ...page('facts/order-b.md', 'submitted'), revision: 'saved-revision' }); await tick();
  assert.equal(field('Body').value, 'newer draft');
  const other = renderEditSection('facts/other.md'); resolve('facts/other.md'); await other;
  await renderEditSection('facts/order-b.md');
  assert.equal(field('Body').value, 'newer draft');
  field('Save').click(); await tick();
  assert.equal(lastSave.expectedRevision, 'saved-revision');
  finishSave!(page('facts/order-b.md', 'newer draft')); await tick();
});
