import { apiMessageContentToText } from '../api/message-content.ts';
import { isHiddenTranscriptUserMessage } from '../chat/hidden-transcript-user-messages.ts';
import type {
  ApiMessageContent,
  CodeChangeStats,
  ToolImageAttachment,
} from '../types';
import { normalizeCodeChangePayload } from '../usage/code-change-payload';
import { humanizeToolName } from './tool-messages';
import { renderToolCall, renderToolResult } from './tool-messages';
import type { SubAgentTranscriptLive } from './sub-agent-live-status';
import {
  STREAM_LABEL_GENERATING,
  STREAM_LABEL_THINKING,
} from './stream-status';
import { splitThinkingSegments } from '../api/reasoning';
import { renderThoughtsToggle, updateThoughtsToggleSegments } from './thought-bubbles';

/** Parse stored tool `arguments` JSON for display. */
export function parseToolArgsForTranscriptDisplay(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

/** Render multimodal user content (text blocks + inline images). */
function appendUserTranscriptRow(body: HTMLElement, content: ApiMessageContent): void {
  const wrap = document.createElement('div');
  wrap.className = 'transcript-view__user';

  if (typeof content === 'string') {
    wrap.textContent = content;
    body.appendChild(wrap);
    return;
  }

  if (!Array.isArray(content)) {
    wrap.textContent = apiMessageContentToText(content);
    body.appendChild(wrap);
    return;
  }

  for (const part of content) {
    if (part.type === 'text' && part.text) {
      const textEl = document.createElement('p');
      textEl.className = 'transcript-view__user-text';
      textEl.textContent = part.text;
      wrap.appendChild(textEl);
      continue;
    }
    if (part.type === 'image_url' && part.image_url?.url) {
      const img = document.createElement('img');
      img.className = 'transcript-view__user-image';
      img.src = part.image_url.url;
      img.alt = 'Attached image';
      img.loading = 'lazy';
      wrap.appendChild(img);
    }
  }

  if (!wrap.childNodes.length) {
    wrap.textContent = apiMessageContentToText(content);
  }

  body.appendChild(wrap);
}

/** Reasoning channel text stored on an assistant message (wire / hydrate fields). */
function assistantTranscriptReasoning(msg: Record<string, unknown>): string {
  if (typeof msg.reasoning === 'string' && msg.reasoning.trim()) {
    return msg.reasoning.trim();
  }
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    return msg.reasoning_content.trim();
  }
  return '';
}

/** Thinking segments for the Thoughts toggle — main-chat `thinking[]` first, then sub-agent hydrate `reasoning` / `reasoning_content`. */
export function assistantTranscriptThinkingSegments(
  msg: Record<string, unknown>,
): string[] {
  if (Array.isArray(msg.thinking)) {
    const fromArray = msg.thinking.filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    );
    if (fromArray.length > 0) return fromArray;
  }
  const reasoning = assistantTranscriptReasoning(msg);
  return reasoning ? [reasoning] : [];
}

/** Visible assistant prose from `content` only (never the reasoning channel). */
function assistantTranscriptContentProse(msg: Record<string, unknown>): string {
  return apiMessageContentToText(msg.content as ApiMessageContent).trim();
}

/** Options when painting a settled assistant row inside a live run. */
interface AssistantTranscriptPaintOpts {
  /** Pulse the Thoughts caret while this row is the live reasoning turn. */
  liveThinking?: boolean;
  thinkingDurationMs?: number;
}

/** Paint Thoughts (main-chat toggle) then prose. */
function appendAssistantTranscriptRow(
  body: HTMLElement,
  msg: Record<string, unknown>,
  opts: AssistantTranscriptPaintOpts = {},
): void {
  const prose = assistantTranscriptContentProse(msg);
  const segments = assistantTranscriptThinkingSegments(msg);
  if (!prose && segments.length === 0) return;

  const wrap = document.createElement('div');
  wrap.className = 'transcript-view__assistant-turn';

  if (segments.length > 0) {
    renderThoughtsToggle(wrap, segments, {
      pulse: opts.liveThinking === true,
      label: opts.liveThinking === true ? STREAM_LABEL_THINKING : undefined,
      durationMs:
        !opts.liveThinking &&
        opts.thinkingDurationMs != null &&
        opts.thinkingDurationMs > 0
          ? opts.thinkingDurationMs
          : undefined,
    });
  }

  if (prose) {
    const row = document.createElement('div');
    row.className = 'transcript-view__assistant';
    row.textContent = prose;
    wrap.appendChild(row);
  }

  body.appendChild(wrap);
}

