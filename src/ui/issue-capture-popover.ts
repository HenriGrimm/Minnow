import '../styles/issue-capture.css';

import { openContextMenu } from './context-menu';
import {
  captureDescriptionSeed,
  captureTitleSeed,
  capturePayloadToLinks,
  mergeCapturePayloads,
  type CaptureItem,
  type CapturePayload,
} from '../issues/capture-payload';
import { capturePayloadFromDataTransfer, dataTransferLooksCapturable } from './capture-drag';
import { isTypingTarget } from './a11y/typing-target';
import {
  isDraftEmpty,
  loadIssueCaptureDraft,
  resetIssueCaptureDraftForTests,
  saveIssueCaptureDraft,
  type IssueCaptureDraft,
} from './issue-capture-draft';
import {
  registerChromePopover,
  unregisterChromePopover,
} from './preview-electron-visibility';
import { showToast } from './toast';
import type { ExpandedIssueDraft } from '../chat/issues/expand-issue';

const EDGE_GAP = 8;
/** How many recent issues the "add to existing" menu offers. */
const RECENT_ISSUE_LIMIT = 8;

export interface IssueCaptureResult {
  issueId: string;
  /** True when a new card was created rather than an existing one extended. */
  created: boolean;
}

export interface OpenIssueCaptureOptions {
  payload: CapturePayload;
  /** Element the popover points at. Falls back to the viewport centre-top. */
  anchor?: HTMLElement | null;
  /** Focus returns here on close. */
  restoreFocus?: HTMLElement | null;
  /** Called after a successful file. */
  onFiled?: (result: IssueCaptureResult) => void;
  /** Restore the last dismissed quick-capture draft for this workspace. */
  restoreDraft?: boolean;
  /** Keep the global quick-capture flow to a title and two create actions. */
  minimal?: boolean;
}

interface CaptureSession {
  root: HTMLElement;
  payload: CapturePayload;
  /** null = create a new issue; otherwise append to this card. */
  targetIssueId: string | null;
  titleInput: HTMLInputElement;
  chipsHost: HTMLElement | null;
  destinationBtn: HTMLButtonElement | null;
  submitBtn: HTMLButtonElement;
  expandAndCreateBtn: HTMLButtonElement | null;
  restoreFocus: HTMLElement | null;
  anchor: HTMLElement | null;
  onFiled?: (result: IssueCaptureResult) => void;
  submitting: boolean;
  expanding: AbortController | null;
}

let session: CaptureSession | null = null;
/** True while the popover holds a chrome-popover registration (native preview guest hidden). */
let chromePopoverRegistered = false;

/** True while the capture popover is open. */
export function isIssueCaptureOpen(): boolean {
  return session !== null;
}

function draftFromSession(current: CaptureSession): IssueCaptureDraft | null {
  const draft: IssueCaptureDraft = {
    title: current.titleInput.value,
    payload: { ...current.payload, items: [...current.payload.items] },
    targetIssueId: current.targetIssueId,
  };
  return isDraftEmpty(draft) ? null : draft;
}

function persistSessionDraft(current: CaptureSession): void {
  saveIssueCaptureDraft(current.payload.workspacePath, draftFromSession(current));
}

/** Close the popover without filing. */
export function closeIssueCapture(options?: {
  restoreFocus?: boolean;
  clearDraft?: boolean;
}): void {
  const current = session;
  if (!current) return;
  current.expanding?.abort();
  if (!options?.clearDraft) persistSessionDraft(current);
  else saveIssueCaptureDraft(current.payload.workspacePath, null);
  session = null;
  unbindGlobalListeners();
  const restore = options?.restoreFocus === false ? null : current.restoreFocus;
  if (restore?.isConnected) restore.focus();
  current.root.remove();
  if (chromePopoverRegistered) {
    unregisterChromePopover();
    chromePopoverRegistered = false;
  }
}

function chipIconFor(kind: CaptureItem['kind']): string {
  switch (kind) {
    case 'code':
      return '<>';
    case 'git':
      return '⎇';
    case 'chat':
      return '💬';
    case 'issue':
      return '#';
    case 'file':
      return '📄';
    default:
      return '¶';
  }
}

function buildChip(item: CaptureItem, onRemove: () => void): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'mn-capture__chip';
  chip.dataset.kind = item.kind;

  const icon = document.createElement('span');
  icon.className = 'mn-capture__chip-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = chipIconFor(item.kind);
  chip.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'mn-capture__chip-label';
  label.textContent = item.label;
  chip.appendChild(label);

  if (item.detail) {
    const detail = document.createElement('span');
    detail.className = 'mn-capture__chip-detail';
    detail.textContent = item.detail;
    chip.appendChild(detail);
    chip.title = `${item.label} — ${item.detail}`;
  } else {
    chip.title = item.label;
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'mn-capture__chip-remove';
  remove.setAttribute('aria-label', `Remove ${item.label}`);
  remove.textContent = '×';
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove();
  });
  chip.appendChild(remove);

  return chip;
}

