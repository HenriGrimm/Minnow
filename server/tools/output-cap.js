import { truncateUtf8 } from '../../src/lib/fetch-web-content.mjs';

export const DEFAULT_MAX_OUTPUT_CHARS = 128_000;

export const DEFAULT_MAX_LINE_CHARS = 2_000;

export const TOOL_OUTPUT_MAX_CHARS_MIN = 8_000;

export const TOOL_OUTPUT_MAX_CHARS_MAX = 2_000_000;

export const MAX_READ_FILE_BYTES = 25 * 1024 * 1024;

export const PROCESS_MAX_ACCUMULATE_BYTES = 5 * 1024 * 1024;

export const GREP_MAX_OUTPUT_CHARS = DEFAULT_MAX_OUTPUT_CHARS;
export const GREP_MAX_LINE_CHARS = DEFAULT_MAX_LINE_CHARS;

/**
 * @typedef {{ applyResultCap: boolean, maxOutputChars: number, maxLineChars: number }} OutputCapPolicy
 */

/**
 * @type {OutputCapPolicy | undefined}
 */
let fallbackPolicy;

/**
 * @typedef {{ getStore: () => (OutputCapPolicy | undefined), run: (policy: OutputCapPolicy, fn: () => unknown) => unknown }} OutputCapStore
 */

/** @type {OutputCapStore} */
let outputCapStore = {
  getStore() {
    return fallbackPolicy;
  },
  run(policy, fn) {
    const previous = fallbackPolicy;
    fallbackPolicy = policy;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(() => {
          fallbackPolicy = previous;
        });
      }
      fallbackPolicy = previous;
      return result;
    } catch (err) {
      fallbackPolicy = previous;
      throw err;
    }
  },
};

/**
 * @param {OutputCapStore} store
 */
export function installOutputCapStore(store) {
  outputCapStore = store;
}

/**
 * @param {unknown} args
 */
export function argsRequestFullResult(args) {
  if (!args || typeof args !== 'object') return false;
  const row = /** @type {Record<string, unknown>} */ (args);
  return row.full_result === true || row.full === true;
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: boolean, maxChars: number }}
 */
export function normalizeToolOutputConfig(raw) {
  let enabled = true;
  let maxChars = DEFAULT_MAX_OUTPUT_CHARS;
  if (raw && typeof raw === 'object') {
    const row = /** @type {Record<string, unknown>} */ (raw);
    if (typeof row.enabled === 'boolean') {
      enabled = row.enabled;
    }
    if (typeof row.maxChars === 'number' && Number.isFinite(row.maxChars)) {
      maxChars = Math.min(
        TOOL_OUTPUT_MAX_CHARS_MAX,
        Math.max(TOOL_OUTPUT_MAX_CHARS_MIN, Math.floor(row.maxChars)),
      );
    }
  }
  return { enabled, maxChars };
}

/** Floor for a per-call `max_output_chars` request. */
export const PER_CALL_MIN_OUTPUT_CHARS = 500;

/**
 * A per-call `max_output_chars` may shrink the configured budget but not raise it
 * — the configured budget is the user's ceiling, and full_result is the escape hatch.
 *
 * @param {unknown} args
 * @param {number} configuredMax
 * @returns {number}
 */
export function resolvePerCallMaxChars(args, configuredMax) {
  if (!args || typeof args !== 'object') return configuredMax;
  const raw = Number(/** @type {Record<string, unknown>} */ (args).max_output_chars);
  if (!Number.isFinite(raw)) return configuredMax;
  return Math.min(configuredMax, Math.max(PER_CALL_MIN_OUTPUT_CHARS, Math.floor(raw)));
}

/**
 * @param {unknown} toolOutput
 * @param {unknown} args
 * @returns {OutputCapPolicy}
 */
export function resolveOutputCapPolicy(toolOutput, args) {
  const normalized = normalizeToolOutputConfig(toolOutput);
  const applyResultCap = normalized.enabled && !argsRequestFullResult(args);
  return {
    applyResultCap,
    maxOutputChars: resolvePerCallMaxChars(args, normalized.maxChars),
    maxLineChars: DEFAULT_MAX_LINE_CHARS,
  };
}

