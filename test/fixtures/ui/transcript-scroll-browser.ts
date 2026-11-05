import { getTranscriptScroller, transcriptBottomDistance } from '../../../src/ui/transcript-scroll';
import { mountHistoryPager } from '../../../src/ui/history-pager';

const root = document.querySelector<HTMLElement>('#chatArea')!;
const scroller = getTranscriptScroller(root);
const chip = document.querySelector<HTMLButtonElement>('#chatJumpLatest')!;
const total = 600;
const tailStart = total - 30;

function renderRow(host: HTMLElement, index: number): void {
  const row = document.createElement('div');
  row.dataset.historyIndex = String(index);
  const kind = index % 20;
  if (kind === 0) {
    row.className = 'msg user';
    row.innerHTML = `<div class="msg-bubble">Question ${index / 20}</div>`;
  } else if (kind === 19) {
    row.className = 'msg assistant chat-turn-final';
    const bubble = row.appendChild(document.createElement('div'));
    bubble.className = 'msg-bubble msg-bubble--md';
    for (let n = 0; n < 12; n++) {
      const p = bubble.appendChild(document.createElement('p'));
      p.textContent = `Section ${n}: ` + 'A completed response with multiple paragraphs and dynamic height. '.repeat(n % 3 + 2);
    }
    if (index === total - 1) {
      const end = bubble.appendChild(document.createElement('p'));
      end.id = 'latestReplyEnd';
      end.textContent = 'This is the last line of the latest completed reply.';
    }
  } else {
    row.className = 'tool-call-msg chat-work-hidden';
    row.textContent = `Read file ${index}`;
  }
  host.append(row);
}

for (let index = tailStart; index < total; index++) renderRow(root, index);
scroller.subscribe(() => { chip.hidden = scroller.isPinned(); });
chip.addEventListener('click', () => scroller.toBottom());
scroller.toBottom();
mountHistoryPager({ mount: root, scrollRoot: () => root, from: tailStart, renderRow });

Object.assign(window, { testScroll: {
  root, scroller,
  snapshot: () => ({
    top: root.scrollTop,
    distance: transcriptBottomDistance(root),
    pinned: scroller.isPinned(),
    chip: !chip.hidden,
    start: Number(root.dataset.historyStart),
    viewportBottom: root.getBoundingClientRect().bottom,
    replyBottom: document.getElementById('latestReplyEnd')!.getBoundingClientRect().bottom,
  }),
} });
