import '../styles/issue-editor.css';

import {
  isEditableBlock,
  parseMarkdownBlocks,
  parseTaskItems,
  serializeMarkdownBlocks,
  toggleTaskItem,
  type MarkdownBlock,
} from '../issues/markdown-blocks';
import { htmlToInline, inlineToHtml } from '../issues/markdown-inline';
import { iconHtml } from './icon';
import { openContextMenu, type MenuItem } from './context-menu';
import { applyPaste, classifyPaste } from './issue-editor-paste';
import { addIssueAttachment, findIssueById, updateIssue, scheduleSaveIssues } from '../state/issues-store';
import type { StoredAttachment } from '../state/issue-attachments-api';

export interface IssueEditorOptions {
  /** Initial markdown. */
  value: string;
  /** Called on every committed change (debounced by the caller if needed). */
  onChange: (markdown: string) => void;
  /** Called when the user leaves the editor. */
  onBlur?: () => void;
  placeholder?: string;
  /** Issue id, so mentions and pasted images know where they belong. */
  issueId?: string;
}

export interface IssueEditorHandle {
  root: HTMLElement;
  /** Current markdown. */
  getValue: () => string;
  /**
   * Write dirty / untracked DOM back through `onChange` without requiring a blur.
   * Used by submit and peek remount so a description cannot vanish with the node.
   */
  flush: () => string;
  /** Replace the document (external update, e.g. an agent wrote to it). */
  setValue: (markdown: string) => void;
  focus: () => void;
  waitForImages: () => Promise<void>;
  attachImagesToIssue: (issueId: string) => void;
  destroy: () => void;
}

interface EditorState {
  root: HTMLElement;
  body: HTMLElement;
  blocks: MarkdownBlock[];
  /** Block ids whose DOM has diverged from `source`. */
  dirty: Set<string>;
  options: IssueEditorOptions;
  /** Suppresses the input handler while the editor rewrites its own DOM. */
  rendering: boolean;
  /**
   * Bumped whenever `blocks` is replaced. `render` records the value it drew,
   * so `generation !== renderedGeneration` means the live DOM still carries the
   * *previous* parse's block ids and must not be read as the document.
   */
  generation: number;
  renderedGeneration: number;
}

/** Replace the block model. Never assign `state.blocks` directly. */
function setBlocks(state: EditorState, blocks: MarkdownBlock[]): void {
  state.blocks = blocks;
  state.generation += 1;
}

/** True when the DOM was rendered from the blocks currently in `state`. */
function domMatchesBlocks(state: EditorState): boolean {
  return state.renderedGeneration === state.generation;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function blockElement(state: EditorState, block: MarkdownBlock): HTMLElement {
  const el = renderBlockBody(state, block);
  el.dataset.blockId = block.id;
  el.dataset.kind = block.kind;
  if (!isEditableBlock(block)) {
    el.setAttribute('contenteditable', 'false');
  }
  return el;
}

function renderBlockBody(state: EditorState, block: MarkdownBlock): HTMLElement {
  switch (block.kind) {
    case 'blank':
      return renderBlank(block);
    case 'raw':
      return renderRaw(block);
    case 'heading':
      return renderHeading(block);
    case 'code':
      return renderCode(state, block);
    case 'quote':
      return renderQuote(block);
    case 'divider':
      return renderDivider();
    case 'table':
      return renderTable(block);
    case 'task-list':
      return renderTaskList(state, block);
    case 'bullet-list':
    case 'ordered-list':
      return renderList(block);
    default:
      return renderParagraph(block);
  }
}

/** Blank runs are structure, not content. */
function renderBlank(block: MarkdownBlock): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mn-editor__blank';
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('aria-hidden', 'true');
  el.dataset.lines = String(block.source.split('\n').length);
  return el;
}

function renderRaw(block: MarkdownBlock): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'mn-editor__raw';

  const label = document.createElement('span');
  label.className = 'mn-editor__raw-label';
  label.textContent = `${block.rawReason ?? 'raw markdown'} · edit source`;
  label.title = 'Edit the source directly. Formatting is preserved as written.';
  wrap.appendChild(label);

  const area = document.createElement('textarea');
  area.className = 'mn-editor__raw-source';
  area.value = block.source;
  area.rows = Math.max(2, block.source.split('\n').length);
  area.spellcheck = false;
  area.setAttribute('aria-label', `${block.rawReason ?? 'Markdown'} source`);
  // Keep native textarea typing and paste out of the rich-text handlers.
  area.addEventListener('input', (event) => {
    event.stopPropagation();
    area.rows = Math.max(2, area.value.split('\n').length);
  });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) return;
    event.stopPropagation();
  });
  area.addEventListener('paste', (event) => event.stopPropagation());
  wrap.appendChild(area);
  return wrap;
}