/** Build the animated dots + label row used during live sub-agent turns. */
export function createTranscriptStreamStatus(
  phase: 'thinking' | 'generating',
): HTMLElement {
  const statusEl = document.createElement('div');
  statusEl.className = `stream-status stream-status--${phase} transcript-view__stream-status`;
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
  labelEl.textContent =
    phase === 'thinking' ? STREAM_LABEL_THINKING : STREAM_LABEL_GENERATING;

  statusEl.appendChild(dots);
  statusEl.appendChild(labelEl);
  return statusEl;
}

/** Inline tool-call spinner while a nested tool executes or streams in. */
function createTranscriptToolIndicator(toolName: string): HTMLElement {
  const indicatorEl = document.createElement('div');
  indicatorEl.className = 'tool-start-indicator transcript-view__tool-indicator';
  indicatorEl.setAttribute('role', 'status');
  indicatorEl.setAttribute('aria-live', 'polite');

  const spinner = document.createElement('span');
  spinner.className = 'tool-call-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = 'tool-start-indicator__label';
  labelEl.textContent = `Calling ${humanizeToolName(toolName)}…`;

  indicatorEl.appendChild(spinner);
  indicatorEl.appendChild(labelEl);
  return indicatorEl;
}

/** Append a throttled generating tail so "Generating response…" is never an empty row. */
function appendGeneratingPartial(tail: HTMLElement, live: SubAgentTranscriptLive): void {
  const partial = live.partialText?.trim();
  if (!partial) return;
  const row = document.createElement('div');
  row.className = 'transcript-view__assistant transcript-view__assistant--partial';
  row.textContent = partial;
  tail.appendChild(row);
}

/**
 * Thinking already carried by the row a live tail belongs to — the last
 * assistant turn. Scoped to that row, not the whole thread: an older row's
 * thoughts must not suppress the tail for a turn that has none yet.
 */
function lastAssistantThinkingSegments(messages: unknown[]): string[] {
  const index = lastAssistantMessageIndex(messages);
  if (index < 0) return [];
  const msg = messages[index] as Record<string, unknown>;
  return assistantTranscriptThinkingSegments(msg);
}

/**
 * Grow the Thoughts panel mounted on the live assistant row.
 *
 * Mid-chain reasoning arrives as a coalesced event that rewrites the same
 * thought in place, so the last segment is replaced when the new text continues
 * it, and appended when it opens a chain the transcript has not recorded yet.
 * Earlier segments of the same turn are left alone.
 */
function syncLiveThinkingRow(
  body: HTMLElement,
  messages: unknown[],
  reasoning: string,
): void {
  const stored = lastAssistantThinkingSegments(messages);
  if (stored.length === 0) return;
  const turns = body.querySelectorAll<HTMLElement>('.transcript-view__assistant-turn');
  const wrap = turns[turns.length - 1]?.querySelector<HTMLElement>('.thoughts-panel-wrap');
  if (!wrap) return;
  // Split the same way the panel does, or a turn stored as one joined string
  // would compare as a single segment and the open thought would double up.
  const split = splitThinkingSegments(stored.join('\n\n'));
  const segments = split.length > 0 ? split : stored;
  const last = segments[segments.length - 1];
  const next =
    reasoning.startsWith(last) || last.startsWith(reasoning)
      ? [...segments.slice(0, -1), reasoning]
      : [...segments, reasoning];
  updateThoughtsToggleSegments(wrap, next);
}

