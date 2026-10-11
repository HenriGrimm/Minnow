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

let canvas: HTMLCanvasElement | null = null;
let rim: ReturnType<typeof mountWaveRim> | null = null;
let listening = false;
/** How much of each live turn the rim has already played, so only new text ripples. */
const heard = new Map<string, ChatStreamText>();

function mount(button: HTMLElement): NonNullable<typeof rim> {
  if (rim && canvas?.parentElement === button) return rim;
  rim?.dispose();
  canvas = document.createElement('canvas');
  canvas.className = 'composer-wave';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.setProperty('--composer-wave-outset', `${OUTSET}px`);
  button.prepend(canvas);
  rim = mountWaveRim(canvas, { kind: 'border', outset: OUTSET });
  return rim;
}

/** Text added since the last snapshot; a shorter snapshot means a new round started over. */
function added(now: string, before: string | undefined): string {
  return before !== undefined && now.length >= before.length ? now.slice(before.length) : now;
}

function hear(chatId: string): void {
  const text = readChatStreamText(chatId);
  if (!text) return;
  const before = heard.get(chatId);
  heard.set(chatId, { ...text });
  // Background turns keep their place, so switching to one doesn't replay its whole reply.
  if (!rim || chatId !== getActiveChat().id) return;
  rim.feed(added(text.lastThinking, before?.lastThinking), 0.7);
  rim.feed(added(text.lastDelta, before?.lastDelta));
  const tools = text.toolCallCount - (before?.toolCallCount ?? 0);
  for (let index = 0; index < Math.min(tools, 4); index++) rim.pulse(0.9);
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
  if (!button || (!live && !rim)) return;
  listen();
  button.classList.toggle('is-model-working', live);
  mount(button).set(live ? 'live' : 'idle');
}