function renderHeading(block: MarkdownBlock): HTMLElement {
  const level = Math.min(6, Math.max(1, block.level ?? 1));
  const el = document.createElement(HEADING_TAGS[level - 1]);
  el.className = 'mn-editor__heading';
  el.innerHTML = inlineToHtml(block.source.replace(/^ {0,3}#{1,6}\s+/, ''));
  return el;
}

function renderParagraph(block: MarkdownBlock): HTMLElement {
  const el = document.createElement('p');
  el.className = 'mn-editor__para';
  el.innerHTML = inlineToHtml(block.source) || '<br>';
  return el;
}

function renderQuote(block: MarkdownBlock): HTMLElement {
  const el = document.createElement('blockquote');
  el.className = 'mn-editor__quote';
  const body = block.source
    .split('\n')
    .map((line) => line.replace(/^ {0,3}>\s?/, ''))
    .join('\n');
  el.innerHTML = inlineToHtml(body).replace(/\n/g, '<br>');
  return el;
}

function renderDivider(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mn-editor__divider';
  el.setAttribute('contenteditable', 'false');
  el.appendChild(document.createElement('hr'));
  return el;
}

function renderList(block: MarkdownBlock): HTMLElement {
  const ordered = block.kind === 'ordered-list';
  const el = document.createElement(ordered ? 'ol' : 'ul');
  el.className = 'mn-editor__list';
  for (const line of block.source.split('\n')) {
    const text = line.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '');
    if (!line.trim()) continue;
    const li = document.createElement('li');
    li.innerHTML = inlineToHtml(text) || '<br>';
    el.appendChild(li);
  }
  return el;
}

/** Checklists are state: the boxes are real inputs, and toggling one rewrites a single character in the block source rather than re-serializing the list. */
function renderTaskList(state: EditorState, block: MarkdownBlock): HTMLElement {
  const el = document.createElement('ul');
  el.className = 'mn-editor__list mn-editor__list--tasks';
  for (const item of parseTaskItems(block)) {
    const li = document.createElement('li');
    li.className = 'mn-editor__task';
    li.dataset.line = String(item.line);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'mn-editor__task-box';
    box.checked = item.checked;
    box.setAttribute('contenteditable', 'false');
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('change', () => {
      const current = state.blocks.find((b) => b.id === block.id);
      if (!current) return;
      const next = toggleTaskItem(current, item.line, box.checked);
      replaceBlock(state, block.id, next);
      commit(state);
    });

    const text = document.createElement('span');
    text.className = 'mn-editor__task-text';
    text.innerHTML = inlineToHtml(item.text) || '<br>';

    li.append(box, text);
    el.appendChild(li);
  }
  return el;
}

function renderTable(block: MarkdownBlock): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'mn-editor__table-wrap';
  const table = document.createElement('table');
  table.className = 'mn-editor__table';

  const rows = block.source.split('\n').filter((line) => line.trim());
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  rows.forEach((line, index) => {
    if (index === 1) return;
    const tr = document.createElement('tr');
    for (const cell of cells(line)) {
      const td = document.createElement(index === 0 ? 'th' : 'td');
      td.innerHTML = inlineToHtml(cell);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });

  wrap.appendChild(table);
  return wrap;
}

function renderCode(state: EditorState, block: MarkdownBlock): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'mn-editor__code';
  wrap.setAttribute('contenteditable', 'false');

  const lines = block.source.split('\n');
  const fenceOpen = lines[0] ?? '```';
  const fenceClose = lines[lines.length - 1] ?? '```';
  const body = lines.slice(1, -1).join('\n');

  const head = document.createElement('div');
  head.className = 'mn-editor__code-head';
  const lang = document.createElement('span');
  lang.className = 'mn-editor__code-lang';
  lang.textContent = block.language ?? 'code';
  head.appendChild(lang);
  wrap.appendChild(head);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (block.language) code.className = `language-${block.language}`;
  code.textContent = body;
  pre.appendChild(code);
  wrap.appendChild(pre);
  void import('../markdown/highlighter').then((m) => m.highlightCodeElement(code));

  const enterEdit = (): void => {
    const area = document.createElement('textarea');
    area.className = 'mn-editor__code-input';
    area.value = body;
    area.rows = Math.max(3, lines.length - 1);
    area.spellcheck = false;
    area.setAttribute('aria-label', `Code block${block.language ? ` (${block.language})` : ''}`);

    const finish = (): void => {
      const current = state.blocks.find((b) => b.id === block.id);
      if (!current) return;
      const next = `${fenceOpen}\n${area.value}\n${fenceClose}`;
      if (next !== current.source) {
        replaceBlock(state, block.id, { ...current, source: next });
        commit(state);
      } else {
        render(state);
      }
    };

    area.addEventListener('blur', finish);
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        render(state);
      }
    });

    pre.replaceWith(area);
    area.focus();
  };

  pre.addEventListener('click', enterEdit);
  head.addEventListener('click', enterEdit);
  return wrap;
}

