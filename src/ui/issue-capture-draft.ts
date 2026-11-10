import {
  isCapturePayloadEmpty,
  parseCapturePayloadJson,
  type CapturePayload,
} from '../issues/capture-payload';

const STORAGE_KEY = 'minnow-issue-capture-draft-v1';

export interface IssueCaptureDraft {
  title: string;
  payload: CapturePayload;
  targetIssueId: string | null;
  threadFields?: { label: string; priority: string; linkedChatId?: string; link: boolean };
}

type DraftStore = Record<string, IssueCaptureDraft>;

function workspaceKey(workspacePath: string | undefined): string {
  return workspacePath?.trim() || '__default__';
}

function readStore(): DraftStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as DraftStore;
  } catch {
    return {};
  }
}

function writeStore(store: DraftStore): void {
  try {
    if (Object.keys(store).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
  }
}

/** In-memory copy so a localStorage failure does not drop the draft this session. */
const memoryDrafts = new Map<string, IssueCaptureDraft>();

/** Load the saved draft for a workspace, or null when nothing was kept. */
export function loadIssueCaptureDraft(workspacePath: string | undefined): IssueCaptureDraft | null {
  const key = workspaceKey(workspacePath);
  const cached = memoryDrafts.get(key);
  if (cached) return cloneDraft(cached);

  const stored = readStore()[key];
  if (!stored) return null;
  const draft = sanitizeDraft(stored);
  if (!draft) return null;
  memoryDrafts.set(key, draft);
  return cloneDraft(draft);
}

/** Persist or clear the draft for a workspace. */
export function saveIssueCaptureDraft(
  workspacePath: string | undefined,
  draft: IssueCaptureDraft | null,
): void {
  const key = workspaceKey(workspacePath);
  if (!draft || isDraftEmpty(draft)) {
    memoryDrafts.delete(key);
    const store = readStore();
    if (!(key in store)) return;
    delete store[key];
    writeStore(store);
    return;
  }

  const normalized = sanitizeDraft(draft);
  if (!normalized) {
    saveIssueCaptureDraft(workspacePath, null);
    return;
  }
  memoryDrafts.set(key, normalized);
  const store = readStore();
  store[key] = normalized;
  writeStore(store);
}

/** True when there is nothing worth restoring. */
export function isDraftEmpty(draft: IssueCaptureDraft): boolean {
  return !draft.title.trim() && !draft.targetIssueId && isCapturePayloadEmpty(draft.payload);
}

function cloneDraft(draft: IssueCaptureDraft): IssueCaptureDraft {
  return {
    title: draft.title,
    targetIssueId: draft.targetIssueId,
    ...(draft.threadFields ? { threadFields: { ...draft.threadFields } } : {}),
    payload: {
      ...draft.payload,
      items: draft.payload.items.map((item) => ({ ...item })),
    },
  };
}

function sanitizeDraft(raw: IssueCaptureDraft): IssueCaptureDraft | null {
  const title = typeof raw.title === 'string' ? raw.title : '';
  const targetIssueId =
    typeof raw.targetIssueId === 'string' && raw.targetIssueId.trim()
      ? raw.targetIssueId.trim()
      : null;
  const payload = parseCapturePayloadJson(JSON.stringify(raw.payload ?? { items: [] }));
  if (!payload) {
    if (!title.trim() && !targetIssueId) return null;
    return { title, targetIssueId, payload: { items: [] } };
  }
  const fields = raw.threadFields;
  return { title, targetIssueId, payload, ...(fields && typeof fields.label === 'string' && typeof fields.priority === 'string' ? {
    threadFields: { label: fields.label, priority: fields.priority, linkedChatId: typeof fields.linkedChatId === 'string' ? fields.linkedChatId : undefined, link: fields.link === true },
  } : {}) };
}

/** Reset module state (tests). */
export function resetIssueCaptureDraftForTests(): void {
  memoryDrafts.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}
