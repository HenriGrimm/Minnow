/**
 * Impeccable `detect` exits 2 when it found anti-patterns.
 * That is a successful scan, not a tool crash — chat UI must not paint it as failed.
 */

/** First-line banner the wrapper used to emit (and may still appear on old servers). */
const DETECT_EXIT_2_LINE = /^(?:Error:\s*)?impeccable detect exited 2\b/i;

const FINDINGS_COUNT_LINE = /(\d+)\s+anti-patterns?\s+found/i;

/**
 * True when the tool string is a completed detect scan with findings (CLI exit 2).
 * Real crashes stay `Error: impeccable detect exited 1` (and other codes).
 */
export function isImpeccableDetectFindingsResult(result: string): boolean {
  const text = String(result ?? '').trimStart();
  if (!text) return false;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (DETECT_EXIT_2_LINE.test(firstLine.trim())) return true;
  return /^\d+\s+anti-patterns?\s+found\./i.test(text);
}

/**
 * Count from the summary line or a leading JSON array of findings.
 */
export function parseImpeccableDetectFindingsCount(result: string): number | undefined {
  const text = String(result ?? '');
  const counted = FINDINGS_COUNT_LINE.exec(text);
  if (counted) {
    const n = Number.parseInt(counted[1], 10);
    return Number.isFinite(n) ? n : undefined;
  }
  const stripped = text.replace(DETECT_EXIT_2_LINE, '').replace(/^\s+/, '');
  const jsonish = stripped.replace(/^\d+\s+anti-patterns?\s+found\.\s*/i, '').trim();
  if (!jsonish.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(jsonish);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drop a leftover `Error: impeccable detect exited 2` first line so the model
 * and the card see the findings body, not a fake spawn failure.
 */
export function stripImpeccableDetectExitBanner(result: string): string {
  const text = String(result ?? '');
  const trimmedStart = text.trimStart();
  const nl = trimmedStart.indexOf('\n');
  const first = (nl === -1 ? trimmedStart : trimmedStart.slice(0, nl)).trim();
  if (!DETECT_EXIT_2_LINE.test(first)) return text;
  if (nl === -1) return '';
  return trimmedStart.slice(nl + 1).replace(/^\s+/, '');
}