function replaceBlock(state: EditorState, id: string, next: MarkdownBlock): void {
  // Same ids, so the rendered DOM still lines up; only the source changed.
  state.blocks = state.blocks.map((block) => (block.id === id ? next : block));
  state.dirty.delete(id);
}

/** Pull a dirty block's markdown back out of its DOM. */
function serializeBlockElement(el: HTMLElement, block: MarkdownBlock): string {
  const kind = block.kind;

  if (kind === 'heading') {
    const level = Math.min(6, Math.max(1, block.level ?? 1));
    return `${'#'.repeat(level)} ${htmlToInline(el).trim()}`;
  }
  if (kind === 'quote') {
    const body = htmlToInline(el);
    return body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  }
  if (kind === 'divider') return block.source;
  if (kind === 'table') return serializeTable(el, block);
  if (kind === 'task-list') return serializeTaskList(el, block);
  if (kind === 'bullet-list' || kind === 'ordered-list') return serializeList(el, kind);
  if (kind === 'code' || kind === 'raw' || kind === 'blank') return block.source;

  return htmlToInline(el).replace(/\n+$/, '');
}

function serializeList(el: HTMLElement, kind: 'bullet-list' | 'ordered-list'): string {
  const items = Array.from(el.querySelectorAll(':scope > li'));
  return items
    .map((li, index) => {
      const text = htmlToInline(li).replace(/\n+/g, ' ').trim();
      return kind === 'ordered-list' ? `${index + 1}. ${text}` : `- ${text}`;
    })
    .join('\n');
}

function serializeTaskList(el: HTMLElement, block: MarkdownBlock): string {
  const items = parseTaskItems(block);
  const lis = Array.from(el.querySelectorAll(':scope > li'));
  return lis
    .map((li, index) => {
      const box = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      const textEl = li.querySelector('.mn-editor__task-text');
      const text = textEl ? htmlToInline(textEl).replace(/\n+/g, ' ').trim() : '';
      const prefix = items[index]?.prefix ?? '- ';
      return `${prefix}[${box?.checked ? 'x' : ' '}] ${text}`;
    })
    .join('\n');
}