function defaultOutputCapPolicy() {
  return {
    applyResultCap: true,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    maxLineChars: DEFAULT_MAX_LINE_CHARS,
  };
}

export function getOutputCapPolicy() {
  return outputCapStore.getStore() ?? defaultOutputCapPolicy();
}

/**
 * @template T
 * @param {OutputCapPolicy} policy
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithOutputCapPolicy(policy, fn) {
  return outputCapStore.run(policy, fn);
}

/**
 * @param {string} hint
 * @param {boolean} [applyResultCap]
 */
export function withFullResultFooterHint(hint, applyResultCap = getOutputCapPolicy().applyResultCap) {
  if (!applyResultCap) return hint;
  return `${hint}; or pass full_result: true`;
}

/**
 * @param {string} line
 * @param {number} [maxLineChars]
 */
export function capLineLength(line, maxLineChars = DEFAULT_MAX_LINE_CHARS) {
  if (line.length <= maxLineChars) return line;
  if (maxLineChars <= 3) return line.slice(0, maxLineChars);
  return `${line.slice(0, maxLineChars - 3)}...`;
}

/**
 * @param {string} current
 * @param {string} chunk
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function appendWithByteCap(current, chunk, maxBytes = PROCESS_MAX_ACCUMULATE_BYTES) {
  const next = current + chunk;
  const nextBytes = Buffer.byteLength(next, 'utf8');
  if (nextBytes <= maxBytes) {
    return { text: next, truncated: false };
  }

  const currentBytes = Buffer.byteLength(current, 'utf8');
  if (currentBytes >= maxBytes) {
    return { text: current, truncated: true };
  }

  const remainingBytes = maxBytes - currentBytes;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const chunkBytes = encoder.encode(chunk);
  let end = Math.min(remainingBytes, chunkBytes.length);
  while (end > 0 && (chunkBytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const partial = decoder.decode(chunkBytes.slice(0, end));
  return { text: current + partial, truncated: true };
}

/**
 * @param {{ applyResultCap?: boolean, maxOutputChars?: number }} options
 * @param {OutputCapPolicy} policy
 */
function shouldApplyTextCap(options, policy) {
  if (typeof options.applyResultCap === 'boolean') {
    return options.applyResultCap;
  }
  if (options.maxOutputChars != null) {
    return true;
  }
  return policy.applyResultCap;
}

/**
 * Keep only the requested head/tail lines of a stream, noting what was dropped.
 *
 * Lives here rather than in process-runner because the renderer runs agent shell
 * commands too (terminal-panel streams them) and cannot import `node:child_process`.
 *
 * @param {string} text
 * @param {{ headLines?: number, tailLines?: number } | undefined} [slice]
 * @returns {string}
 */
export function sliceStreamLines(text, slice) {
  const headLines = Number(slice?.headLines);
  const tailLines = Number(slice?.tailLines);
  const wantHead = Number.isFinite(headLines) && headLines > 0 ? Math.floor(headLines) : 0;
  const wantTail = Number.isFinite(tailLines) && tailLines > 0 ? Math.floor(tailLines) : 0;
  if (!wantHead && !wantTail) return text;

  const lines = text.split(/\r?\n/);
  if (lines.length <= wantHead + wantTail) return text;

  const head = wantHead ? lines.slice(0, wantHead) : [];
  const tail = wantTail ? lines.slice(lines.length - wantTail) : [];
  const dropped = lines.length - head.length - tail.length;
  return [...head, `[… ${dropped} lines omitted …]`, ...tail].join('\n');
}

/**
 * Per-call head/tail line budget for command output, from raw tool args.
 *
 * @param {Record<string, unknown> | undefined} args
 * @returns {{ headLines?: number, tailLines?: number } | undefined}
 */
export function resolveOutputSliceFromArgs(args) {
  const headLines = Number(args?.head_lines);
  const tailLines = Number(args?.tail_lines);
  /** @type {{ headLines?: number, tailLines?: number }} */
  const slice = {};
  if (Number.isFinite(headLines) && headLines > 0) slice.headLines = Math.floor(headLines);
  if (Number.isFinite(tailLines) && tailLines > 0) slice.tailLines = Math.floor(tailLines);
  return slice.headLines || slice.tailLines ? slice : undefined;
}

