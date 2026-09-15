import type { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { getLocalServerAvailable } from '../../tools/client';
import { fetchQuickEditReplacement } from './client';
import {
  buildQuickEditDiffLines,
  countQuickEditStats,
} from './diff-apply';
import { lineNumbersForRange } from './selection-fence';
import type { QuickEditSelectionRange, QuickEditSession } from './types';

let panelEl: HTMLDivElement | null = null;
let abortController: AbortController | null = null;
let activeSession: QuickEditSession | null = null;
let activeView: EditorView | null = null;

function ensurePanel(): HTMLDivElement {
  if (panelEl) return panelEl;
  panelEl = document.createElement('div');
  panelEl.className = 'editor-quick-edit-panel hidden';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-label', 'Quick edit');
  document.body.appendChild(panelEl);
  return panelEl;
}

function hidePanel(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  activeSession = null;
  activeView = null;
  if (panelEl) {
    panelEl.classList.add('hidden');
    panelEl.replaceChildren();
  }
}

function positionPanel(view: EditorView, range: QuickEditSelectionRange): void {
  const panel = ensurePanel();
  const coords = view.coordsAtPos(range.from);
  if (!coords) return;
  panel.style.left = `${Math.max(8, coords.left)}px`;
  panel.style.top = `${Math.max(8, coords.bottom + 6)}px`;
}

function renderDiffPreview(before: string, after: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'editor-quick-edit-diff';
  const lines = buildQuickEditDiffLines(before, after);
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = `editor-quick-edit-diff__line editor-quick-edit-diff__line--${line.type}`;
    row.textContent = line.text.length > 0 ? line.text : ' ';
    wrap.appendChild(row);
  }
  return wrap;
}

function renderStats(before: string, after: string): HTMLElement {
  const stats = countQuickEditStats(before, after);
  const el = document.createElement('span');
  el.className = 'editor-quick-edit-stats';
  if (stats.additions > 0) {
    const add = document.createElement('span');
    add.className = 'editor-quick-edit-stats__add';
    add.textContent = `+${stats.additions}`;
    el.appendChild(add);
  }
  if (stats.deletions > 0) {
    const del = document.createElement('span');
    del.className = 'editor-quick-edit-stats__del';
    del.textContent = `−${stats.deletions}`;
    el.appendChild(del);
  }
  if (stats.additions === 0 && stats.deletions === 0) {
    el.textContent = 'No line changes';
  }
  return el;
}

function renderPanel(session: QuickEditSession, view: EditorView): void {
  const panel = ensurePanel();
  panel.replaceChildren();
  panel.classList.remove('hidden');

  const header = document.createElement('div');
  header.className = 'editor-quick-edit-panel__header';
  const title = document.createElement('span');
  title.className = 'editor-quick-edit-panel__title';
  title.textContent = 'Quick edit';
  header.append(title, renderStats(session.originalText, session.proposedText));
  panel.appendChild(header);

  const form = document.createElement('form');
  form.className = 'editor-quick-edit-panel__form';
  const input = document.createElement('textarea');
  input.className = 'editor-quick-edit-panel__input';
  input.rows = 2;
  input.placeholder = 'Describe the change…';
  input.value = session.instruction;
  input.setAttribute('aria-label', 'Quick edit instruction');
  form.appendChild(input);
  panel.appendChild(form);

  if (session.proposedText) {
    panel.appendChild(renderDiffPreview(session.originalText, session.proposedText));
  } else if (session.streaming) {
    const pending = document.createElement('p');
    pending.className = 'editor-quick-edit-panel__pending';
    pending.textContent = 'Generating…';
    panel.appendChild(pending);
  }

  const actions = document.createElement('div');
  actions.className = 'editor-quick-edit-panel__actions';

  const acceptBtn = document.createElement('button');
  acceptBtn.type = 'button';
  acceptBtn.className = 'editor-quick-edit-btn editor-quick-edit-btn--accept';
  acceptBtn.textContent = 'Accept';
  acceptBtn.disabled = !session.proposedText || session.streaming;

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'editor-quick-edit-btn editor-quick-edit-btn--reject';
  rejectBtn.textContent = 'Reject';

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'editor-quick-edit-btn editor-quick-edit-btn--retry';
  retryBtn.textContent = 'Retry';
  retryBtn.disabled = session.streaming;

  actions.append(rejectBtn, retryBtn, acceptBtn);
  panel.appendChild(actions);

  acceptBtn.addEventListener('click', () => {
    if (!activeView || !activeSession?.proposedText) return;
    const { range, proposedText, filePath, originalText } = activeSession;
    if (activeView.state.doc.sliceString(range.from, range.to) !== originalText) return;
    activeView.dispatch({
      changes: { from: range.from, to: range.to, insert: proposedText },
      selection: EditorSelection.cursor(range.from + proposedText.length),
    });
    void import('../../usage/code-activity').then(({ recordAcceptedCodeEdit }) =>
      recordAcceptedCodeEdit(filePath, originalText, proposedText, 'agent'));
    hidePanel();
  });

  rejectBtn.addEventListener('click', () => hidePanel());

  retryBtn.addEventListener('click', () => {
    void runQuickEditStream(view, session.filePath, session.range, input.value.trim());
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (session.streaming) return;
    void runQuickEditStream(view, session.filePath, session.range, input.value.trim());
  });

  input.focus();
  input.select();
}