export function appendTranscriptLiveTail(
  body: HTMLElement,
  live: SubAgentTranscriptLive | undefined,
  messages: unknown[] = [],
): void {
  const existing = body.querySelector<HTMLElement>('.transcript-view__live-tail');
  if (!live?.isLive) {
    existing?.remove();
    return;
  }

  const phase = live.phase ?? 'generating';
  const toolName = live.currentToolName?.trim() ?? '';

  // A hydrated thinking event lives in the assistant row, not the live tail.
  // Keep that mounted panel current when callers only patch streaming activity.
  if (phase === 'thinking' && lastAssistantThinkingSegments(messages).length > 0) {
    const reasoning = live.partialReasoning?.trim();
    if (reasoning) syncLiveThinkingRow(body, messages, reasoning);
    existing?.remove();
    return;
  }

  if (existing && canReuseLiveTail(existing, phase, toolName)) {
    syncReusedLiveTail(existing, live, messages);
    return;
  }

  existing?.remove();
  const tail = document.createElement('div');
  tail.className = 'transcript-view__live-tail';
  tail.dataset.livePhase = phase;
  if (toolName) tail.dataset.toolName = toolName;

  fillLiveTail(tail, live, messages);

  if (tail.childNodes.length > 0) {
    body.appendChild(tail);
  }
}

/** Same phase (and tool name) means the existing tail can mutate instead of remount. */
function canReuseLiveTail(
  tail: HTMLElement,
  phase: string,
  toolName: string,
): boolean {
  if (tail.dataset.livePhase !== phase) return false;
  if (phase === 'tools') return tail.dataset.toolName === toolName || !toolName;
  return true;
}

/** Grow thinking text / generating partials on an already-mounted live tail. */
function syncReusedLiveTail(
  tail: HTMLElement,
  live: SubAgentTranscriptLive,
  messages: unknown[],
): void {
  const phase = live.phase;
  if (phase === 'thinking') {
    if (lastAssistantThinkingSegments(messages).length > 0) {
      tail.remove();
      return;
    }
    const reasoning = live.partialReasoning?.trim();
    const toggleWrap = tail.querySelector('.thoughts-panel-wrap');
    if (toggleWrap instanceof HTMLElement && reasoning) {
      updateThoughtsToggleSegments(toggleWrap, [reasoning]);
      return;
    }
    if (!toggleWrap && reasoning) {
      tail.replaceChildren();
      renderThoughtsToggle(tail, [reasoning], liveThoughtsToggleOptions(live));
    }
    return;
  }
  if (phase === 'generating') {
    syncGeneratingPartial(tail, live);
    return;
  }
  if (phase === 'tools') {
    const toolName = live.currentToolName?.trim();
    const label = tail.querySelector('.tool-start-indicator__label');
    if (label && toolName) {
      const next = `Calling ${humanizeToolName(toolName)}…`;
      if (label.textContent !== next) label.textContent = next;
      tail.dataset.toolName = toolName;
    }
  }
}

function liveThoughtsToggleOptions(live: SubAgentTranscriptLive): {
  pulse: true;
  label: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
} {
  return {
    pulse: true,
    label: STREAM_LABEL_THINKING,
    ...(live.thoughtsExpanded ? { expanded: true } : {}),
    ...(live.onThoughtsExpandedChange
      ? { onExpandedChange: live.onThoughtsExpandedChange }
      : {}),
  };
}

function fillLiveTail(
  tail: HTMLElement,
  live: SubAgentTranscriptLive,
  messages: unknown[],
): void {
  const phase = live.phase;
  const toolName = live.currentToolName?.trim();

  if (phase === 'thinking') {
    if (lastAssistantThinkingSegments(messages).length === 0) {
      const reasoning = live.partialReasoning?.trim();
      if (reasoning) {
        renderThoughtsToggle(tail, [reasoning], liveThoughtsToggleOptions(live));
      } else {
        tail.appendChild(createTranscriptStreamStatus('thinking'));
      }
    }
  } else if (phase === 'generating') {
    tail.appendChild(createTranscriptStreamStatus('generating'));
    appendGeneratingPartial(tail, live);
  } else if (phase === 'tools' && toolName) {
    tail.appendChild(createTranscriptToolIndicator(toolName));
  } else if (live.isLive) {
    tail.dataset.livePhase = 'generating';
    tail.appendChild(createTranscriptStreamStatus('generating'));
    appendGeneratingPartial(tail, live);
  }
}

