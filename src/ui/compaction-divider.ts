import type { ContextNoticeMessage } from '../types';
import { createIcon } from './icon';

/** Compact token count: 142000 → "142k", 1450 → "1.5k". */
function formatK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(Math.round(tokens));
}

/** A `context` row that carries a v2 compaction checkpoint. */
export function isCompactionNotice(notice: unknown): notice is ContextNoticeMessage & {
  compaction: NonNullable<ContextNoticeMessage['compaction']>;
} {
  if (!notice || typeof notice !== 'object') return false;
  const row = notice as ContextNoticeMessage;
  return row.role === 'context' && row.compaction?.version === 1;
}

/** "Context compacted · 38 turns folded · 142k → 29k tokens" */
export function compactionDividerLabel(notice: ContextNoticeMessage): string {
  const compaction = notice.compaction;
  const parts = [compaction?.trigger === 'manual' ? 'Compacted manually' : 'Context compacted'];
  if (notice.droppedTurns > 0) {
    parts.push(`${notice.droppedTurns} turn${notice.droppedTurns === 1 ? '' : 's'} folded`);
  }
  const rounds = notice.droppedRounds ?? 0;
  if (rounds > 0) parts.push(`${rounds} tool round${rounds === 1 ? '' : 's'} folded`);
  if (compaction && compaction.tokensBefore > 0 && compaction.tokensAfter > 0) {
    parts.push(`${formatK(compaction.tokensBefore)} → ${formatK(compaction.tokensAfter)} tokens`);
  }
  return parts.join(' · ');
}

export interface CompactionDividerOptions {
  historyIndex?: number;
  /** A later checkpoint replaced this one; its fold no longer marks rows. */
  superseded?: boolean;
}

/**
 * Transcript divider for a compaction checkpoint. Everything above the latest
 * one is out of the model's context; expanding it shows the exact summary the
 * model reads instead.
 */
export function createCompactionDivider(
  notice: ContextNoticeMessage,
  options: CompactionDividerOptions = {},
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'compaction-divider';
  if (options.superseded) wrap.classList.add('compaction-divider--superseded');
  if (options.historyIndex != null) wrap.dataset.historyIndex = String(options.historyIndex);

  const details = document.createElement('details');
  details.className = 'compaction-divider__details';

  const summary = document.createElement('summary');
  summary.className = 'compaction-divider__summary';
  const label = document.createElement('span');
  label.className = 'compaction-divider__label';
  label.appendChild(createIcon('compress', { className: 'compaction-divider__icon', size: 14 }));
  const text = document.createElement('span');
  text.textContent = compactionDividerLabel(notice);
  label.appendChild(text);
  if (!options.superseded) {
    summary.setAttribute('aria-description', 'Messages above are not in the model context');
  }
  label.appendChild(createIcon('chevronDown', { className: 'compaction-divider__chevron', size: 13 }));
  summary.append(rule(), label, rule());

  const body = document.createElement('div');
  body.className = 'compaction-divider__body';
  const note = document.createElement('p');
  note.className = 'compaction-divider__note';
  note.textContent = options.superseded
    ? 'An earlier checkpoint. A later one folded more of the conversation.'
    : 'Messages above this line are not in the model context. The model reads this summary instead, and can look up exact details with recall_history.';
  body.appendChild(note);
  const summaryText = notice.compaction?.summary ?? notice.summaryText ?? '';
  if (summaryText.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'compaction-divider__text';
    pre.textContent = summaryText;
    body.appendChild(pre);
  }

  details.append(summary, body);
  wrap.appendChild(details);
  return wrap;
}

function rule(): HTMLElement {
  const line = document.createElement('span');
  line.className = 'compaction-divider__rule';
  line.setAttribute('aria-hidden', 'true');
  return line;
}

/** Class on transcript nodes the latest checkpoint folded (dimmed; the divider's note explains why). */
export const OUT_OF_CONTEXT_CLASS = 'is-out-of-context';

export function markOutOfContext(node: Element): void {
  // No title: on rows with a role it would replace their accessible name.
  node.classList.add(OUT_OF_CONTEXT_CLASS);
}
