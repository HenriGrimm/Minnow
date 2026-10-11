/**
 * llama-server log parsing — load phase and line severity.
 *
 * `parseLoadProgress` still only reports a percentage the runtime actually printed, and
 * no build since b9628 prints one. The modelled bar lives in `load-progress.mjs`; a real
 * number, if one ever appears, wins over it.
 */

import { matchLoadPhase } from './load-progress.mjs';
// Lives in load-progress.mjs so the tool server (plain node, no TS transform) can use it.
export { parseSpecContextBytes } from './load-progress.mjs';
import type { MatchedLoadPhase } from './load-progress.d.mts';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'plain';

/** One event from `subscribeServeLog`: the existing tail, then appended deltas. */
export type ServeLogChunk = {
  text?: string;
  offset?: number;
  initial?: boolean;
};

/**
 * Fold one log-stream event into the text we already have.
 *
 * The SSE emits the existing tail (`initial: true`) then appended chunks.
 * Replacing the buffer with every event drops phase markers printed earlier,
 * which pins the modelled load bar at the spawning floor (0%).
 */
export function foldServeLogEvent(previous: string, event: ServeLogChunk): string {
  const chunk = typeof event.text === 'string' ? event.text : '';
  return event.initial ? chunk : `${previous}${chunk}`;
}

/** Percent forms llama.cpp has used across builds. `loader` and jinja `{%` are not progress. */
const PERCENT_PATTERNS = [
  /load(?:ing|ed)?[^\n]{0,80}?progress\s*[:=]\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
  /\bloading\s+(\d{1,3}(?:\.\d+)?)\s*%/i,
  /progress\s*[:=]\s*(\d{1,3}(?:\.\d+)?)\s*%/i,
];
/** Fractional form: `progress = 0.0917`. */
const FRACTION_PATTERN = /progress\s*[:=]\s*(0?\.\d+|1\.0+)\b/i;

/**
 * Last load-progress percentage in a chunk of log text, or null when the
 * runtime reported none.
 */
export function parseLoadProgress(text: string): number | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    for (const pattern of PERCENT_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const value = Number.parseFloat(match[1]);
        if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
      }
    }
    const fraction = line.match(FRACTION_PATTERN);
    if (fraction) {
      const value = Number.parseFloat(fraction[1]) * 100;
      if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
    }
  }
  return null;
}

/** Coarse severity for log-line tinting. */
export function classifyLogLine(line: string): LogLevel {
  if (/\b(error|failed|fatal|panic|terminate called)\b/i.test(line)) return 'error';
  if (/\b(warn|warning|deprecated)\b/i.test(line)) return 'warn';
  if (/\b(debug|verbose|trace)\b/i.test(line)) return 'debug';
  if (/\b(info|loaded|listening|starting|server is)\b/i.test(line)) return 'info';
  return 'plain';
}

/**
 * Split raw output without filtering messages or withholding partial writes.
 * Consumers can request a trailing line limit; the runtime pane shows all output.
 */
export function toLogLines(text: string, maxLines = Infinity): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
  return lines;
}

/** llama-server prints this on a timer while nothing is in a slot. */
const IDLE_SLOT_LINE = /update_slots:\s*all slots are idle/i;

/** True for the idle-slot heartbeat that otherwise drowns the Local Server log. */
export function isIdleSlotLogLine(line: string): boolean {
  return IDLE_SLOT_LINE.test(line);
}

/**
 * Phase of a starting serve, read from the tail of its log.
 *
 * The phase table lives in `load-progress.mjs` because the progress bar needs each
 * phase's floor and ceiling, not just its name — keeping two lists in step was the
 * obvious way to end up with a label that disagreed with the bar.
 */
export function matchServeLoadPhase(text: string): MatchedLoadPhase {
  return matchLoadPhase(text);
}

/** Human phase label for a starting serve. */
export function describeLoadPhase(text: string): string {
  return matchLoadPhase(text).label;
}
