import { createSelect, createCheckbox, setControlClassName } from '../ui/components';
import { createButton, setButtonClassName } from '../ui/components';
/**
 * Annotations panel (MIN-368): collapsible list of every mark (shape/pin) on the current page,
 * filterable by linked chat, with jump-both-ways actions (highlight on page / open the chat
 * turn it was sent to) and bulk delete. Mode-free — sibling of design-tool.ts/overlay.ts, no
 * preview-panel.ts coupling; the host decides where to mount it and wires the callbacks to the
 * actual preview/chat plumbing (annotation-nav.ts, annotation-store.ts erase functions).
 */

import { isAnchorDead } from './annotation-store';
import type { PageAnnotations } from './annotation-store';
import type { AnchorCandidate, AnnotationLink, CommentPin, DesignShape } from './shape-model';

const ROOT_CLASS = 'mn-design-annotations-panel';

export interface AnnotationsPanelItem {
  id: string;
  type: 'shape' | 'pin';
  /** Shape kind ('rect'/'pen'/'arrow'/'label') or 'comment' for pins. */
  kind: string;
  links: AnnotationLink[];
  dead: boolean;
}

export interface AnnotationsPanelCallbacks {
  /** Pulse-highlight this mark on the live page overlay. */
  onHighlight: (item: AnnotationsPanelItem) => void;
  /** Switch to `chatId` and scroll to `turnId` (reuses annotation-nav.ts's jumpToChatTurn). */
  onJumpToChat: (chatId: string, turnId: string) => void;
  /** Delete the selected shapes/pins (host calls eraseShape/erasePin + persists). */
  onBulkDelete: (ids: { shapeIds: string[]; pinIds: string[] }) => void | Promise<void>;
}

export interface AnnotationsPanelHandle {
  readonly root: HTMLElement;
  /** Replace the page's annotation data (and optional live anchor candidates for dead-badges). */
  setData(data: PageAnnotations, candidates?: AnchorCandidate[]): void;
  /** Filter the list to marks linked to this chat id, or null to show everything. */
  setChatFilter(chatId: string | null): void;
  getChatFilter(): string | null;
  /** Unique chat ids referenced by any mark's links, for building the filter dropdown. */
  getLinkedChatIds(): string[];
  isCollapsed(): boolean;
  setCollapsed(collapsed: boolean): void;
  /** Currently checked shape/pin ids. */
  getSelection(): { shapeIds: string[]; pinIds: string[] };
  destroy(): void;
}

function kindLabel(item: AnnotationsPanelItem): string {
  return item.type === 'pin' ? 'comment' : item.kind === 'pen' ? 'sketch' : item.kind;
}

function toItems(
  data: PageAnnotations,
  candidates: AnchorCandidate[],
): AnnotationsPanelItem[] {
  const shapeItems: AnnotationsPanelItem[] = data.shapes.map((shape: DesignShape) => ({
    id: shape.id,
    type: 'shape',
    kind: shape.kind,
    links: shape.links ?? [],
    dead: isAnchorDead(shape.anchor, candidates),
  }));
  const pinItems: AnnotationsPanelItem[] = data.pins.map((pin: CommentPin) => ({
    id: pin.id,
    type: 'pin',
    kind: 'comment',
    links: pin.links ?? [],
    dead: isAnchorDead(pin.anchor, candidates),
  }));
  return [...shapeItems, ...pinItems];
}

