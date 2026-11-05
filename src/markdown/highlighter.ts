/** Load grammars on the first code block. Uncommon languages use the full registry. */
export async function highlightCodeElement(block: HTMLElement): Promise<void> {
  try {
    const { default: common } = await import('./highlight-common');
    const language = /\blanguage-([\w-]+)\b/.exec(block.className)?.[1];
    if (!language || common.getLanguage(language)) {
      if (!block.dataset.highlighted) common.highlightElement(block);
      return;
    }
  } catch { /* The full registry can also highlight common languages. */ }
  try {
    const { default: full } = await import('highlight.js');
    if (!block.dataset.highlighted) full.highlightElement(block);
  } catch { /* Keep the code readable when the highlighter is unavailable. */ }
}

/** Re-run highlight.js on fenced blocks so class-based colors match the active stylesheet. */
export function refreshHljsInDocument(): void {
  document.querySelectorAll('pre code.hljs').forEach((block) => {
    const el = block as HTMLElement;
    const plain = el.textContent ?? '';
    el.removeAttribute('data-highlighted');
    el.classList.remove('hljs');
    el.textContent = plain;
    void highlightCodeElement(el);
  });
}