/** Keep "Generating response…" and grow the partial row without remounting. */
function syncGeneratingPartial(tail: HTMLElement, live: SubAgentTranscriptLive): void {
  const text = live.partialText?.trim();
  if (!text) return;
  let partial = tail.querySelector<HTMLElement>('.transcript-view__assistant--partial');
  if (!partial) {
    partial = document.createElement('div');
    partial.className = 'transcript-view__assistant transcript-view__assistant--partial';
    tail.appendChild(partial);
  }
  if (partial.textContent !== text) partial.textContent = text;
}

/** Index of the last assistant row (for live Thinking… pulse on that turn). */
function lastAssistantMessageIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i];
    if (!raw || typeof raw !== 'object') continue;
    if ((raw as Record<string, unknown>).role === 'assistant') return i;
  }
  return -1;
}

/** Render API-shaped messages into a scrollable transcript body. */
export function renderTranscriptView(
  body: HTMLElement,
  messages: unknown[],
  live?: SubAgentTranscriptLive,
): void {
  body.replaceChildren();
  const toolResultMap = new Map<
    string,
    {
      content: string;
      attachments?: ToolImageAttachment[];
      codeChange?: CodeChangeStats;
    }
  >();

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      const attachments = Array.isArray(msg.attachments)
        ? (msg.attachments as ToolImageAttachment[])
        : undefined;
      const codeChange = normalizeCodeChangePayload(msg.codeChange);
      toolResultMap.set(msg.tool_call_id, {
        content: String(msg.content ?? ''),
        ...(attachments?.length ? { attachments } : {}),
        ...(codeChange ? { codeChange } : {}),
      });
    }
  }

  const liveThinkingIdx =
    live?.isLive && live.phase === 'thinking' ? lastAssistantMessageIndex(messages) : -1;

  for (let i = 0; i < messages.length; i += 1) {
    const raw = messages[i];
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.role;
    if (role === 'system') {
      const row = document.createElement('div');
      row.className = 'transcript-view__system';
      const full =
        typeof msg.content === 'string' ? msg.content : '[system prompt omitted]';
      row.textContent =
        full.length > 800
          ? `${full.slice(0, 800)}… (${full.length} characters total)`
          : full;
      body.appendChild(row);
      continue;
    }
    if (role === 'user') {
      if (
        typeof msg.content === 'string' &&
        isHiddenTranscriptUserMessage({ role: 'user', content: msg.content })
      ) {
        continue;
      }
      appendUserTranscriptRow(body, msg.content as ApiMessageContent);
      continue;
    }
    if (role === 'assistant') {
      const toolCalls = msg.tool_calls;
      const contentProse = assistantTranscriptContentProse(msg);
      const segments = assistantTranscriptThinkingSegments(msg);
      const durationRaw = msg.thinkingDurationMs;
      const thinkingDurationMs =
        typeof durationRaw === 'number' && Number.isFinite(durationRaw)
          ? durationRaw
          : undefined;

      appendAssistantTranscriptRow(body, msg, {
        liveThinking: i === liveThinkingIdx && segments.length > 0,
        thinkingDurationMs,
      });

      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        for (const tc of toolCalls as Array<{
          id: string;
          function: { name: string; arguments: string };
        }>) {
          const argsObj = parseToolArgsForTranscriptDisplay(tc.function.arguments);
          const wrap = renderToolCall(tc.function.name, argsObj);
          body.appendChild(wrap);
          const stored = toolResultMap.get(tc.id);
          if (stored) {
            renderToolResult(
              wrap,
              stored.content,
              stored.attachments,
              argsObj,
              stored.codeChange,
            );
          }
        }
      }
      if (
        !contentProse &&
        segments.length === 0 &&
        (!Array.isArray(toolCalls) || toolCalls.length === 0)
      ) {
        const row = document.createElement('div');
        row.className = 'transcript-view__assistant';
        row.textContent = '(empty assistant message)';
        body.appendChild(row);
      }
      continue;
    }
    if (role === 'tool') {
      continue;
    }
  }

  appendTranscriptLiveTail(body, live, messages);
}