function serializeTable(el: HTMLElement, block: MarkdownBlock): string {
  const delim = block.source.split('\n')[1] ?? '| --- |';
  const rows = Array.from(el.querySelectorAll('tr'));
  const out: string[] = [];
  rows.forEach((tr, index) => {
    const cells = Array.from(tr.children).map((cell) =>
      htmlToInline(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim(),
    );
    out.push(`| ${cells.join(' | ')} |`);
    if (index === 0) out.push(delim);
  });
  return out.join('\n');
}

/** True when the parsed document has nowhere for the caret to type. */
function needsEditableSeed(blocks: MarkdownBlock[]): boolean {
  return blocks.length === 0 || blocks.every((block) => block.kind === 'blank');
}

/** One serialized run of the document, in DOM order. */
interface Piece {
  source: string;
  /** True when a block in the model owns this node (blanks carry their own spacing). */
  tracked: boolean;
}

/**
 * Blank blocks already hold the blank lines between tracked runs, so those join
 * with a single newline. Anything the model does not own — the empty-document
 * seed, a `<div>` the browser inserted on Enter, a bare text node left after a
 * select-all delete — needs a real blank line to stay its own paragraph.
 */
function joinPieces(pieces: Piece[]): string {
  let out = '';
  for (let i = 0; i < pieces.length; i += 1) {
    if (i > 0) out += pieces[i].tracked && pieces[i - 1].tracked ? '\n' : '\n\n';
    out += pieces[i].source;
  }
  return out;
}

/** Markdown for a node the block model does not own. */
function untrackedSource(el: HTMLElement): string {
  const kind = (el.dataset.kind as MarkdownBlock['kind'] | undefined) ?? 'paragraph';
  return serializeBlockElement(el, {
    id: el.dataset.blockId || 'blk-dom',
    kind: kind === 'blank' || kind === 'raw' ? 'paragraph' : kind,
    source: '',
    start: 0,
    end: 0,
  }).trim();
}

/**
 * Serialize the whole document by walking the live DOM in order.
 *
 * The DOM is the document; `state.blocks` only supplies the source of untouched
 * blocks (so markdown the editor cannot represent round-trips byte-identically)
 * and of read-only ones. Walking blocks instead and appending whatever the DOM
 * held on top is what resurrected deleted text: a block whose element the user
 * removed stayed in the model, and the replacement typed in its place arrived as
 * an extra node, so `test 1` came back above `test 2`.
 */
function currentMarkdown(state: EditorState): string {
  // The DOM belongs to an older parse (a flush that could not re-render, e.g.
  // because the body was already detached). Its nodes carry ids no block owns,
  // so reading them would append the whole document to itself.
  if (!domMatchesBlocks(state)) return serializeMarkdownBlocks(state.blocks);
  // A body with no nodes at all is a teardown, not an edit: contenteditable
  // keeps a placeholder after a real select-all delete, and `render` seeds one.
  if (state.body.childNodes.length === 0 && state.blocks.length > 0) {
    return serializeMarkdownBlocks(state.blocks);
  }
  markDirtyAtCaret(state);

  const byId = new Map(state.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>();
  const pieces: Piece[] = [];

  for (const node of Array.from(state.body.childNodes)) {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? '').trim();
      if (text) pieces.push({ source: text, tracked: false });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as HTMLElement;

    const id = el.dataset.blockId ?? '';
    // `seen` matters for Enter: splitting a paragraph clones its attributes, so
    // the second half arrives carrying the first half's id. Only one node can be
    // the block; the rest are treated as new content rather than dropped.
    const block = id && !seen.has(id) ? byId.get(id) : undefined;
    if (block) {
      seen.add(id);
      const source = block.kind === 'raw'
        ? el.querySelector<HTMLTextAreaElement>('.mn-editor__raw-source')?.value ?? block.source
        : state.dirty.has(id) ? serializeBlockElement(el, block) : block.source;
      pieces.push({ source, tracked: true });
      continue;
    }

    if (el.classList.contains('mn-editor__blank')) continue;
    const source = untrackedSource(el);
    if (source) pieces.push({ source, tracked: false });
  }

  // A blank-only model is a placeholder, not content: the seed paragraph and
  // whatever the browser inserted around it *are* the document.
  if (needsEditableSeed(state.blocks)) {
    return joinPieces(pieces.filter((piece) => !piece.tracked));
  }
  return joinPieces(pieces);
}

/**
 * Persist the live DOM. Skips `onChange` when markdown is unchanged so a caret
 * sitting in the empty seed does not write a blank description.
 */
function flush(state: EditorState): string {
  const markdown = currentMarkdown(state);
  const previous = serializeMarkdownBlocks(state.blocks);
  state.dirty.clear();
  if (markdown === previous) return markdown;

  setBlocks(state, parseMarkdownBlocks(markdown));
  // Re-render *before* notifying. `onChange` re-enters: it writes the store,
  // which repaints the detail panel, which destroys this editor — and that
  // teardown flushes again. A DOM still holding the previous parse's ids would
  // be read as extra content and doubled onto the description.
  if (state.body.isConnected) render(state);
  state.options.onChange(markdown);
  return markdown;
}

function commit(state: EditorState): void {
  flush(state);
}

function render(state: EditorState): void {
  state.rendering = true;
  const selection = captureCaret(state);
  state.body.replaceChildren();
  for (const block of state.blocks) {
    const el = blockElement(state, block);
    el.dataset.renderedText = el.textContent ?? '';
    state.body.appendChild(el);
  }
  // Empty / blank-only documents have no editable block. Seed a paragraph so
  // the caret has a real target; it is omitted from markdown until it has text.
  if (needsEditableSeed(state.blocks)) {
    const seed = emptyParagraph();
    const el = blockElement(state, seed);
    el.dataset.renderedText = el.textContent ?? '';
    state.body.appendChild(el);
  }
  syncPlaceholder(state);
  restoreCaret(state, selection);
  state.renderedGeneration = state.generation;
  state.rendering = false;
}

function emptyParagraph(): MarkdownBlock {
  return { id: 'blk-empty', kind: 'paragraph', source: '', start: 0, end: 0 };
}

function syncPlaceholder(state: EditorState): void {
  const empty = state.body.textContent?.trim().length === 0;
  state.body.classList.toggle('is-empty', empty);
}

interface CaretMark {
  blockId: string;
  offset: number;
}

/** Remember the caret as a block id plus a text offset. */
function captureCaret(state: EditorState): CaretMark | null {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  const host = node instanceof Element ? node : node.parentElement;
  const block = host?.closest<HTMLElement>('[data-block-id]');
  if (!block || !state.body.contains(block)) return null;

  const pre = range.cloneRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  return { blockId: block.dataset.blockId ?? '', offset: pre.toString().length };
}

function restoreCaret(state: EditorState, mark: CaretMark | null): void {
  if (!mark) return;
  const block = state.body.querySelector<HTMLElement>(`[data-block-id="${mark.blockId}"]`);
  if (!block) return;
  const selection = window.getSelection?.();
  if (!selection) return;

  let remaining = mark.offset;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }

  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function blockIdAtCaret(state: EditorState): string | null {
  const mark = captureCaret(state);
  return mark?.blockId ?? null;
}

interface ToolbarButton {
  id: string;
  label: string;
  icon?: string;
  text?: string;
  run: (state: EditorState) => void;
}

function exec(command: string): void {
  document.execCommand(command, false);
}

function convertBlock(state: EditorState, transform: (source: string) => string): void {
  const id = blockIdAtCaret(state);
  if (!id) return;
  const block = state.blocks.find((b) => b.id === id);
  if (!block || !isEditableBlock(block)) return;

  const el = state.body.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
  const source = el && state.dirty.has(id) ? serializeBlockElement(el, block) : block.source;
  replaceBlock(state, id, { ...block, source: transform(source) });
  commit(state);
}

/** Strip whatever block markers a line already carries before adding new ones. */
function bareLines(source: string): string[] {
  return source.split('\n').map((line) =>
    line
      .replace(/^ {0,3}#{1,6}\s+/, '')
      .replace(/^ {0,3}>\s?/, '')
      .replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[[ xX]\]\s?/, '')
      .replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/, ''),
  );
}

