/**
 * Block model for the issue editor.
 *
 * This is the whole round-trip guarantee, and it is structural rather than
 * best-effort. The document is split into blocks, each of which keeps its
 * **exact source text**. On save, a block the user never touched is emitted
 * verbatim — not re-serialized, not normalized, not "round-tripped". Only a
 * block the user actually edited is rebuilt from the DOM.
 *
 * That is what makes §13's blocking gate pass by construction: an agent can
 * write any markdown it likes into `description`, the user can edit one
 * paragraph in the middle, and every other byte survives because nothing ever
 * looked at it twice.
 *
 * Blocks the rich-text editor cannot represent (`raw`) use a source textarea.
 * Their text is emitted verbatim, so editing them never passes through a lossy
 * rich-text conversion.
 *
 * Phase 3 of `documentation/plans/issues-app-v2.md`.
 */

/** Block kinds the WYSIWYG can render and edit. */
export type EditableBlockKind =
  | 'paragraph'
  | 'heading'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'code'
  | 'quote'
  | 'table'
  | 'divider';

/** `raw` covers everything outside the supported subset. */
export type BlockKind = EditableBlockKind | 'raw' | 'blank';

export interface MarkdownBlock {
  /** Stable within one parse; used as the DOM key while editing. */
  id: string;
  kind: BlockKind;
  /** Exact source, newline-trimmed at the end. Never rewritten unless dirty. */
  source: string;
  /** Offsets into the original document, for diagnostics and tests. */
  start: number;
  end: number;
  /** Heading level 1–6. */
  level?: number;
  /** Fence info string for `code` (`ts`, `bash`). */
  language?: string;
  /** Why a block is raw, shown in the source editor's label. */
  rawReason?: string;
}

/** One `- [ ]` line inside a task-list block. */
export interface TaskItem {
  /** Index of the line within the block source. */
  line: number;
  checked: boolean;
  /** Marker plus indentation, preserved so a toggle changes one character. */
  prefix: string;
  text: string;
}

