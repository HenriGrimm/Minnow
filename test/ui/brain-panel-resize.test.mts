import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { applyBrainInspectorWidth, restoreBrainInspectorWidth } from '../../src/ui/brain/inspector-resize.ts';

const window = new Window({ width: 1800, height: 1000 });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
document.body.innerHTML = '<main id="brainView"><div class="brain-stage"></div></main>';
const root = document.getElementById('brainView')!;
const stage = document.querySelector('.brain-stage') as HTMLElement;
let stageWidth = 0;
stage.getBoundingClientRect = () => ({ width: stageWidth }) as DOMRect;
const width = () => root.style.getPropertyValue('--brain-inspector-w');

after(() => window.happyDOM.abort());

test('restoring while Brain is hidden does not collapse the reader to its minimum', () => {
  stageWidth = 0;
  restoreBrainInspectorWidth();
  assert.equal(width(), '532px');
});

test('old narrow preferences are replaced by the redesigned reader default', () => {
  localStorage.setItem('minnow-brain-inspector-width', '280');
  localStorage.setItem('minnow-brain-inspector-width-v2', '760');
  stageWidth = 1700;
  restoreBrainInspectorWidth();
  assert.equal(width(), '532px');
});

test('new reader preferences survive restore and are bounded by available space', () => {
  localStorage.setItem('minnow-brain-inspector-width-v2', '680');
  restoreBrainInspectorWidth();
  assert.equal(width(), '680px');
  stageWidth = 1200;
  restoreBrainInspectorWidth();
  assert.equal(width(), '624px');
});

test('resizing keeps readable minimum width and leaves room for the graph', () => {
  stageWidth = 1700;
  applyBrainInspectorWidth(100);
  assert.equal(width(), '420px');
  applyBrainInspectorWidth(2000);
  assert.equal(width(), '884px');
});