const TOOLBAR: ToolbarButton[] = [
  { id: 'bold', label: 'Bold', text: 'B', run: () => exec('bold') },
  { id: 'italic', label: 'Italic', text: 'I', run: () => exec('italic') },
  { id: 'strike', label: 'Strikethrough', text: 'S', run: () => exec('strikeThrough') },
  {
    id: 'code',
    label: 'Inline code',
    text: '<>',
    run: (state) => wrapSelection(state, '`', '`'),
  },
  {
    id: 'link',
    label: 'Link',
    text: '↗',
    run: (state) => {
      void insertLink(state);
    },
  },
  {
    id: 'h1',
    label: 'Heading 1',
    text: 'H1',
    run: (state) => convertBlock(state, (s) => `# ${bareLines(s).join(' ')}`),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    text: 'H2',
    run: (state) => convertBlock(state, (s) => `## ${bareLines(s).join(' ')}`),
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    text: '•',
    run: (state) => convertBlock(state, (s) => bareLines(s).map((l) => `- ${l}`).join('\n')),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    text: '1.',
    run: (state) =>
      convertBlock(state, (s) => bareLines(s).map((l, i) => `${i + 1}. ${l}`).join('\n')),
  },
  {
    id: 'task',
    label: 'Checklist',
    text: '☑',
    run: (state) => convertBlock(state, (s) => bareLines(s).map((l) => `- [ ] ${l}`).join('\n')),
  },
  {
    id: 'quote',
    label: 'Quote',
    text: '❝',
    run: (state) => convertBlock(state, (s) => bareLines(s).map((l) => `> ${l}`).join('\n')),
  },
  {
    id: 'codeblock',
    label: 'Code block',
    text: '{ }',
    run: (state) => convertBlock(state, (s) => `\`\`\`\n${bareLines(s).join('\n')}\n\`\`\``),
  },
];

