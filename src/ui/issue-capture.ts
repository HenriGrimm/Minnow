import { MENU_ORDER, registerMenuContributor, type MenuTarget } from './menu-registry';
import type { MenuItem } from './context-menu';
import {
  captureDescriptionSeed,
  capturePayloadToLinks,
  emptyCapturePayload,
  mergeCapturePayloads,
  type CapturePayload,
} from '../issues/capture-payload';
import {
  focusOpenIssueCapture,
  isIssueCaptureOpen,
  mergeIntoOpenIssueCapture,
  openIssueCapture,
} from './issue-capture-popover';
import { capturePayloadFromDataTransfer } from './capture-drag';
import { getWorkspacePath } from '../state/workspace';
import { showToast } from './toast';

/** Target kinds surfaces pass to the menu registry. */
export const CAPTURE_MENU_KINDS = {
  file: 'file',
  editorSelection: 'editor-selection',
  commit: 'commit',
  branch: 'branch',
  pullRequest: 'pull-request',
  chatMessage: 'chat-message',
  terminalSelection: 'terminal-selection',
  boardCard: 'board-card',
  researchEntry: 'research-entry',
  issue: 'issue',
  browserPage: 'browser-page',
} as const;

const CAPTURE_KINDS: readonly string[] = Object.values(CAPTURE_MENU_KINDS);

/** How many recent issues the "Add to issue" submenu offers. */
const ADD_TO_LIMIT = 10;

function str(target: MenuTarget, key: string): string {
  const value = target[key];
  return typeof value === 'string' ? value.trim() : '';
}

