import {
  isActiveChatStreaming,
  readChatStreamText,
  subscribeChatStreamActivity,
  subscribeChatStreamEnd,
  type ChatStreamText,
} from '../chat/streaming-state';
import { getActiveChat } from '../state/sessions';
import { getActiveComposerSurface } from './composer-surface';
import { mountWaveRim } from './wave-rim';

/** How far the canvas overhangs the button, so swells and glow have room past its edge. */
const OUTSET = 12;

let activeWave: ReturnType<typeof createComposerWave> | undefined;
let listening = false;
/** How much of each live turn the rim has already played, so only new text ripples. */
const heard = new Map<string, ChatStreamText>();

export function createComposerWave(button: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.className = 'composer-wave';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.setProperty('--composer-wave-outset', `${OUTSET}px`);
  button.prepend(canvas);
  const rim = mountWaveRim(canvas, { kind: 'border', outset: OUTSET });
  let isLive: boolean | undefined;
  const hoverEvents = new AbortController();
  const refreshPalette = () => rim.refreshPalette();
  button.addEventListener('pointerenter', refreshPalette, { signal: hoverEvents.signal });
  button.addEventListener('pointerleave', refreshPalette, { signal: hoverEvents.signal });
  return {
    button,
    setLive(live: boolean) {
      if (isLive === live) return;
      isLive = live;
      button.classList.toggle('is-model-working', live);
      rim.set(live ? 'live' : 'idle');
    },
    feed(text: ChatStreamText, before?: ChatStreamText) {
      rim.feed(added(text.lastThinking, before?.lastThinking), 0.7);
      rim.feed(added(text.lastDelta, before?.lastDelta));
      const tools = text.toolCallCount - (before?.toolCallCount ?? 0);
      for (let index = 0; index < Math.min(tools, 4); index++) rim.pulse(0.9);
    },
    dispose() {
      hoverEvents.abort();
      rim.dispose();
      canvas.remove();
      button.classList.remove('is-model-working');
    },
  };
}

/** Text added since the last snapshot, or all the text after a round restarts. */
function added(now: string, before: string | undefined): string {
  return before !== undefined && now.startsWith(before) ? now.slice(before.length) : now;
}

function hear(chatId: string): void {
  const text = readChatStreamText(chatId);
  if (!text) {
    heard.delete(chatId);
    return;
  }
  const before = heard.get(chatId);
  heard.set(chatId, { ...text });
  // Background turns keep their place, so switching to one doesn't replay its whole reply.
  if (chatId === getActiveChat().id) activeWave?.feed(text, before);
}

function listen(): void {
  if (listening) return;
  listening = true;
  subscribeChatStreamActivity(hear);
  subscribeChatStreamEnd((chatId) => heard.delete(chatId));
}

/** Ripple a rim around the send (stop) button with the active chat's reply while its model is working. */
export function syncComposerWave(): void {
  const button = getActiveComposerSurface().sendBtnEl;
  const live = isActiveChatStreaming();
  if (!button || (!live && !activeWave)) return;
  listen();
  if (activeWave?.button !== button) {
    activeWave?.dispose();
    activeWave = createComposerWave(button);
  }
  activeWave.setLive(live);
}