/** Share of a middle-elided budget given to the head; the rest keeps the tail. */
const MIDDLE_ELIDE_HEAD_RATIO = 0.4;

/**
 * Keep the start and the end of `text`, dropping the middle.
 *
 * Head-only truncation is the wrong shape for process output: a build or test log
 * puts the failure at the end, which is exactly what a head slice throws away.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
export function elideMiddle(text, budget) {
  if (text.length <= budget) return text;
  const headChars = Math.max(1, Math.floor(budget * MIDDLE_ELIDE_HEAD_RATIO));
  const tailChars = Math.max(1, budget - headChars);
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const elided = text.length - head.length - tail.length;
  return `${head}\n[… ${elided} chars elided from the middle …]\n${tail}`;
}

/**
 * @param {string} text
 * @param {{ maxOutputChars?: number, maxLineChars?: number, footerHint?: string, applyResultCap?: boolean, middleElide?: boolean }} [options]
 * @returns {{ text: string, truncated: boolean, originalChars: number }}
 */
export function capTextOutput(text, options = {}) {
  const policy = getOutputCapPolicy();
  if (!shouldApplyTextCap(options, policy)) {
    return { text, truncated: false, originalChars: text.length };
  }

  const maxOutputChars = options.maxOutputChars ?? policy.maxOutputChars;
  const maxLineChars = options.maxLineChars ?? policy.maxLineChars;

  const lines = text.split(/\r?\n/);
  const originalChars =
    lines.reduce((sum, line) => sum + line.length, 0) +
    (lines.length > 0 ? lines.length - 1 : 0);

  let capped = lines.map((line) => capLineLength(line, maxLineChars)).join('\n');

  let overBudget = false;
  if (capped.length > maxOutputChars) {
    overBudget = true;
    capped = options.middleElide
      ? elideMiddle(capped, maxOutputChars)
      : capped.slice(0, maxOutputChars);
  }
  capped = truncateUtf8(capped, maxOutputChars * 4);

  const truncated = overBudget || capped.length < originalChars;

  if (truncated) {
    const kept = capped.length;
    const hint = withFullResultFooterHint(
      options.footerHint ?? 'request a narrower scope or paginate',
      true,
    );
    capped = `${capped}\n[truncated — ${kept} of ${originalChars} chars; ${hint}]`;
  }

  return { text: capped, truncated, originalChars };
}

/**
 * @param {string} content
 * @param {string} relPath
 * @param {number} [maxChars]
 */
export function capReadFileOutput(content, relPath, maxChars) {
  const policy = getOutputCapPolicy();
  const apply = maxChars != null ? true : policy.applyResultCap;
  if (!apply) {
    return { text: content, truncated: false, totalLines: content.split(/\r?\n/).length };
  }

  const budget = maxChars ?? policy.maxOutputChars;
  if (content.length <= budget) {
    return { text: content, truncated: false, totalLines: content.split(/\r?\n/).length };
  }

  const lines = content.split(/\r?\n/);
  const kept = [];
  let totalChars = 0;

  for (const line of lines) {
    const added = line.length + (kept.length > 0 ? 1 : 0);
    if (totalChars + added > budget) {
      break;
    }
    kept.push(line);
    totalChars += added;
  }

  if (kept.length === 0 && lines.length > 0) {
    const head = lines[0].slice(0, budget);
    const text = [
      head,
      '',
      `[truncated — line 1 exceeds ${budget} chars; use grep or execute_command to inspect specific content; or pass full_result: true]`,
    ].join('\n');
    return { text, truncated: true, totalLines: lines.length };
  }

  const endLine = kept.length;
  const text = [
    kept.join('\n'),
    '',
    `[truncated — ${endLine} of ${lines.length} lines (${totalChars} of ${content.length} chars);`,
    `use read_file_range with path="${relPath}" start_line=${endLine + 1} end_line=${lines.length} for the rest; or pass full_result: true]`,
  ].join('\n');

  return { text, truncated: true, totalLines: lines.length };
}
