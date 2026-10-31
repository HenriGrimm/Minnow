/** Pure utility tools shared by renderer and server execution. */
export const toolGetDatetime = () => new Date().toISOString();
const SAFE_CALC_CHARS = /^[0-9+\-*/().%\s,]+$/;
const SAFE_MATH_IDENT = /^Math\.(abs|ceil|floor|round|sqrt|pow|min|max|log|exp|sin|cos|tan|PI|E)$/;
export function toolCalculate(args) {
  const raw = args.expression;
  if (typeof raw !== 'string' || !raw.trim()) return 'Error: "expression" is required';
  const expression = raw.trim();
  const tokens = expression.split(/(Math\.[a-zA-Z]+)/g).filter(Boolean);
  if (expression.length > 4096 || !tokens.length || tokens.some(token => token.startsWith('Math.') ? !SAFE_MATH_IDENT.test(token) : !SAFE_CALC_CHARS.test(token))) {
    return 'Error: expression contains disallowed characters or tokens';
  }
  try {
    const result = new Function('Math', `"use strict"; return (${expression});`)(Math);
    return typeof result === 'number' && Number.isFinite(result) ? String(result) : 'Error: expression did not evaluate to a finite number';
  } catch (error) { return `Error: failed to evaluate expression (${error instanceof Error ? error.message : String(error)})`; }
}

export const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_WAIT_MS = 60_000;
export const DEFAULT_WAIT_REASON = 'waiting';
const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*([smh])/gi;
export function formatWaitDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return [Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}h` : '',
    Math.floor(seconds % 3600 / 60) ? `${Math.floor(seconds % 3600 / 60)}m` : '',
    seconds % 60 || seconds === 0 ? `${seconds % 60}s` : ''].join('');
}
export function parseWaitDuration(raw) {
  const invalid = shown => ({ ok: false, error: `Error: duration must be between 1s and 2h (got "${shown}"). Use "30s", "5m", or "1h30m".` });
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return invalid(String(raw));
    const ms = Math.round(raw * 1000);
    return ms > MAX_WAIT_MS ? invalid(String(raw)) : { ok: true, ms };
  }
  if (typeof raw !== 'string') return invalid(String(raw ?? ''));
  const text = raw.trim();
  if (!text) return invalid('');
  if (/^\d+(?:\.\d+)?$/.test(text)) return parseWaitDuration(Number(text));
  let ms = 0, matched = '';
  DURATION_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(DURATION_TOKEN)) {
    ms += Number(match[1]) * (match[2].toLowerCase() === 'h' ? 3_600_000 : match[2].toLowerCase() === 'm' ? 60_000 : 1000);
    matched += match[0];
  }
  if (!matched || matched.replace(/\s/g, '').length !== text.replace(/\s/g, '').length || !Number.isFinite(ms) || ms <= 0) return invalid(text);
  return ms > MAX_WAIT_MS ? invalid(text) : { ok: true, ms: Math.round(ms) };
}

export function waitWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Stopped', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