/** Mount the panel into `host` (host owns lifecycle/positioning; this owns its own subtree). */
export function mountAnnotationsPanel(
  host: HTMLElement,
  callbacks: AnnotationsPanelCallbacks,
): AnnotationsPanelHandle {
  const root = document.createElement('div');
  root.className = ROOT_CLASS;

  const header = document.createElement('div');
  header.className = `${ROOT_CLASS}__header`;
  root.appendChild(header);

  const collapseBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  collapseBtn.type = 'button';
  setButtonClassName(collapseBtn, `${ROOT_CLASS}__collapse`);
  collapseBtn.textContent = 'Annotations';
  collapseBtn.setAttribute('aria-expanded', 'true');
  header.appendChild(collapseBtn);

  const filterSelect = createSelect({ appearance: 'surface',});
  setControlClassName(filterSelect, `${ROOT_CLASS}__filter`);
  filterSelect.setAttribute('aria-label', 'Filter by linked chat');
  header.appendChild(filterSelect);

  const bulkDeleteBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  bulkDeleteBtn.type = 'button';
  setButtonClassName(bulkDeleteBtn, `${ROOT_CLASS}__bulk-delete`);
  bulkDeleteBtn.textContent = 'Delete selected';
  bulkDeleteBtn.disabled = true;
  header.appendChild(bulkDeleteBtn);

  const body = document.createElement('div');
  body.className = `${ROOT_CLASS}__body`;
  root.appendChild(body);

  const emptyRow = document.createElement('div');
  emptyRow.className = `${ROOT_CLASS}__empty`;
  emptyRow.textContent = 'No marks on this page yet.';
  body.appendChild(emptyRow);

  host.appendChild(root);

  let items: AnnotationsPanelItem[] = [];
  let chatFilter: string | null = null;
  const selected = new Set<string>();

  function linkedChatIds(): string[] {
    const ids = new Set<string>();
    for (const item of items) {
      for (const link of item.links) ids.add(link.chatId);
    }
    return [...ids].sort();
  }

  function mostRecentLinkFor(item: AnnotationsPanelItem, chatId: string): AnnotationLink | undefined {
    return item.links.find((l) => l.chatId === chatId);
  }

  function syncBulkDeleteEnabled(): void {
    bulkDeleteBtn.disabled = selected.size === 0;
  }

  function syncFilterOptions(): void {
    const ids = linkedChatIds();
    const current = filterSelect.value;
    filterSelect.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All chats';
    filterSelect.appendChild(allOpt);
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      filterSelect.appendChild(opt);
    }
    filterSelect.value = ids.includes(current) ? current : '';
  }

  function render(): void {
    body.replaceChildren();
    selected.clear();
    syncBulkDeleteEnabled();

    const visible = chatFilter
      ? items.filter((item) => item.links.some((l) => l.chatId === chatFilter))
      : items;

    if (visible.length === 0) {
      body.appendChild(emptyRow);
      return;
    }

    for (const item of visible) {
      const row = document.createElement('div');
      row.className = `${ROOT_CLASS}__row`;
      row.dataset.itemId = item.id;
      row.dataset.itemType = item.type;

      const checkbox = createCheckbox({ appearance: 'surface', label: '' }).input;
      checkbox.type = 'checkbox';
      setControlClassName(checkbox, `${ROOT_CLASS}__row-check`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(item.id);
        else selected.delete(item.id);
        syncBulkDeleteEnabled();
      });
      row.appendChild(checkbox);

      const kindEl = document.createElement('span');
      kindEl.className = `${ROOT_CLASS}__row-kind`;
      kindEl.textContent = kindLabel(item);
      row.appendChild(kindEl);

      if (item.dead) {
        const badge = document.createElement('span');
        badge.className = `${ROOT_CLASS}__row-badge`;
        badge.textContent = 'moved/removed';
        row.appendChild(badge);
      }

      const highlightBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
      highlightBtn.type = 'button';
      setButtonClassName(highlightBtn, `${ROOT_CLASS}__row-highlight`);
      highlightBtn.title = 'Highlight on page';
      highlightBtn.textContent = '◎';
      highlightBtn.addEventListener('click', () => callbacks.onHighlight(item));
      row.appendChild(highlightBtn);

      if (item.links.length > 0) {
        const linksWrap = document.createElement('span');
        linksWrap.className = `${ROOT_CLASS}__row-links`;
        const seenChats = new Set<string>();
        for (const link of item.links) {
          if (seenChats.has(link.chatId)) continue;
          seenChats.add(link.chatId);
          const chip = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
          chip.type = 'button';
          setButtonClassName(chip, `${ROOT_CLASS}__link-chip`);
          chip.dataset.chatId = link.chatId;
          chip.title = `Open chat turn`;
          chip.textContent = '💬';
          chip.addEventListener('click', () => {
            const target = mostRecentLinkFor(item, link.chatId) ?? link;
            callbacks.onJumpToChat(target.chatId, target.turnId);
          });
          linksWrap.appendChild(chip);
        }
        row.appendChild(linksWrap);
      }

      body.appendChild(row);
    }
  }

  collapseBtn.addEventListener('click', () => {
    const collapsed = root.classList.toggle(`${ROOT_CLASS}--collapsed`);
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  filterSelect.addEventListener('change', () => {
    chatFilter = filterSelect.value || null;
    render();
  });

  bulkDeleteBtn.addEventListener('click', () => {
    const shapeIds = items
      .filter((i) => i.type === 'shape' && selected.has(i.id))
      .map((i) => i.id);
    const pinIds = items.filter((i) => i.type === 'pin' && selected.has(i.id)).map((i) => i.id);
    if (shapeIds.length === 0 && pinIds.length === 0) return;
    void callbacks.onBulkDelete({ shapeIds, pinIds });
  });

  return {
    root,
    setData(data, candidates = []) {
      items = toItems(data, candidates);
      syncFilterOptions();
      render();
    },
    setChatFilter(chatId) {
      chatFilter = chatId;
      filterSelect.value = chatId ?? '';
      render();
    },
    getChatFilter() {
      return chatFilter;
    },
    getLinkedChatIds() {
      return linkedChatIds();
    },
    isCollapsed() {
      return root.classList.contains(`${ROOT_CLASS}--collapsed`);
    },
    setCollapsed(collapsed) {
      root.classList.toggle(`${ROOT_CLASS}--collapsed`, collapsed);
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    },
    getSelection() {
      const shapeIds = items
        .filter((i) => i.type === 'shape' && selected.has(i.id))
        .map((i) => i.id);
      const pinIds = items.filter((i) => i.type === 'pin' && selected.has(i.id)).map((i) => i.id);
      return { shapeIds, pinIds };
    },
    destroy() {
      root.remove();
    },
  };
}