function num(target: MenuTarget, key: string): number | undefined {
  const value = Number(target[key]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

/** Turn a menu target into something fileable. */
export function capturePayloadFromMenuTarget(target: MenuTarget): CapturePayload | null {
  const payload = emptyCapturePayload();
  payload.workspacePath = getWorkspacePath();

  switch (target.kind) {
    case CAPTURE_MENU_KINDS.file: {
      const path = str(target, 'path');
      if (!path) return null;
      payload.sourceLabel = 'File';
      payload.title = basename(path);
      payload.items.push({
        kind: 'file',
        label: basename(path),
        detail: path,
        codeRef: { path },
      });
      return payload;
    }

    case CAPTURE_MENU_KINDS.editorSelection: {
      const path = str(target, 'path');
      const text = str(target, 'text');
      if (!path) return null;
      const startLine = num(target, 'startLine');
      const endLine = num(target, 'endLine') ?? startLine;
      const range = startLine ? ` L${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ''}` : '';
      payload.sourceLabel = 'Editor selection';
      payload.items.push({
        kind: 'code',
        label: `${basename(path)}${range}`,
        detail: path,
        codeRef: {
          path,
          startLine,
          endLine,
          snippet: text.slice(0, 2000) || undefined,
        },
        text: text || undefined,
      });
      return payload;
    }

    case CAPTURE_MENU_KINDS.commit: {
      const hash = str(target, 'hash') || str(target, 'sha');
      if (!hash) return null;
      const subject = str(target, 'subject');
      payload.sourceLabel = 'Commit';
      payload.title = subject || undefined;
      payload.items.push({
        kind: 'git',
        label: hash.slice(0, 8),
        detail: subject || 'commit',
        gitLink: { kind: 'commit', ref: hash, title: subject || undefined },
      });
      return payload;
    }

    case CAPTURE_MENU_KINDS.branch: {
      const name = str(target, 'name') || str(target, 'branch');
      if (!name) return null;
      payload.sourceLabel = 'Branch';
      payload.items.push({
        kind: 'git',
        label: name,
        detail: 'branch',
        gitLink: { kind: 'branch', ref: name },
      });
      return payload;
    }

    case CAPTURE_MENU_KINDS.pullRequest: {
      const number = str(target, 'number');
      const url = str(target, 'url');
      if (!number && !url) return null;
      const title = str(target, 'title');
      payload.sourceLabel = 'Pull request';
      payload.title = title || undefined;
      payload.items.push({
        kind: 'git',
        label: number ? `#${number.replace(/^#/, '')}` : url,
        detail: title || 'pull request',
        gitLink: {
          kind: 'pr',
          ref: number || url,
          url: url || undefined,
          title: title || undefined,
        },
      });
      return payload;
    }

    case CAPTURE_MENU_KINDS.chatMessage: {
      const chatId = str(target, 'chatId');
      const text = str(target, 'text');
      if (!chatId && !text) return null;
      payload.sourceLabel = 'Chat message';
      if (text) payload.title = text.split('\n')[0];
      payload.items.push({
        kind: 'chat',
        label: str(target, 'chatTitle') || 'Chat',
        detail: chatId || undefined,
        chatId: chatId || undefined,
        text: text || undefined,
      });
      return payload;
    }

    case CAPTURE_MENU_KINDS.terminalSelection: {
      const text = str(target, 'text');
      if (!text) return null;
      payload.sourceLabel = 'Terminal output';
      payload.title = text.split('\n').find((line) => line.trim()) ?? undefined;
      payload.items.push({ kind: 'text', label: 'Terminal output', text });
      return payload;
    }

    case CAPTURE_MENU_KINDS.boardCard:
    case CAPTURE_MENU_KINDS.researchEntry:
    case CAPTURE_MENU_KINDS.browserPage: {
      const title = str(target, 'title');
      const url = str(target, 'url');
      const text = str(target, 'text');
      if (!title && !url && !text) return null;
      payload.sourceLabel =
        target.kind === CAPTURE_MENU_KINDS.boardCard
          ? 'Board card'
          : target.kind === CAPTURE_MENU_KINDS.researchEntry
            ? 'Research entry'
            : 'Page';
      payload.title = title || undefined;
      payload.description = [url, text].filter(Boolean).join('\n\n') || undefined;
      if (title || url) {
        payload.items.push({
          kind: 'text',
          label: title || url,
          detail: url || undefined,
        });
      }
      return payload;
    }

    case CAPTURE_MENU_KINDS.issue: {
      const issueId = str(target, 'issueId');
      if (!issueId) return null;
      payload.sourceLabel = 'Issue';
      payload.items.push({
        kind: 'issue',
        label: issueId,
        detail: str(target, 'title') || undefined,
        issueRef: { issueId, kind: 'related' },
      });
      return payload;
    }

    default:
      return null;
  }
}

/** Append a payload's links straight onto an existing issue (no popover). */
export async function attachCaptureToIssue(
  issueId: string,
  payload: CapturePayload,
): Promise<boolean> {
  const store = await import('../state/issues-store');
  const links = capturePayloadToLinks(payload);
  const updated = store.appendIssueLinks(issueId, {
    codeRefs: links.codeRefs,
    gitLinks: links.gitLinks,
    chatId: links.chatIds[0],
    issueRefs: links.issueRefs.map((ref) => ({ ...ref, addedAt: Date.now() })),
  });
  if (!updated) {
    showToast(`Unknown issue ${issueId}`, 'error');
    return false;
  }
  for (const chatId of links.chatIds.slice(1)) {
    store.appendIssueLinks(issueId, { chatId });
  }

  const body = captureDescriptionSeed(payload);
  if (body && links.codeRefs.length === 0 && links.gitLinks.length === 0) {
    const next = updated.description ? `${updated.description}\n\n${body}` : body;
    store.updateIssue(issueId, { description: next });
  }

  store.scheduleSaveIssues();
  showToast(`Added to ${issueId}`, 'success');
  void import('./issues-detail').then((m) => m.refreshIssueDetailIfOpen());
  return true;
}

/** The registry rows. */
function captureMenuItems(target: MenuTarget): MenuItem[] | null {
  const payload = capturePayloadFromMenuTarget(target);
  if (!payload) return null;

  const rows: MenuItem[] = [
    {
      kind: 'action',
      id: 'issue-capture-create',
      label: 'Create issue…',
      onSelect: () => {
        openIssueCapture({ payload });
      },
    },
    {
      kind: 'submenu',
      id: 'issue-capture-add',
      label: 'Add to issue',
      items: () => buildAddToItems(payload),
    },
  ];
  return rows;
}

function buildAddToItems(payload: CapturePayload): MenuItem[] {
  const store = issuesStoreSync();
  if (!store) {
    return [{ kind: 'action', id: 'issue-capture-none', label: 'Issues not loaded', disabled: true, onSelect: () => {} }];
  }
  const recent = store
    .listIssues()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, ADD_TO_LIMIT);

  if (recent.length === 0) {
    return [
      {
        kind: 'action',
        id: 'issue-capture-empty',
        label: 'No issues yet',
        disabled: true,
        onSelect: () => {},
      },
    ];
  }

  return recent.map((issue) => ({
    kind: 'action' as const,
    id: `issue-capture-add-${issue.id}`,
    label: issue.title,
    hint: issue.id,
    onSelect: () => {
      void attachCaptureToIssue(issue.id, payload);
    },
  }));
}

/** The store module, once it has been loaded by anything else. */
type IssuesStoreModule = typeof import('../state/issues-store');
let storeModule: IssuesStoreModule | null = null;

function issuesStoreSync(): IssuesStoreModule | null {
  if (!storeModule) {
    void import('../state/issues-store').then((m) => {
      storeModule = m;
    });
  }
  return storeModule;
}

/** Register the capture rows against every capture-capable target kind. */
export function initIssueCaptureMenus(): () => void {
  void issuesStoreSync();
  return registerMenuContributor('issues-capture', captureMenuItems, {
    order: MENU_ORDER.integration,
    kinds: CAPTURE_KINDS,
  });
}

/** Adapter for surfaces that still render their own menu. */
export function legacyCaptureMenuItems(
  target: MenuTarget,
): Array<{ label: string; action: () => void }> {
  const payload = capturePayloadFromMenuTarget(target);
  if (!payload) return [];
  return [
    {
      label: 'Create issue…',
      action: () => openIssueCapture({ payload }),
    },
    {
      label: 'Add to issue…',
      action: () => openIssueCapture({ payload }),
    },
  ];
}

export function openQuickCapture(options?: {
  anchor?: HTMLElement | null;
  restoreFocus?: HTMLElement | null;
  extra?: CapturePayload;
}): void {
  if (isIssueCaptureOpen()) {
    if (options?.extra) mergeIntoOpenIssueCapture(options.extra);
    else focusOpenIssueCapture();
    return;
  }

  let payload = emptyCapturePayload();
  payload.workspacePath = getWorkspacePath();
  if (options?.extra) payload = mergeCapturePayloads(payload, options.extra);

  openIssueCapture({
    payload,
    anchor: options?.anchor ?? null,
    restoreFocus: options?.restoreFocus ?? null,
    minimal: true,
  });
}

/** Open capture from a drop, seeded with what was dropped plus ambient context. */
export function openCaptureFromDrop(
  dataTransfer: DataTransfer | null,
  options?: { anchor?: HTMLElement | null },
): boolean {
  const dropped = capturePayloadFromDataTransfer(dataTransfer);
  if (!dropped) return false;
  if (isIssueCaptureOpen()) {
    mergeIntoOpenIssueCapture(dropped);
    return true;
  }
  openQuickCapture({ anchor: options?.anchor ?? null, extra: dropped });
  return true;
}