function renderChips(current: CaptureSession): void {
  if (!current.chipsHost) return;
  current.chipsHost.replaceChildren();
  if (current.payload.items.length === 0) {
    current.chipsHost.hidden = true;
    return;
  }
  current.chipsHost.hidden = false;
  for (const item of current.payload.items) {
    current.chipsHost.appendChild(
      buildChip(item, () => {
        current.payload = {
          ...current.payload,
          items: current.payload.items.filter((entry) => entry !== item),
        };
        renderChips(current);
      }),
    );
  }
}

function syncDestination(current: CaptureSession): void {
  if (!current.destinationBtn) return;
  const targetId = current.targetIssueId;
  current.destinationBtn.textContent = targetId ? `Add to ${targetId}` : 'New issue';
  current.destinationBtn.setAttribute(
    'aria-label',
    targetId ? `Destination: add to ${targetId}` : 'Destination: new issue',
  );
  const chevron = document.createElement('span');
  chevron.className = 'mn-capture__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  current.destinationBtn.appendChild(chevron);

  current.submitBtn.textContent = targetId ? 'Add' : 'Create';
  current.titleInput.disabled = targetId !== null;
  current.titleInput.classList.toggle('is-muted', targetId !== null);
}

async function openDestinationMenu(current: CaptureSession): Promise<void> {
  if (!current.destinationBtn) return;
  const store = await import('../state/issues-store');
  const recent = store
    .listIssues()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_ISSUE_LIMIT);

  openContextMenu({
    label: 'Capture destination',
    anchor: current.destinationBtn,
    restoreFocus: current.destinationBtn,
    items: [
      {
        kind: 'action',
        id: 'capture-new',
        label: 'New issue',
        checked: current.targetIssueId === null,
        onSelect: () => {
          current.targetIssueId = null;
          syncDestination(current);
          current.titleInput.focus();
        },
      },
      ...(recent.length > 0
        ? [{ kind: 'heading' as const, id: 'capture-add-to', label: 'Add to' }]
        : []),
      ...recent.map((issue) => ({
        kind: 'action' as const,
        id: `capture-add-${issue.id}`,
        label: issue.title,
        hint: issue.id,
        checked: current.targetIssueId === issue.id,
        onSelect: () => {
          current.targetIssueId = issue.id;
          syncDestination(current);
          current.submitBtn.focus();
        },
      })),
    ],
  });
}

async function createNewCaptureIssue(
  current: CaptureSession,
  draft: Pick<ExpandedIssueDraft, 'title' | 'description' | 'type' | 'labels' | 'priority'>,
): Promise<void> {
  const store = await import('../state/issues-store');
  const links = capturePayloadToLinks(current.payload);
  const issue = store.addIssue({
    title: draft.title,
    description: draft.description,
    type: draft.type,
    labels: draft.labels,
    priority: draft.priority,
    workspacePath: current.payload.workspacePath,
    source: 'user',
  });
  store.appendIssueLinks(issue.id, {
    codeRefs: links.codeRefs,
    gitLinks: links.gitLinks,
    chatId: links.chatIds[0],
    issueRefs: links.issueRefs.map((ref) => ({ ...ref, addedAt: Date.now() })),
  });
  for (const chatId of links.chatIds.slice(1)) {
    store.appendIssueLinks(issue.id, { chatId });
  }
  store.scheduleSaveIssues();
  const filed = { issueId: issue.id, created: true };
  closeIssueCapture({ clearDraft: true });
  showToast(`Filed ${issue.id}`, 'success');
  current.onFiled?.(filed);
}