function wrapSelection(state: EditorState, open: string, close: string): void {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return;
  const text = selection.toString();
  if (!text) return;
  document.execCommand('insertText', false, `${open}${text}${close}`);
  markDirtyAtCaret(state);
  commit(state);
}

async function insertLink(state: EditorState): Promise<void> {
  const selection = window.getSelection?.();
  const label = selection?.toString() ?? '';
  const { appPrompt } = await import('./app-dialog');
  const href = await appPrompt('Link URL', 'https://');
  if (!href?.trim()) return;
  document.execCommand('insertText', false, `[${label || href.trim()}](${href.trim()})`);
  markDirtyAtCaret(state);
  commit(state);
}

function buildToolbar(state: EditorState): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'mn-editor__toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');

  for (const button of TOOLBAR) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mn-editor__tool';
    btn.dataset.tool = button.id;
    btn.setAttribute('aria-label', button.label);
    btn.title = button.label;
    if (button.icon) btn.innerHTML = iconHtml(button.icon as 'plus', { size: 14 });
    else btn.textContent = button.text ?? button.label;
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => button.run(state));
    bar.appendChild(btn);
  }
  return bar;
}

/** Mark the block the user is editing. */
function markDirtyAtCaret(state: EditorState): void {
  const id = blockIdAtCaret(state);
  if (id) state.dirty.add(id);

  for (const el of state.body.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const blockId = el.dataset.blockId;
    if (!blockId || state.dirty.has(blockId)) continue;
    if (el.dataset.renderedText === undefined) continue;
    if ((el.textContent ?? '') !== el.dataset.renderedText) state.dirty.add(blockId);
  }
}

function slashItems(state: EditorState): MenuItem[] {
  const insert = (transform: (source: string) => string) => () => {
    convertBlock(state, (source) => transform(source.replace(/\/$/, '').trimEnd()));
  };

  return [
    { kind: 'heading', id: 'slash-blocks', label: 'Blocks' },
    { kind: 'action', id: 'slash-h1', label: 'Heading 1', onSelect: insert((s) => `# ${s}`) },
    { kind: 'action', id: 'slash-h2', label: 'Heading 2', onSelect: insert((s) => `## ${s}`) },
    { kind: 'action', id: 'slash-h3', label: 'Heading 3', onSelect: insert((s) => `### ${s}`) },
    { kind: 'action', id: 'slash-bullet', label: 'Bulleted list', onSelect: insert((s) => `- ${s}`) },
    { kind: 'action', id: 'slash-ordered', label: 'Numbered list', onSelect: insert((s) => `1. ${s}`) },
    { kind: 'action', id: 'slash-task', label: 'Checklist', onSelect: insert((s) => `- [ ] ${s}`) },
    { kind: 'action', id: 'slash-quote', label: 'Quote', onSelect: insert((s) => `> ${s}`) },
    { kind: 'action', id: 'slash-code', label: 'Code block', onSelect: insert((s) => `\`\`\`\n${s}\n\`\`\``) },
    { kind: 'action', id: 'slash-divider', label: 'Divider', onSelect: insert(() => '---') },
    { kind: 'action', id: 'slash-table', label: 'Table', onSelect: insert(() => '| Column | Column |\n| --- | --- |\n|  |  |') },
    { kind: 'separator' },
    { kind: 'heading', id: 'slash-minnow', label: 'Minnow' },
    {
      kind: 'action',
      id: 'slash-code-ref',
      label: 'Code reference',
      hint: 'Insert @path:line',
      onSelect: () => {
        void insertCodeReference(state);
      },
    },
    {
      kind: 'action',
      id: 'slash-issue-ref',
      label: 'Issue reference',
      hint: 'Insert #KEY-n',
      onSelect: () => {
        void insertIssueReference(state);
      },
    },
    {
      kind: 'action',
      id: 'slash-sub-issue',
      label: 'Sub-issue',
      hint: 'Create and link a child issue',
      onSelect: () => {
        void insertSubIssue(state);
      },
    },
  ];
}

