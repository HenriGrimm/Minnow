import '../styles/settings-prompt-preview.css';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const promptMarkdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text, block }) => {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return block ? `<pre><code>${escaped}</code></pre>` : escaped;
    },
  },
});

/** Show readable Markdown by default while retaining the exact editable source. */
export function mountPromptPreview(
  container: HTMLElement,
  textarea: HTMLTextAreaElement,
  options: { stripFrontMatter?: boolean } = {},
): { refresh: () => void } {
  const toolbar = document.createElement('div');
  toolbar.className = 'settings-actions settings-prompt-preview-toolbar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'settings-action-btn';
  toggle.textContent = 'Edit source';
  toggle.setAttribute('aria-pressed', 'false');
  toolbar.appendChild(toggle);
  const preview = document.createElement('div');
  preview.className = 'settings-prompt-preview msg-bubble msg-bubble--md';
  preview.setAttribute('role', 'region');
  preview.setAttribute('aria-label', 'Prompt preview');
  container.insertBefore(toolbar, textarea);
  container.insertBefore(preview, textarea);
  textarea.hidden = true;

  const refresh = (): void => {
    const source = options.stripFrontMatter
      ? textarea.value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
      : textarea.value;
    const purifier = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(window);
    preview.innerHTML = purifier.sanitize(promptMarkdown.parse(source, { async: false }) as string, {
      USE_PROFILES: { html: true },
    });
    if (!source.trim()) preview.textContent = textarea.placeholder || 'No prompt content.';
    preview.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    });
  };

  toggle.addEventListener('click', () => {
    const editing = textarea.hidden;
    if (!editing) refresh();
    textarea.hidden = !editing;
    preview.hidden = editing;
    toggle.textContent = editing ? 'Preview Markdown' : 'Edit source';
    toggle.setAttribute('aria-pressed', String(editing));
    if (editing) textarea.focus();
  });
  refresh();
  return { refresh };
}
