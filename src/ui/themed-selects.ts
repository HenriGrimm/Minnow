const SELECTS = 'select:not([multiple]):not([size]), select[size="1"]:not([multiple])';

/** Give CSS-styled selects a shrinkable label so long model, branch and folder
 * names truncate in the closed control but remain fully readable in the popup.
 * The browser owns selectedcontent, values, events, focus and option semantics. */
export function installThemedSelects(): () => void {
  if (!CSS.supports('appearance', 'base-select')) return () => {};

  const enhance = (select: HTMLSelectElement): void => {
    const ownButton = select.querySelector(':scope > .mn-select-button');
    if (!select.matches(SELECTS) || select.classList.contains('model-select-native')) {
      ownButton?.remove();
      return;
    }
    // Respect a picker that already supplies its own customizable button.
    if (select.querySelector(':scope > button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mn-select-button';
    button.appendChild(document.createElement('selectedcontent'));
    select.prepend(button);
  };

  for (const select of document.querySelectorAll<HTMLSelectElement>('select')) enhance(select);
  const observer = new MutationObserver((records) => {
    const pending = new Set<HTMLSelectElement>();
    for (const record of records) {
      if (record.target instanceof Element) {
        const select = record.target.closest('select');
        if (select) pending.add(select);
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLSelectElement) pending.add(node);
        for (const select of node.querySelectorAll<HTMLSelectElement>('select')) pending.add(select);
      }
    }
    for (const select of pending) {
      if (select.isConnected) enhance(select);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['multiple', 'size', 'class'],
  });
  return () => observer.disconnect();
}