function replaceTrailingSlash(): void {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== 3) return;
  const text = node.nodeValue ?? '';
  if (!text.slice(0, range.startOffset).endsWith('/')) return;
  const at = range.startOffset;
  node.nodeValue = text.slice(0, at - 1) + text.slice(at);
  const next = document.createRange();
  next.setStart(node, at - 1);
  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
}

async function insertCodeReference(state: EditorState): Promise<void> {
  const { appPrompt } = await import('./app-dialog');
  const value = await appPrompt('Code reference', 'src/foo.ts:12-34');
  if (!value?.trim()) return;
  replaceTrailingSlash();
  document.execCommand('insertText', false, `@${value.trim().replace(/^@/, '')} `);
  markDirtyAtCaret(state);
  commit(state);
}

async function insertIssueReference(state: EditorState): Promise<void> {
  const store = await import('../state/issues-store');
  const recent = store
    .listIssues()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);
  if (recent.length === 0) return;

  openContextMenu({
    label: 'Issue reference',
    items: recent.map((issue) => ({
      kind: 'action' as const,
      id: `ref-${issue.id}`,
      label: issue.title,
      hint: issue.id,
      onSelect: () => {
        replaceTrailingSlash();
        document.execCommand('insertText', false, `#${issue.id} `);
        markDirtyAtCaret(state);
        commit(state);
      },
    })),
  });
}

async function insertSubIssue(state: EditorState): Promise<void> {
  const parentId = state.options.issueId;
  if (!parentId) return;
  const { appPrompt } = await import('./app-dialog');
  const title = await appPrompt('Sub-issue title', '');
  if (!title?.trim()) return;

  const store = await import('../state/issues-store');
  const child = store.addIssue({ title: title.trim(), parentId });
  store.scheduleSaveIssues();
  replaceTrailingSlash();
  document.execCommand('insertText', false, `#${child.id} `);
  markDirtyAtCaret(state);
  commit(state);
}