function setExpandAndCreateBusy(current: CaptureSession, busy: boolean): void {
  current.titleInput.disabled = busy;
  current.submitBtn.disabled = busy;
  if (current.expandAndCreateBtn) {
    current.expandAndCreateBtn.disabled = busy;
    current.expandAndCreateBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
}

async function expandAndCreateCapture(current: CaptureSession): Promise<void> {
  if (current.expanding || current.submitting) return;
  const title = current.titleInput.value.trim();
  if (!title) {
    current.titleInput.focus();
    current.titleInput.classList.add('is-invalid');
    window.setTimeout(() => current.titleInput.classList.remove('is-invalid'), 900);
    return;
  }

  const controller = new AbortController();
  current.expanding = controller;
  setExpandAndCreateBusy(current, true);
  try {
    const { expandUnsavedIssueDraft } = await import('./issues-expand');
    const draft = await expandUnsavedIssueDraft({
      id: '__quick_capture__', title, description: '', type: 'task', labels: [], priority: 'none',
    }, controller.signal);
    if (!draft || controller.signal.aborted || session !== current) return;
    current.submitting = true;
    await createNewCaptureIssue(current, draft);
  } catch (error) {
    if (!controller.signal.aborted) {
      showToast(error instanceof Error ? error.message : 'Could not expand the issue', 'error');
    }
  } finally {
    if (current.expanding === controller) {
      current.expanding = null;
      current.submitting = false;
      if (session === current) setExpandAndCreateBusy(current, false);
    }
  }
}

async function submitCapture(current: CaptureSession): Promise<void> {
  if (current.submitting) return;
  const links = capturePayloadToLinks(current.payload);

  if (current.targetIssueId) {
    current.submitting = true;
    try {
      const store = await import('../state/issues-store');
      const updated = store.appendIssueLinks(current.targetIssueId, {
        codeRefs: links.codeRefs,
        gitLinks: links.gitLinks,
        chatId: links.chatIds[0],
        issueRefs: links.issueRefs.map((ref) => ({ ...ref, addedAt: Date.now() })),
      });
      if (!updated) {
        showToast('That issue no longer exists.', 'error');
        return;
      }
      for (const chatId of links.chatIds.slice(1)) {
        store.appendIssueLinks(current.targetIssueId, { chatId });
      }
      store.scheduleSaveIssues();
      const filed = { issueId: updated.id, created: false };
      closeIssueCapture({ clearDraft: true });
      showToast(`Added to ${updated.id}`, 'success');
      current.onFiled?.(filed);
    } finally {
      current.submitting = false;
    }
    return;
  }

  const title = current.titleInput.value.trim();
  if (!title) {
    current.titleInput.focus();
    current.titleInput.classList.add('is-invalid');
    window.setTimeout(() => current.titleInput.classList.remove('is-invalid'), 900);
    return;
  }

  current.submitting = true;
  try {
    await createNewCaptureIssue(current, {
      title,
      description: captureDescriptionSeed(current.payload),
    });
  } finally {
    current.submitting = false;
  }
}

function positionPopover(root: HTMLElement, anchor: HTMLElement | null): void {
  root.style.visibility = 'hidden';
  root.style.left = '0px';
  root.style.top = '0px';
  const box = root.getBoundingClientRect();

  let left: number;
  let top: number;
  if (anchor) {
    const anchorBox = anchor.getBoundingClientRect();
    left = anchorBox.right - box.width;
    top = anchorBox.bottom + 6;
  } else {
    left = (window.innerWidth - box.width) / 2;
    top = 72;
  }

  left = Math.max(EDGE_GAP, Math.min(left, window.innerWidth - box.width - EDGE_GAP));
  top = Math.max(EDGE_GAP, Math.min(top, window.innerHeight - box.height - EDGE_GAP));
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  root.style.visibility = '';
}

function onKeyDown(event: KeyboardEvent): void {
  const current = session;
  if (!current) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeIssueCapture();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    const target = event.target;
    if (target === current.destinationBtn) return;
    if (isTypingTarget(target) || target === current.submitBtn) {
      event.preventDefault();
      void submitCapture(current);
    }
  }
}

function onPointerDown(event: PointerEvent): void {
  const current = session;
  if (!current) return;
  const target = event.target;
  if (target instanceof Node && current.root.contains(target)) return;
  if (target instanceof Element && target.closest('.mn-menu')) return;
  closeIssueCapture({ restoreFocus: false });
}

function onWindowChange(): void {
  if (session) closeIssueCapture({ restoreFocus: false });
}

function bindGlobalListeners(): void {
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('blur', onWindowChange);
}

function unbindGlobalListeners(): void {
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('blur', onWindowChange);
}

