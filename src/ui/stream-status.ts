import { formatThinkingDuration } from './thinking-duration';
import { humanizeToolName } from './tool-messages';

export type StreamPhase =
  | 'loading_model'
  | 'prompt_processing'
  | 'generating'
  | 'thinking'
  | 'prose'
  | 'done';

/** Visible while the local model is loading into memory before the first token. */
export const STREAM_LABEL_LOADING_MODEL = 'Loading model…';

/** Visible while llama.cpp is still feeding the prompt through. */
export const STREAM_LABEL_PROMPT_PROCESSING = 'Processing prompt…';

/** Visible while waiting for reasoning or prose (no tokens yet). */
export const STREAM_LABEL_GENERATING = 'Generating response…';

/** Visible while reasoning SSE is active (thought bubbles are primary). */
export const STREAM_LABEL_THINKING = 'Thinking…';

const LABEL_BY_PHASE: Record<
  'loading_model' | 'prompt_processing' | 'generating' | 'thinking',
  string
> = {
  loading_model: STREAM_LABEL_LOADING_MODEL,
  prompt_processing: STREAM_LABEL_PROMPT_PROCESSING,
  generating: STREAM_LABEL_GENERATING,
  thinking: STREAM_LABEL_THINKING,
};

export interface StreamingStatusHandle {
  setPhase(phase: StreamPhase): void;
  /** Muted elapsed suffix while phase is `thinking`; pass null to clear. */
  setThinkingElapsed(ms: number | null): void;
  /** Runtime detail beside the label: prefill percent during `prompt_processing`, a token count while generating. */
  setRuntimeDetail(detail: string | null): void;
  dispose(): void;
}

/** Shared pending-state bubble for message delivery and response generation. */
export function createStreamStatusElement(text = STREAM_LABEL_GENERATING): HTMLDivElement {
  const statusEl = document.createElement('div');
  statusEl.className = 'stream-status stream-status--generating';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.setAttribute('aria-busy', 'true');

  const dots = document.createElement('span');
  dots.className = 'stream-status__dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'stream-status__dot';
    dots.appendChild(dot);
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'stream-status__label';
  labelEl.textContent = text;

  const elapsedEl = document.createElement('span');
  elapsedEl.className = 'stream-status__elapsed';
  elapsedEl.hidden = true;
  elapsedEl.setAttribute('aria-hidden', 'true');

  const detailEl = document.createElement('span');
  detailEl.className = 'stream-status__detail';
  detailEl.hidden = true;
  detailEl.setAttribute('aria-hidden', 'true');

  statusEl.appendChild(dots);
  statusEl.appendChild(labelEl);
  statusEl.appendChild(elapsedEl);
  statusEl.appendChild(detailEl);
  return statusEl;
}

/**
 * Inserts a status row after the assistant label; caller owns the parent `wrap`.
 */
