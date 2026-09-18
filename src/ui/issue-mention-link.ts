import { splitIssueIdTokens } from '../chat/issue-mentions';

/** Clickable issue id in a chat bubble; opens the issue in the Issues app. */
export function createIssueMentionLink(issueId: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'issue-mention-link';
  btn.textContent = issueId;
  btn.title = `Open ${issueId}`;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    window.location.hash = `#/app/issues/${encodeURIComponent(issueId)}`;
  });
  return btn;
}

/** Replace occurrences of `issueIds` in the direct text nodes of `parent` with links. */
export function linkifyIssueMentions(parent: HTMLElement, issueIds: readonly string[]): void {
  if (!issueIds.length) return;
  const ids = new Set(issueIds);
  const textNodes = [...parent.childNodes].filter(
    (node): node is Text => node.nodeType === 3,
  );
  for (const node of textNodes) {
    const parts = splitIssueIdTokens(node.data, ids);
    if (!parts.some((part) => part.kind === 'issue')) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      frag.appendChild(
        part.kind === 'issue'
          ? createIssueMentionLink(part.value)
          : document.createTextNode(part.value),
      );
    }
    parent.replaceChild(frag, node);
  }
}