// ── Patterns ─────────────────────────────────────────────────────────────────

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\n]*)$/;
const BULLET_RE = /^ {0,3}([-*+])\s+/;
const ORDERED_RE = /^ {0,3}(\d{1,9})([.)])\s+/;
const TASK_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]\s?(.*)$/;
const QUOTE_RE = /^ {0,3}>/;
const DIVIDER_RE = /^ {0,3}((?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/;
const TABLE_DELIM_RE = /^ {0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const HTML_BLOCK_RE = /^ {0,3}<[A-Za-z!/?]/;
const FOOTNOTE_DEF_RE = /^ {0,3}\[\^[^\]]+\]:/;
const LINK_DEF_RE = /^ {0,3}\[[^\]]+\]:\s*\S/;
const INDENTED_CODE_RE = /^(?: {4}|\t)\S/;

/** True when a line starts a list item of any kind. */
function isListLine(line: string): boolean {
  return BULLET_RE.test(line) || ORDERED_RE.test(line);
}

/** True when a line continues a list item (indented, or a lazy continuation). */
function isListContinuation(line: string): boolean {
  if (!line.trim()) return false;
  return /^\s{2,}\S/.test(line) || (!isListLine(line) && !/^\s*$/.test(line) && /^\s/.test(line));
}

let blockCounter = 0;

function nextBlockId(): string {
  blockCounter += 1;
  return `blk-${blockCounter.toString(36)}`;
}

/** Reset the id counter so tests get stable ids. */
export function resetBlockIdsForTests(): void {
  blockCounter = 0;
}

interface Cursor {
  lines: string[];
  /** Character offset of the start of each line, plus a final total. */
  offsets: number[];
  index: number;
}

function lineOffsets(text: string, lines: string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  offsets.push(text.length);
  return offsets;
}

function emit(
  cursor: Cursor,
  from: number,
  to: number,
  kind: BlockKind,
  extra: Partial<MarkdownBlock> = {},
): MarkdownBlock {
  const source = cursor.lines.slice(from, to).join('\n');
  return {
    id: nextBlockId(),
    kind,
    source,
    start: cursor.offsets[from],
    end: cursor.offsets[from] + source.length,
    ...extra,
  };
}

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * Split a markdown document into blocks.
 *
 * Deliberately conservative: anything the editor is not certain it can
 * represent becomes `raw`. A false `raw` costs the user an inline edit; a false
 * *editable* costs them their content, so the asymmetry decides every case.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const text = markdown ?? '';
  const lines = text.split('\n');
  const cursor: Cursor = { lines, offsets: lineOffsets(text, lines), index: 0 };
  const blocks: MarkdownBlock[] = [];

  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (close > 0) {
      blocks.push(emit(cursor, 0, close + 1, 'raw', { rawReason: 'front matter' }));
      cursor.index = close + 1;
    }
  }

  while (cursor.index < lines.length) {
    const line = lines[cursor.index];

    if (!line.trim()) {
      const from = cursor.index;
      while (cursor.index < lines.length && !lines[cursor.index].trim()) cursor.index += 1;
      blocks.push(emit(cursor, from, cursor.index, 'blank'));
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      blocks.push(readFence(cursor, fence[1], fence[2]));
      continue;
    }

    if (HTML_BLOCK_RE.test(line)) {
      blocks.push(readUntilBlank(cursor, 'raw', 'HTML'));
      continue;
    }
    if (FOOTNOTE_DEF_RE.test(line)) {
      blocks.push(readUntilBlank(cursor, 'raw', 'footnote'));
      continue;
    }
    if (LINK_DEF_RE.test(line)) {
      blocks.push(readUntilBlank(cursor, 'raw', 'link definition'));
      continue;
    }
    if (INDENTED_CODE_RE.test(line)) {
      blocks.push(readUntilBlank(cursor, 'raw', 'indented code'));
      continue;
    }

    if (DIVIDER_RE.test(line)) {
      const from = cursor.index;
      cursor.index += 1;
      blocks.push(emit(cursor, from, cursor.index, 'divider'));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const from = cursor.index;
      cursor.index += 1;
      blocks.push(emit(cursor, from, cursor.index, 'heading', { level: heading[1].length }));
      continue;
    }

    if (QUOTE_RE.test(line)) {
      blocks.push(readUntilBlank(cursor, 'quote'));
      continue;
    }

    if (isListLine(line)) {
      blocks.push(readList(cursor));
      continue;
    }

    const table = tryReadTable(cursor);
    if (table) {
      blocks.push(table);
      continue;
    }

    blocks.push(readParagraph(cursor));
  }

  return blocks;
}

function readFence(cursor: Cursor, marker: string, info: string): MarkdownBlock {
  const from = cursor.index;
  cursor.index += 1;
  const closer = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
  while (cursor.index < cursor.lines.length && !closer.test(cursor.lines[cursor.index])) {
    cursor.index += 1;
  }
  const unterminated = cursor.index >= cursor.lines.length;
  if (!unterminated) cursor.index += 1;

  if (unterminated) {
    return emit(cursor, from, cursor.index, 'raw', { rawReason: 'unclosed code fence' });
  }
  return emit(cursor, from, cursor.index, 'code', {
    language: info.trim() || undefined,
  });
}

function readUntilBlank(cursor: Cursor, kind: BlockKind, rawReason?: string): MarkdownBlock {
  const from = cursor.index;
  while (cursor.index < cursor.lines.length && cursor.lines[cursor.index].trim()) {
    cursor.index += 1;
  }
  return emit(cursor, from, cursor.index, kind, rawReason ? { rawReason } : {});
}

function readList(cursor: Cursor): MarkdownBlock {
  const from = cursor.index;
  const ordered = ORDERED_RE.test(cursor.lines[from]);
  let sawTask = false;
  let sawNested = false;

  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index];
    if (!line.trim()) {
      const next = cursor.lines[cursor.index + 1] ?? '';
      if (!isListLine(next) && !isListContinuation(next)) break;
      cursor.index += 1;
      continue;
    }
    if (!isListLine(line) && !isListContinuation(line)) break;
    if (TASK_RE.test(line)) sawTask = true;
    if (isListLine(line) && /^\s{2,}/.test(line)) sawNested = true;
    cursor.index += 1;
  }

  if (sawNested) {
    return emit(cursor, from, cursor.index, 'raw', { rawReason: 'nested list' });
  }
  return emit(cursor, from, cursor.index, sawTask ? 'task-list' : ordered ? 'ordered-list' : 'bullet-list');
}

