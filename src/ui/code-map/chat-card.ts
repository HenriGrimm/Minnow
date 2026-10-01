import type { CodeMapMessageSnapshot } from '../../types';
import '../../styles/code-map-chat-card.css';

export function renderCodeMapChatCard(bubble: HTMLDivElement, card: CodeMapMessageSnapshot): void {
  bubble.classList.add('msg-bubble--code-map');
  const context = document.createElement('article');
  context.className = 'code-map-chat-card';
  context.setAttribute('aria-label', `Code map context: ${card.title}`);
  const kind = document.createElement('span');
  kind.className = 'code-map-chat-card__kind';
  kind.textContent = card.kind;
  const title = document.createElement('strong');
  title.className = 'code-map-chat-card__title';
  title.textContent = card.title;
  context.append(kind, title);
  const location = card.path ? `${card.path}${card.line ? `:${card.line}` : ''}` : card.detail;
  if (location) {
    const path = document.createElement('span');
    path.className = 'code-map-chat-card__path';
    path.textContent = location;
    context.append(path);
  }
  if (card.summary) {
    const summary = document.createElement('p');
    summary.className = 'code-map-chat-card__summary';
    summary.textContent = card.summary.slice(0, 240);
    context.append(summary);
  }
  if (card.path && card.detail && card.detail !== card.path) {
    const detail = document.createElement('span');
    detail.className = 'code-map-chat-card__path';
    detail.textContent = card.detail;
    context.append(detail);
  }
  const question = document.createElement('p');
  question.className = 'code-map-chat-card__question';
  question.textContent = card.question;
  bubble.replaceChildren(context, question);
}
