import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { getTranscriptScroller } from '../../src/ui/transcript-scroll.ts';

let win;
afterEach(() => win?.close());

function surface({ scale = 1 } = {}) {
  win ??= new Window();
  const root = win.document.createElement('main');
  win.document.body.append(root);
  let top = 600;
  let height = 1000;
  let anchorOffset = 400;
  Object.defineProperties(root, {
    clientHeight: { value: 400 }, offsetHeight: { value: 400 },
    scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 400)); } },
  });
  root.getBoundingClientRect = () => ({ top: 0, bottom: 400 * scale, height: 400 * scale });
  const row = root.appendChild(win.document.createElement('div'));
  row.dataset.historyIndex = '10';
  row.getBoundingClientRect = () => ({
    top: (anchorOffset - top) * scale, bottom: (anchorOffset + 200 - top) * scale, height: 200 * scale,
  });
  const scroller = getTranscriptScroller(root);
  const scroll = value => { root.scrollTop = value; root.dispatchEvent(new win.Event('scroll')); };
  const wheel = deltaY => root.dispatchEvent(new win.WheelEvent('wheel', { deltaY }));
  return { root, row, scroller, scroll, wheel,
    grow: (above, below = 0) => { height += above + below; anchorOffset += above; },
  };
}

test('a delayed programmatic scroll event cannot block returning down to the tail', () => {
  win = new Window();
  const { root, scroller, scroll, wheel, grow } = surface();
  scroller.toBottom();
  grow(200);
  scroller.follow();
  wheel(-40);
  scroll(root.scrollTop - 100);
  assert.equal(scroller.isPinned(), false);
  wheel(100);
  scroll(root.scrollHeight - root.clientHeight);
  assert.equal(scroller.isPinned(), true, 'returning down resumes follow without a jump-button click or frame guard');
  grow(100);
  scroller.follow();
  assert.equal(root.scrollTop, root.scrollHeight - root.clientHeight);
});

test('follow state belongs to each viewport, including background embedded transcripts', () => {
  win = new Window();
  const main = surface();
  const embedded = surface();
  main.scroller.toBottom(); embedded.scroller.toBottom();
  embedded.wheel(-40); embedded.scroll(300);
  assert.equal(main.scroller.isPinned(), true);
  assert.equal(embedded.scroller.isPinned(), false);
  main.grow(100); main.scroller.follow();
  assert.equal(main.root.scrollTop, 700);
  assert.equal(embedded.root.scrollTop, 300);
});

for (const scale of [1, 0.67, 1.25]) {
  test(`visible-message anchoring ignores simultaneous growth below the reader at scale ${scale}`, () => {
    win = new Window();
    const { root, row, scroller, scroll, wheel, grow } = surface({ scale });
    wheel(-40); scroll(300);
    const before = row.getBoundingClientRect().top;
    scroller.preserve(root, () => grow(200, 400));
    assert.ok(Math.abs(root.scrollTop - 500) < 0.01, 'compensate for the 200 px above the anchor, not all 600 px');
    assert.ok(Math.abs(row.getBoundingClientRect().top - before) < 0.01);
    assert.equal(scroller.isPinned(), false);
    root.dispatchEvent(new win.Event('scroll'));
    assert.equal(scroller.isPinned(), false, 'the prepend is not a downward user gesture');
    wheel(900); scroll(root.scrollHeight - root.clientHeight);
    assert.equal(scroller.isPinned(), true);
  });
}

test('overlapping follow writes leave CSS behavior untouched and preserve user direction', () => {
  win = new Window();
  const { root, scroller, grow, scroll, wheel } = surface();
  root.style.scrollBehavior = 'smooth';
  scroller.toBottom(); grow(100); scroller.follow(); grow(100); scroller.follow();
  assert.equal(root.style.scrollBehavior, 'smooth');
  wheel(-40); scroll(500);
  assert.equal(scroller.isPinned(), false);
  wheel(900); scroll(root.scrollHeight - root.clientHeight);
  assert.equal(scroller.isPinned(), true);
});