function tryReadTable(cursor: Cursor): MarkdownBlock | null {
  const header = cursor.lines[cursor.index];
  const delim = cursor.lines[cursor.index + 1];
  if (!header?.includes('|') || !delim || !TABLE_DELIM_RE.test(delim)) return null;

  const from = cursor.index;
  cursor.index += 2;
  while (
    cursor.index < cursor.lines.length &&
    cursor.lines[cursor.index].trim() &&
    cursor.lines[cursor.index].includes('|')
  ) {
    cursor.index += 1;
  }
  return emit(cursor, from, cursor.index, 'table');
}

function readParagraph(cursor: Cursor): MarkdownBlock {
  const from = cursor.index;
  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index];
    if (!line.trim()) break;
    if (cursor.index > from) {
      if (
        HEADING_RE.test(line) ||
        FENCE_RE.test(line) ||
        QUOTE_RE.test(line) ||
        DIVIDER_RE.test(line) ||
        isListLine(line) ||
        HTML_BLOCK_RE.test(line)
      ) {
        break;
      }
    }
    cursor.index += 1;
  }
  return emit(cursor, from, cursor.index, 'paragraph');
}

// ── Serialize ────────────────────────────────────────────────────────────────

/**
 * Reassemble a document from blocks.
 *
 * Blank blocks carry their own newlines, so joining with `\n` reproduces the
 * original spacing exactly rather than imposing a house style.
 */
export function serializeMarkdownBlocks(blocks: MarkdownBlock[]): string {
  return blocks.map((block) => block.source).join('\n');
}

/** True when every block round-trips to a byte-identical document. */
export function roundTripsExactly(markdown: string): boolean {
  return serializeMarkdownBlocks(parseMarkdownBlocks(markdown)) === (markdown ?? '');
}

/** Block kinds the editor renders as editable rather than read-only. */
const EDITABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  'paragraph',
  'heading',
  'bullet-list',
  'ordered-list',
  'task-list',
  'code',
  'quote',
  'table',
  'divider',
]);

/** True when the WYSIWYG may edit this block in place. */
export function isEditableBlock(block: MarkdownBlock): boolean {
  return EDITABLE_KINDS.has(block.kind);
}

/** Parse the checkbox lines out of a task-list block. */
export function parseTaskItems(block: MarkdownBlock): TaskItem[] {
  if (block.kind !== 'task-list') return [];
  const out: TaskItem[] = [];
  const lines = block.source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = TASK_RE.exec(lines[i]);
    if (!match) continue;
    out.push({
      line: i,
      prefix: match[1],
      checked: match[2] !== ' ',
      text: match[3],
    });
  }
  return out;
}

/**
 * Flip one checkbox.
 *
 * Rewrites a single character inside a single line and leaves the rest of the
 * block's source untouched, so ticking a box off cannot reflow a list an agent
 * wrote. Returns the block unchanged when the line is not a task line.
 */
export function toggleTaskItem(
  block: MarkdownBlock,
  lineIndex: number,
  checked?: boolean,
): MarkdownBlock {
  const lines = block.source.split('\n');
  const line = lines[lineIndex];
  if (line === undefined) return block;
  const match = TASK_RE.exec(line);
  if (!match) return block;

  const next = checked ?? match[2] === ' ';
  const mark = next ? 'x' : ' ';
  const at = line.indexOf('[', match[1].length - 1);
  if (at < 0) return block;
  lines[lineIndex] = `${line.slice(0, at + 1)}${mark}${line.slice(at + 2)}`;
  return { ...block, source: lines.join('\n') };
}

/** Checked / total across every task-list block in a document. */
export function taskProgress(markdown: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const block of parseMarkdownBlocks(markdown)) {
    for (const item of parseTaskItems(block)) {
      total += 1;
      if (item.checked) done += 1;
    }
  }
  return { done, total };
}