/** Create the editor inside `host`. */
export function createIssueEditor(
  host: HTMLElement,
  options: IssueEditorOptions,
): IssueEditorHandle {
  const root = document.createElement('div');
  root.className = 'mn-editor';
  const draftId = options.issueId ?? `draft-${crypto.randomUUID()}`;
  const draftAttachments: StoredAttachment[] = [];
  const pendingImages = new Set<Promise<unknown>>();
  let documentRevision = 0;

  const body = document.createElement('div');
  body.className = 'mn-editor__body';
  body.contentEditable = 'true';
  body.spellcheck = true;
  body.setAttribute('role', 'textbox');
  body.setAttribute('aria-multiline', 'true');
  body.setAttribute('aria-label', 'Issue description');
  if (options.placeholder) body.dataset.placeholder = options.placeholder;

  const state: EditorState = {
    root,
    body,
    blocks: parseMarkdownBlocks(options.value),
    dirty: new Set(),
    options,
    rendering: false,
    generation: 0,
    renderedGeneration: -1,
  };

  root.appendChild(buildToolbar(state));
  root.appendChild(body);
  host.appendChild(root);

  const onInput = (): void => {
    if (state.rendering) return;
    markDirtyAtCaret(state);
    syncPlaceholder(state);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey) {
      window.setTimeout(() => maybeOpenSlashMenu(state), 0);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit(state);
      return;
    }
    if (event.key === 'Escape') {
      commit(state);
    }
  };

  const onBlur = (event: FocusEvent): void => {
    // Teardown (innerHTML / remove) fires blur after children are gone; serializing
    // that empty DOM would write an empty description over live text.
    if (!state.body.isConnected) {
      options.onBlur?.();
      return;
    }
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    flush(state);
    options.onBlur?.();
  };

  const insertionContext = () => {
    const revision = documentRevision;
    const selection = window.getSelection();
    const range = selection?.rangeCount && body.contains(selection.anchorNode)
      ? selection.getRangeAt(0).cloneRange() : null;
    return {
      issueId: draftId,
      onAttachment: options.issueId ? undefined : (attachment: StoredAttachment) => {
        if (revision === documentRevision) draftAttachments.push(attachment);
      },
      insertText: (text: string) => {
        if (revision !== documentRevision) return;
        // Uploads can outlive a peek remount or a switch to another issue.
        if (!body.isConnected) {
          const issue = options.issueId && findIssueById(options.issueId);
          if (issue) {
            updateIssue(issue.id, { description: `${issue.description}\n\n${text}`.trim() });
            scheduleSaveIssues();
          }
          return;
        }
        const target = range && body.contains(range.startContainer) ? range : document.createRange();
        if (target !== range) {
          target.selectNodeContents(body.lastElementChild ?? body);
          target.collapse(false);
        }
        target.deleteContents();
        const node = document.createTextNode(text);
        target.insertNode(node);
        target.setStartAfter(node);
        target.collapse(true);
        for (const block of state.blocks) state.dirty.add(block.id);
        commit(state);
      },
    };
  };

  const onPaste = (event: ClipboardEvent): void => {
    const plan = classifyPaste(event.clipboardData);
    if (plan.kind === 'passthrough') return;
    event.preventDefault();
    const work = applyPaste(plan, insertionContext());
    pendingImages.add(work);
    void work.finally(() => pendingImages.delete(work));
  };
  const onDragOver = (event: DragEvent): void => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent): void => {
    const images = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    const pointRange = (document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }).caretRangeFromPoint?.(event.clientX, event.clientY);
    if (pointRange && body.contains(pointRange.startContainer)) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(pointRange);
    }
    const context = insertionContext();
    const work = (async () => {
      for (const file of images) await applyPaste({ kind: 'image', file }, context);
    })();
    pendingImages.add(work);
    void work.finally(() => pendingImages.delete(work));
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const mention = target.closest<HTMLElement>('[data-mention]');
    if (mention) {
      event.preventDefault();
      void openMention(mention);
    }
  };

  body.addEventListener('input', onInput);
  body.addEventListener('keydown', onKeyDown);
  body.addEventListener('blur', onBlur, true);
  body.addEventListener('paste', onPaste);
  body.addEventListener('dragover', onDragOver);
  body.addEventListener('drop', onDrop);
  body.addEventListener('click', onClick);

  render(state);

  return {
    root,
    getValue: () => currentMarkdown(state),
    flush: () => (state.body.isConnected ? flush(state) : serializeMarkdownBlocks(state.blocks)),
    setValue: (markdown: string) => {
      documentRevision++;
      if (!markdown) draftAttachments.length = 0;
      setBlocks(state, parseMarkdownBlocks(markdown));
      state.dirty.clear();
      render(state);
    },
    focus: () => body.focus(),
    waitForImages: async () => { await Promise.all(pendingImages); },
    attachImagesToIssue: (issueId: string) => {
      for (const attachment of draftAttachments) addIssueAttachment(issueId, attachment);
      draftAttachments.length = 0;
      scheduleSaveIssues();
    },
    destroy: () => {
      // Flush while the nodes still exist so peek remount cannot drop the body.
      if (state.body.isConnected) flush(state);
      body.removeEventListener('input', onInput);
      body.removeEventListener('keydown', onKeyDown);
      body.removeEventListener('blur', onBlur, true);
      body.removeEventListener('paste', onPaste);
      body.removeEventListener('dragover', onDragOver);
      body.removeEventListener('drop', onDrop);
      body.removeEventListener('click', onClick);
      root.remove();
    },
  };
}

function maybeOpenSlashMenu(state: EditorState): void {
  const mark = captureCaret(state);
  if (!mark) return;
  const block = state.body.querySelector<HTMLElement>(`[data-block-id="${mark.blockId}"]`);
  if (!block) return;
  const text = block.textContent ?? '';
  if (text.trim() !== '/') return;

  const rect = block.getBoundingClientRect();
  openContextMenu({
    label: 'Insert',
    clientX: rect.left,
    clientY: rect.bottom + 2,
    items: slashItems(state),
  });
}

async function openMention(el: HTMLElement): Promise<void> {
  if (el.dataset.mention === 'issue') {
    const id = el.dataset.issueId;
    if (!id) return;
    const detail = await import('./issues-detail');
    detail.openIssueDetail(id);
    return;
  }
  if (el.dataset.mention === 'code') {
    const path = el.dataset.path;
    if (!path) return;
    const start = Number(el.dataset.startLine) || 1;
    const end = Number(el.dataset.endLine) || start;
    const link = await import('./code-ref-link');
    link.openCodeRefInViewer({ workspacePath: path, startLine: start, endLine: end });
  }
}

