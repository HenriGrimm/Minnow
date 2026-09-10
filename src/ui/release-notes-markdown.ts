import DOMPurify from 'dompurify';
import { marked } from 'marked';

const RELEASE_NOTE_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'ul',
];

/** Render trusted release prose as sanitized Markdown with safe external links. */
export function renderReleaseNotesMarkdown(container: HTMLElement, markdown: string): void {
  let html: string;
  try {
    html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  } catch {
    container.textContent = markdown;
    return;
  }

  const purifier = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(window);
  container.innerHTML = purifier.sanitize(html, {
    ALLOWED_TAGS: RELEASE_NOTE_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
  });
  container.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  });
}
