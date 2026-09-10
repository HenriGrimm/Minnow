/**
 * Scan helpers for attempt reports.
 *
 * The Builder/Tester write-up is freeform prose. These helpers never parse it
 * for files or tests. Verdict facts come from journaled evidence keys only.
 */

/** Long enough to name what happened, short enough that a wall of text cannot hide behind it. */
export const SCENT_MAX_CHARS = 140;

export type AttemptScanFacts = {
  files: string[];
  blockers: string[];
  needs: string[];
  hasTestOutput: boolean;
};

const EMPTY_FACTS: AttemptScanFacts = {
  files: [],
  blockers: [],
  needs: [],
  hasTestOutput: false,
};

/** Policy reason → one line a person can act on. Unknown reasons stay readable, not kebab-case. */
const ABANDON_COPY: Record<string, string> = {
  user: 'Stopped by you. Review the attempts before restarting this task.',
  'builder-no-report': 'The builder did not file a report.',
  'builder-failed': 'The builder failed.',
  'builder-failed-twice': 'The builder failed twice.',
  'builder-blocked': 'The builder was blocked.',
  'builder-crashed': 'The builder crashed.',
  'builder-timeout': 'The builder timed out.',
  'tester-failed': 'Tests failed.',
  'tester-blocked': 'The tester was blocked.',
  'tester-no-report': 'The tester did not file a report.',
  'tester-crashed': 'The tester crashed.',
  'tester-timeout': 'The tester timed out.',
  'merge-conflicted': 'Merge hit conflicts.',
  'merge-failed': 'Merge could not run (environment, not conflicting content).',
  'final-test-failed': 'The final integration test failed.',
  'unhandled-outcome': 'The run ended on an outcome the policy table does not handle.',
};

export function humanizeAbandonReason(reason: string): string {
  const known = ABANDON_COPY[reason];
  if (known) return known;
  const words = reason.replace(/[-_]+/g, ' ').trim();
  if (!words) return reason;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/** Collapse whitespace so a scent is one line, not a wrapped dump. */
function flatten(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * First sentence when more prose follows; otherwise a word-bounded slice.
 * Used as the closed-state preview of a write-up, never as a parsed report.
 */
export function summaryScent(text: string, maxChars = SCENT_MAX_CHARS): string {
  const flat = flatten(text);
  if (!flat) return '';
  const sentenceEnd = flat.search(/[.!?](?=\s|$)/);
  const remainder = sentenceEnd >= 0 ? flat.slice(sentenceEnd + 1).trim() : '';
  if (remainder && sentenceEnd < maxChars) {
    return flat.slice(0, sentenceEnd + 1);
  }
  if (flat.length <= maxChars) return flat;
  const slice = flat.slice(0, maxChars);
  const breakAt = slice.lastIndexOf(' ');
  const cut = breakAt > 80 ? slice.slice(0, breakAt) : slice;
  return `${cut.replace(/[.,;:]+$/, '')}…`;
}

/** True when the full write-up would bury the verdict if left open. */
export function writeUpNeedsCollapse(text: string, maxChars = SCENT_MAX_CHARS): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return summaryScent(trimmed, maxChars) !== flatten(trimmed);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
}

/**
 * Walk journal evidence for the few keys a scan line can trust.
 * Nested `diff.files` counts; arbitrary prose under other keys does not.
 */
export function collectAttemptFacts(evidence: unknown): AttemptScanFacts {
  if (!evidence || typeof evidence !== 'object') return { ...EMPTY_FACTS };
  const files: string[] = [];
  const blockers: string[] = [];
  const needs: string[] = [];
  let hasTestOutput = false;

  const take = (key: string, value: unknown): void => {
    if (key === 'testOutput' && value != null && value !== '') hasTestOutput = true;
    if (key === 'files') files.push(...asStringList(value));
    if (key === 'blockers') blockers.push(...asStringList(value));
    if (key === 'needs') needs.push(...asStringList(value));
    if (key === 'diff' && value && typeof value === 'object' && !Array.isArray(value)) {
      files.push(...asStringList((value as { files?: unknown }).files));
    }
  };

  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (item && typeof item === 'object') {
        for (const [key, value] of Object.entries(item)) take(key, value);
      }
    }
    return {
      files: uniqueStrings(files),
      blockers: uniqueStrings(blockers),
      needs: uniqueStrings(needs),
      hasTestOutput,
    };
  }

  for (const [key, value] of Object.entries(evidence)) take(key, value);
  return {
    files: uniqueStrings(files),
    blockers: uniqueStrings(blockers),
    needs: uniqueStrings(needs),
    hasTestOutput,
  };
}

export function formatAttemptFacts(facts: AttemptScanFacts): string[] {
  const parts: string[] = [];
  if (facts.files.length === 1) parts.push('1 file');
  else if (facts.files.length > 1) parts.push(`${facts.files.length} files`);
  if (facts.blockers.length === 1) parts.push('1 blocker');
  else if (facts.blockers.length > 1) parts.push(`${facts.blockers.length} blockers`);
  if (facts.needs.length === 1) parts.push('1 requirement');
  else if (facts.needs.length > 1) parts.push(`${facts.needs.length} requirements`);
  if (facts.hasTestOutput) parts.push('Test output');
  return parts;
}
