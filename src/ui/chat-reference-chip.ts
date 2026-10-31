import { chatIdFromLink, chatLink } from '../state/chat-relationships';
import { chatReferenceTitle } from '../state/chat-reference-titles';

/** Only this Minnow instance (including old loopback ports) owns absolute chat links. */
export function chatIdFromHref(href: string): string | null {
  const raw = href.trim();
  if (raw.startsWith('#')) return chatIdFromLink(raw);
  try {
    const url = new URL(raw);
    const current = new URL(window.location.href);
    const loopback = (host: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search) return null;
    if (url.origin !== current.origin && !(loopback(url.hostname) && loopback(current.hostname))) return null;
    return chatIdFromLink(url.hash);
  } catch {
    return null;
  }
}

/** Keep the chat id in the anchor while displaying a human-readable conversation title. */
export function decorateChatReference(anchor: HTMLAnchorElement, chatId: string): void {
  const name = chatReferenceTitle(chatId);
  const label = name || `Chat · ${chatId.slice(0, 8)}`;
  anchor.classList.add('chat-reference-chip');
  anchor.href = chatLink(chatId);
  anchor.removeAttribute('target');
  anchor.removeAttribute('rel');
  anchor.title = `Open chat: ${label}`;
  anchor.setAttribute('aria-label', `Open chat: ${label}`);
  anchor.replaceChildren();
  const icon = document.createElement('span');
  icon.className = 'chat-reference-chip__icon';
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z');
  svg.append(path);
  icon.append(svg);
  const title = document.createElement('span');
  title.className = 'chat-reference-chip__title';
  title.textContent = label;
  anchor.append(icon, title);
}

/** Source ranges let paste and transcript rendering recognize exactly the same references. */
export function chatReferencesInText(text: string): Array<{ start: number; end: number; chatId: string }> {
  const pattern = /\[[^\]\n]*\]\((?:https?:\/\/[^\s<>)]*|#\/app\/code\/chat\?[^\s<>)]*)\)|<(?:https?:\/\/[^\s<>]*|#\/app\/code\/chat\?[^\s<>]*)>|https?:\/\/[^\s<>]+|#\/app\/code\/chat\?[^\s<>]+/g;
  const references: Array<{ start: number; end: number; chatId: string }> = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const href = value.startsWith('[') ? value.slice(value.indexOf('](') + 2, -1)
      : value.startsWith('<') ? value.slice(1, -1) : value.replace(/[.,;!?)]+$/, '');
    const chatId = chatIdFromHref(href);
    if (!chatId) continue;
    const consumed = value.startsWith('[') || value.startsWith('<') ? value.length : href.length;
    references.push({ start: match.index, end: match.index + consumed, chatId });
  }
  return references;
}

/** Plain user messages may contain bare, angle-bracketed, or Markdown chat links. */
export function linkifyChatReferences(parent: HTMLElement): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType !== 3) continue;
    const text = node.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let end = 0;
    for (const reference of chatReferencesInText(text)) {
      fragment.append(document.createTextNode(text.slice(end, reference.start)));
      const anchor = document.createElement('a');
      decorateChatReference(anchor, reference.chatId);
      fragment.append(anchor);
      end = reference.end;
    }
    if (!end) continue;
    fragment.append(document.createTextNode(text.slice(end)));
    node.replaceWith(fragment);
  }
}