export function attachStreamStatus(wrap: HTMLElement): StreamingStatusHandle {
  const statusEl = createStreamStatusElement();
  const labelEl = statusEl.querySelector<HTMLElement>('.stream-status__label')!;
  const elapsedEl = statusEl.querySelector<HTMLElement>('.stream-status__elapsed')!;
  const detailEl = statusEl.querySelector<HTMLElement>('.stream-status__detail')!;

  const label = wrap.querySelector('.msg-label');
  const bubble = wrap.querySelector('.msg-bubble');
  if (bubble && bubble.parentElement === wrap) {
    wrap.insertBefore(statusEl, bubble);
  } else if (label) {
    label.insertAdjacentElement('afterend', statusEl);
  } else {
    wrap.prepend(statusEl);
  }

  wrap.dataset.streamPhase = 'generating';

  let disposed = false;
  let currentPhase: StreamPhase = 'generating';

  const syncElapsedVisibility = (): void => {
    const show =
      currentPhase === 'thinking' && (elapsedEl.textContent?.length ?? 0) > 0;
    elapsedEl.hidden = !show;
  };

  const setThinkingElapsed = (ms: number | null): void => {
    if (disposed) return;
    if (ms == null || ms <= 0) {
      elapsedEl.textContent = '';
      elapsedEl.hidden = true;
      return;
    }
    elapsedEl.textContent = ` ${formatThinkingDuration(ms)}`;
    syncElapsedVisibility();
  };

  const setRuntimeDetail = (detail: string | null): void => {
    if (disposed) return;
    const text = detail?.trim() ? ` ${detail.trim()}` : '';
    if (detailEl.textContent === text) {
      syncToolStartDetail(wrap, text);
      return;
    }
    detailEl.textContent = text;
    detailEl.hidden = !text;
    syncToolStartDetail(wrap, text);
  };

  const setPhase = (phase: StreamPhase): void => {
    if (disposed) return;
    currentPhase = phase;

    if (phase === 'prose' || phase === 'done') {
      elapsedEl.textContent = '';
      elapsedEl.hidden = true;
      detailEl.textContent = '';
      detailEl.hidden = true;
      statusEl.classList.add('hidden');
      statusEl.setAttribute('aria-busy', 'false');
      wrap.dataset.streamPhase = phase;
      return;
    }

    statusEl.classList.remove('hidden');
    statusEl.setAttribute('aria-busy', 'true');
    statusEl.classList.remove(
      'stream-status--loading-model',
      'stream-status--prompt-processing',
      'stream-status--generating',
      'stream-status--thinking',
    );
    if (phase === 'thinking') {
      statusEl.classList.add('stream-status--thinking');
    } else if (phase === 'loading_model') {
      statusEl.classList.add('stream-status--loading-model');
    } else if (phase === 'prompt_processing') {
      statusEl.classList.add('stream-status--prompt-processing');
    } else {
      statusEl.classList.add('stream-status--generating');
    }
    labelEl.textContent = LABEL_BY_PHASE[phase];
    wrap.dataset.streamPhase = phase;
    if (phase !== 'thinking') {
      elapsedEl.hidden = true;
    } else {
      syncElapsedVisibility();
    }
  };

  const dispose = (): void => {
    disposed = true;
    statusEl.remove();
    delete wrap.dataset.streamPhase;
  };

  return { setPhase, setThinkingElapsed, setRuntimeDetail, dispose };
}

/** Row parts needed to show an in-flight tool-call indicator beside streaming prose. */
export interface ToolStartIndicatorRow {
  wrap: HTMLElement;
  bubble: HTMLElement;
  cursor: HTMLElement;
  streamStatus: StreamingStatusHandle;
}

export interface ToolStartIndicatorHandle {
  show(toolName: string): void;
  dispose(): void;
}

/** Keep token detail on the tool-start row while stream-status is hidden. */
function syncToolStartDetail(wrap: HTMLElement, text: string): void {
  const detail = wrap.querySelector<HTMLElement>('.tool-start-indicator__detail');
  if (!detail) return;
  if (detail.textContent === text) return;
  detail.textContent = text;
  detail.hidden = !text;
}

/** Inline "Calling {tool}…" spinner shown while tool_calls JSON streams in (before finalized tool-call bubbles render). */
export function attachToolStartIndicator(row: ToolStartIndicatorRow): ToolStartIndicatorHandle {
  let indicatorEl: HTMLDivElement | null = null;
  let labelEl: HTMLSpanElement | null = null;
  let disposed = false;

  const show = (toolName: string): void => {
    if (disposed || !toolName.trim()) return;

    row.cursor.style.display = 'none';
    const statusEl = row.wrap.querySelector('.stream-status');
    statusEl?.classList.add('hidden');

    if (!indicatorEl) {
      indicatorEl = document.createElement('div');
      indicatorEl.className = 'tool-start-indicator';
      indicatorEl.setAttribute('role', 'status');
      indicatorEl.setAttribute('aria-live', 'polite');

      const spinner = document.createElement('span');
      spinner.className = 'tool-call-spinner';
      spinner.setAttribute('aria-hidden', 'true');

      labelEl = document.createElement('span');
      labelEl.className = 'tool-start-indicator__label';

      const detailEl = document.createElement('span');
      detailEl.className = 'tool-start-indicator__detail';
      detailEl.hidden = true;
      detailEl.setAttribute('aria-hidden', 'true');

      indicatorEl.appendChild(spinner);
      indicatorEl.appendChild(labelEl);
      indicatorEl.appendChild(detailEl);
      row.bubble.insertAdjacentElement('afterend', indicatorEl);
    }

    if (labelEl) {
      labelEl.textContent = `Calling ${humanizeToolName(toolName)}…`;
    }
    const current = row.wrap.querySelector('.stream-status__detail')?.textContent ?? '';
    syncToolStartDetail(row.wrap, current);
  };

  const dispose = (): void => {
    disposed = true;
    indicatorEl?.remove();
    indicatorEl = null;
    labelEl = null;
  };

  return { show, dispose };
}