function bindPopoverDropTarget(root: HTMLElement): void {
  const dropClass = 'is-drop-target';

  root.addEventListener('dragover', (event) => {
    if (!dataTransferLooksCapturable(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    root.classList.add(dropClass);
  });

  root.addEventListener('dragleave', (event) => {
    const related = event.relatedTarget;
    if (related instanceof Node && root.contains(related)) return;
    root.classList.remove(dropClass);
  });

  root.addEventListener('drop', (event) => {
    root.classList.remove(dropClass);
    if (!dataTransferLooksCapturable(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const payload = capturePayloadFromDataTransfer(event.dataTransfer);
    if (!payload) return;
    mergeIntoOpenIssueCapture(payload);
  });
}

function resolvedOpenState(
  options: OpenIssueCaptureOptions,
): { payload: CapturePayload; title: string; targetIssueId: string | null } {
  let payload = options.payload;
  let targetIssueId: string | null = null;

  if (options.restoreDraft) {
    const draft = loadIssueCaptureDraft(payload.workspacePath);
    if (draft) {
      payload = mergeCapturePayloads(draft.payload, payload);
      targetIssueId = draft.targetIssueId;
      if (draft.title.trim()) {
        return { payload, title: draft.title, targetIssueId };
      }
    }
  }

  return { payload, title: captureTitleSeed(payload), targetIssueId };
}

/** Focus the open popover (menubar shortcut while capture is already up). */
export function focusOpenIssueCapture(): boolean {
  const current = session;
  if (!current) return false;
  current.titleInput.focus();
  current.titleInput.select();
  return true;
}

/** Open the capture popover. */
export function openIssueCapture(options: OpenIssueCaptureOptions): void {
  closeIssueCapture({ restoreFocus: false });

  const { payload, title, targetIssueId } = resolvedOpenState(options);

  const root = document.createElement('div');
  root.className = 'mn-capture';
  root.classList.toggle('mn-capture--minimal', Boolean(options.minimal));
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Capture issue');

  let destinationBtn: HTMLButtonElement | null = null;
  if (!options.minimal) {
    const head = document.createElement('div');
    head.className = 'mn-capture__head';
    const source = document.createElement('span');
    source.className = 'mn-capture__source';
    source.textContent = options.payload.sourceLabel || 'Quick capture';
    head.appendChild(source);

    destinationBtn = document.createElement('button');
    destinationBtn.type = 'button';
    destinationBtn.className = 'mn-capture__destination';
    head.appendChild(destinationBtn);
    root.appendChild(head);
  }

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'mn-capture__title';
  titleInput.placeholder = 'What went wrong?';
  titleInput.setAttribute('aria-label', 'Issue title');
  titleInput.value = title;
  root.appendChild(titleInput);

  let chipsHost: HTMLElement | null = null;
  if (!options.minimal) {
    chipsHost = document.createElement('div');
    chipsHost.className = 'mn-capture__chips';
    root.appendChild(chipsHost);
  }

  const foot = document.createElement('div');
  foot.className = 'mn-capture__foot';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'mn-capture__submit';
  if (options.minimal) submitBtn.textContent = 'Create Issue';
  let expandAndCreateBtn: HTMLButtonElement | null = null;
  if (options.minimal) {
    expandAndCreateBtn = document.createElement('button');
    expandAndCreateBtn.type = 'button';
    expandAndCreateBtn.className = 'mn-capture__expand-and-create';
    expandAndCreateBtn.textContent = 'Expand and Create';
    foot.append(submitBtn, expandAndCreateBtn);
  } else {
    const hint = document.createElement('span');
    hint.className = 'mn-capture__hint';
    hint.textContent = 'Enter to file · Esc to keep draft';
    foot.append(hint, submitBtn);
  }
  root.appendChild(foot);

  const current: CaptureSession = {
    root,
    payload,
    targetIssueId,
    titleInput,
    chipsHost,
    destinationBtn,
    submitBtn,
    expandAndCreateBtn,
    restoreFocus: options.restoreFocus ?? null,
    anchor: options.anchor ?? null,
    onFiled: options.onFiled,
    submitting: false,
    expanding: null,
  };
  session = current;

  destinationBtn?.addEventListener('click', () => {
    void openDestinationMenu(current);
  });
  submitBtn.addEventListener('click', () => {
    void submitCapture(current);
  });
  expandAndCreateBtn?.addEventListener('click', () => {
    void expandAndCreateCapture(current);
  });

  renderChips(current);
  if (!options.minimal) syncDestination(current);

  bindPopoverDropTarget(root);

  document.body.appendChild(root);
  positionPopover(root, current.anchor);
  bindGlobalListeners();
  registerChromePopover();
  chromePopoverRegistered = true;

  titleInput.focus();
  titleInput.select();
}

/** Merge more context into an already-open popover (a second drop). */
export function mergeIntoOpenIssueCapture(extra: CapturePayload): boolean {
  const current = session;
  if (!current) return false;
  if (extra.items.length === 0 && !extra.title?.trim() && !extra.description?.trim()) return false;
  current.payload = mergeCapturePayloads(current.payload, extra);
  renderChips(current);
  positionPopover(current.root, current.anchor);
  return true;
}

/** Merge chip items into an already-open popover (async ambient/git context). */
export function addToOpenIssueCapture(items: CaptureItem[]): boolean {
  if (items.length === 0) return false;
  return mergeIntoOpenIssueCapture({ items });
}

/** Reset module state (tests). */
export function resetIssueCaptureForTests(): void {
  if (session) {
    unbindGlobalListeners();
    session.root.remove();
  }
  session = null;
  resetIssueCaptureDraftForTests();
}