async function runQuickEditStream(
  view: EditorView,
  filePath: string,
  range: QuickEditSelectionRange,
  instruction: string,
): Promise<void> {
  if (!getLocalServerAvailable()) {
    activeSession = {
      filePath,
      range,
      originalText: range.text,
      instruction,
      proposedText: '',
      streaming: false,
    };
    renderPanel(activeSession, view);
    const panel = ensurePanel();
    const err = document.createElement('p');
    err.className = 'editor-quick-edit-panel__error';
    err.textContent = 'Quick edit unavailable — open Minnow and configure a provider.';
    panel.appendChild(err);
    return;
  }

  if (abortController) abortController.abort();
  abortController = new AbortController();

  activeSession = {
    filePath,
    range,
    originalText: range.text,
    instruction,
    proposedText: '',
    streaming: true,
  };
  activeView = view;
  renderPanel(activeSession, view);
  positionPanel(view, range);

  const result = await fetchQuickEditReplacement({
    filePath,
    selectionText: range.text,
    fromLine: range.fromLine,
    toLine: range.toLine,
    instruction,
    signal: abortController.signal,
    onPartial: (partial) => {
      if (!activeSession) return;
      activeSession.proposedText = partial;
      renderPanel(activeSession, view);
      positionPanel(view, range);
    },
  });

  if (!activeSession) return;
  activeSession.streaming = false;
  activeSession.proposedText = result.text ?? activeSession.proposedText;
  renderPanel(activeSession, view);
  positionPanel(view, range);

  const errorMessage =
    result.error ??
    (!activeSession.proposedText
      ? 'Quick edit produced no changes — try a different instruction or check your model.'
      : undefined);
  if (errorMessage) {
    const panel = ensurePanel();
    const err = document.createElement('p');
    err.className = 'editor-quick-edit-panel__error';
    err.textContent = errorMessage;
    panel.appendChild(err);
  }
}

/** Open Quick Edit for the current editor selection (Mod-K or context menu). */
export function openQuickEditPanel(view: EditorView, filePath: string): void {
  const sel = view.state.selection.main;
  if (sel.empty) return;

  const from = sel.from;
  const to = sel.to;
  const text = view.state.doc.sliceString(from, to);
  const { fromLine, toLine } = lineNumbersForRange(view.state.doc, from, to);
  const range: QuickEditSelectionRange = { from, to, fromLine, toLine, text };

  activeView = view;
  positionPanel(view, range);
  void runQuickEditStream(view, filePath, range, '');
}

/** Whether the quick-edit panel is open. */
export function isQuickEditPanelOpen(): boolean {
  return Boolean(activeSession && panelEl && !panelEl.classList.contains('hidden'));
}

/** Close panel without applying (tests / escape). */
export function closeQuickEditPanel(): void {
  hidePanel();
}

/** Read selection range from view when non-empty. */
export function readQuickEditSelection(
  view: EditorView,
): QuickEditSelectionRange | null {
  const sel = view.state.selection.main;
  if (sel.empty) return null;
  const from = sel.from;
  const to = sel.to;
  const text = view.state.doc.sliceString(from, to);
  const { fromLine, toLine } = lineNumbersForRange(view.state.doc, from, to);
  return { from, to, fromLine, toLine, text };
}
