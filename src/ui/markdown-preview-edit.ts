/**
 * Edit a rendered markdown preview in place, one block at a time.
 *
 * Clicking a rendered block (paragraph, heading, list, table, code fence…)
 * swaps it for a textarea holding that block's markdown source. Every
 * keystroke splices the block back into the document and reports the new
 * text, so the owning tab is always current; leaving the block re-renders it.
 * Only the edited range ever changes — the rest of the file stays byte-exact.
 */

import { renderMarkdownSourceBlocks, type MarkdownSourceBlock } from '../markdown/renderer';

export interface EditableMarkdownPreviewOptions {
  /** Called with the whole document after every edit (and once more on cancel). */
  onChange: (next: string) => void;
  /** Ctrl/Cmd+S inside a block — the edit is already reported. */
  onSave?: () => void;
}

export interface EditableMarkdownPreview {
  /** Finish the open block edit, if any, and re-render. */
  commit: () => void;
}

interface ActiveEdit {
  textarea: HTMLTextAreaElement;
  prefix: string;
  suffix: string;
  /** Trailing newlines of the block, kept outside the textarea. */
  trailing: string;
  original: string;
}

/** Clicks on these stay interactive instead of opening the block. */
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, summary, label';

/** Split a block's source into the editable body and its trailing newlines. */
export function splitBlockSource(source: string): { body: string; trailing: string } {
  const body = source.replace(/\n+$/, '');
  return { body, trailing: source.slice(body.length) };
}

function autoSize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/** Render `source` into `preview` and make its blocks editable. */
export function mountEditableMarkdownPreview(
  preview: HTMLElement,
  initialSource: string,
  options: EditableMarkdownPreviewOptions,
): EditableMarkdownPreview {
  let source = initialSource;
  let blocks: MarkdownSourceBlock[] = [];
  let active: ActiveEdit | null = null;
  /** A press inside the preview moved focus out of the open block; the click decides what's next. */
  let pressPending = false;

  preview.classList.add('file-viewer-markdown-preview--editable');

  const render = (): void => {
    blocks = renderMarkdownSourceBlocks(preview, source);
    if (source.trim()) return;
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'md-edit-empty';
    empty.textContent = 'Empty document — click to start writing';
    empty.addEventListener('click', (e) => {
      // The preview's own click handler would close the block it just opened.
      e.stopPropagation();
      beginEdit({ type: 'paragraph', start: 0, end: source.length }, empty);
    });
    preview.appendChild(empty);
  };

  const report = (): void => {
    if (!active) return;
    source = active.prefix + active.textarea.value + active.trailing + active.suffix;
    options.onChange(source);
  };

  const finish = (mode: 'commit' | 'cancel'): void => {
    const edit = active;
    if (!edit) return;
    if (mode === 'cancel') {
      source = edit.prefix + edit.original + edit.trailing + edit.suffix;
      options.onChange(source);
    } else {
      report();
    }
    active = null;
    if (!preview.isConnected) return;
    const scrollTop = preview.scrollTop;
    render();
    preview.scrollTop = scrollTop;
  };

  const beginEdit = (block: MarkdownSourceBlock, anchor: Element): void => {
    const { body, trailing } = splitBlockSource(source.slice(block.start, block.end));
    const textarea = document.createElement('textarea');
    textarea.className = 'md-edit-block';
    textarea.value = body;
    textarea.setAttribute('aria-label', 'Edit markdown block');
    active = {
      textarea,
      prefix: source.slice(0, block.start),
      suffix: source.slice(block.end),
      trailing,
      original: body,
    };

    const index = blocks.indexOf(block);
    const rendered = index >= 0
      ? [...preview.querySelectorAll(`[data-md-block="${index}"]`)]
      : [];
    (rendered[0] ?? anchor).before(textarea);
    for (const el of rendered) el.remove();
    anchor.remove();

    textarea.addEventListener('input', () => {
      autoSize(textarea);
      report();
    });
    textarea.addEventListener('blur', () => {
      if (active?.textarea === textarea && !pressPending) finish('commit');
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish('cancel');
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        finish('commit');
        return;
      }
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        e.stopPropagation();
        report();
        options.onSave?.();
      }
    });

    autoSize(textarea);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(body.length, body.length);
  };

  /** The rendered block a click should open, or null to just close the open one. */
  const clickedBlock = (target: Element): { block: MarkdownSourceBlock; el: HTMLElement } | null => {
    if (target.closest(INTERACTIVE_SELECTOR)) return null;
    // Let a drag-selection stay a selection (copying text must keep working).
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && preview.contains(selection.anchorNode)) return null;
    const el = target.closest<HTMLElement>('[data-md-block]');
    if (!el || !preview.contains(el)) return null;
    const block = blocks[Number(el.dataset.mdBlock)];
    return block ? { block, el } : null;
  };

  preview.addEventListener('mousedown', (e) => {
    if (!active || active.textarea.contains(e.target as Node)) return;
    pressPending = true;
    // A press that never becomes a click (drag out, selection) still closes the block.
    window.addEventListener('mouseup', () => {
      setTimeout(() => {
        if (!pressPending) return;
        pressPending = false;
        if (active && document.activeElement !== active.textarea) finish('commit');
      }, 0);
    }, { once: true });
  }, true);

  preview.addEventListener('click', (e) => {
    pressPending = false;
    const target = e.target as Element | null;
    if (!target || active?.textarea.contains(target)) return;
    const hit = clickedBlock(target);
    if (!active) {
      if (hit) beginEdit(hit.block, hit.el);
      return;
    }
    // Committing re-renders, so find the clicked block again by its shifted offset.
    const editEnd = active.prefix.length + active.original.length + active.trailing.length;
    const delta = active.textarea.value.length - active.original.length;
    finish('commit');
    if (!hit) return;
    const start = hit.block.start >= editEnd ? hit.block.start + delta : hit.block.start;
    const index = blocks.findIndex((b) => b.start === start);
    const el = index >= 0 ? preview.querySelector(`[data-md-block="${index}"]`) : null;
    if (el) beginEdit(blocks[index]!, el);
  });

  render();
  return { commit: () => finish('commit') };
}
