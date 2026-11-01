import { createButton, setButtonClassName } from './components';
import type { Chat, ChatLink } from '../types';
import { listChatLinks, removeChatLink } from '../chat/links';
import { getActiveChat } from '../state/sessions';
import { createCodeRefLinkButton, createUrlLinkButton } from './code-ref-link';

const CHIP_HOST_IDS = ['chatLinkChips', 'chatAppLinkChips', 'desktopLinkChips'] as const;

/** Paint pinned-link chips for the given chat (or the active chat). */
export function syncChatLinkChipsFromChat(chat?: Chat | null): void {
  const target = chat ?? (typeof document === 'undefined' ? null : safeActiveChat());
  const links = listChatLinks(target);
  const hosts = CHIP_HOST_IDS.map((id) => document.getElementById(id)).filter(
    (el): el is HTMLElement => el != null,
  );
  if (!hosts.length) return;

  for (const host of hosts) {
    host.replaceChildren();
    if (!links.length) {
      host.classList.add('hidden');
      continue;
    }
    host.classList.remove('hidden');
    for (const link of links) {
      host.appendChild(createChatLinkChip(link, target));
    }
  }
}

/** Sync from the active chat after switch / drop / remove. */
export function syncChatLinkChipsFromActiveChat(): void {
  syncChatLinkChipsFromChat(safeActiveChat());
}

function safeActiveChat(): Chat | null {
  try {
    return getActiveChat();
  } catch {
    return null;
  }
}

/** One removable chip wrapping a `.code-ref-link` control. */
function createChatLinkChip(link: ChatLink, chat: Chat | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chat-link-chip';
  wrap.dataset.linkId = link.id;
  wrap.setAttribute('role', 'listitem');

  if (link.kind === 'file' && link.path) {
    wrap.appendChild(
      createCodeRefLinkButton({
        workspacePath: link.path,
      }),
    );
  } else if (link.kind === 'url' && link.url) {
    wrap.appendChild(createUrlLinkButton(link.url, { label: link.label }));
  }

  const removeBtn = createButton({ appearance: 'surface', variant: 'ghost', size: 'sm' });
  removeBtn.type = 'button';
  setButtonClassName(removeBtn, 'attach-chip-remove chat-link-chip__remove');
  removeBtn.setAttribute('aria-label', `Remove ${link.label}`);
  removeBtn.title = `Remove ${link.label}`;
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const owner = chat ?? safeActiveChat();
    if (!owner) return;
    if (removeChatLink(owner, link.id)) {
      syncChatLinkChipsFromChat(owner);
    }
  });
  wrap.appendChild(removeBtn);
  return wrap;
}
