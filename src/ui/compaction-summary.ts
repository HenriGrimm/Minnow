import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { createIcon } from './icon';

const SECTION_TITLES = new Set([
  'Session goal', 'User notes', 'Files', 'Commits', 'Sub-agents', 'Earlier turns',
  'Open problems', 'Todos', 'Current status',
  'Working findings (assistant claims; revalidate after changes)',
  'File observations (historical source excerpts; recall rows for details)',
]);

const FOLDED_SECTIONS = new Set(['Working findings', 'File observations', 'Earlier turns', 'Sub-agents']);

interface SummarySection {
  title: string;
  text: string;
}

/** Read the shipped summary format without interpreting bracketed source lines as sections. */
function summarySections(text: string): SummarySection[] {
  const sections: SummarySection[] = [];
  let title = '';
  let lines: string[] = [];
  let fence = '';
  let inFile = false;
  let offset = 0;
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) sections.push({ title, text: body });
    lines = [];
  };
  const content = text.replace(/\r\n?/g, '\n').replace(/^## Prior context \(compacted[^\n]*(?:\n|$)/, '');
  for (const line of content.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !inFile) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    }
    if (!fence && /^<file\s+name=/.test(line)) inFile = content.indexOf('</file>', offset) >= 0;
    const heading = !fence && !inFile ? /^\[([^\]]+)\]\s*$/.exec(line)?.[1] : undefined;
    if (heading && SECTION_TITLES.has(heading)) {
      flush();
      title = heading;
    } else {
      lines.push(line);
    }
    if (!fence && /<\/file>\s*$/.test(line)) inFile = false;
    offset += line.length + 1;
  }
  flush();
  return sections;
}

function disclosure(label: string, className: string): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = className;
  const summary = document.createElement('summary');
  summary.append(createIcon('chevronRight', { size: 13 }), document.createTextNode(label));
  details.appendChild(summary);
  return details;
}

function appendMarkdown(parent: HTMLElement, text: string): void {
  if (!text.trim()) return;
  const prose = document.createElement('div');
  prose.className = 'compaction-summary__prose';
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.image = ({ text }) => escapeHtml(text);
  const html = marked.parse(text, { async: false, gfm: true, breaks: true, renderer });
  prose.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li',
      'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title'],
  });
  for (const anchor of prose.querySelectorAll<HTMLAnchorElement>('a')) {
    if (/^https?:\/\//i.test(anchor.getAttribute('href') ?? '')) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    } else {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''));
    }
  }
  parent.appendChild(prose);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** File attachments can dominate the goal; retain them as literal, collapsed excerpts. */
function appendSectionContent(parent: HTMLElement, text: string): void {
  const files = /<file\s+name=(["'])([^\n]+?)\1[^>]*>\s*\n?([\s\S]*?)(?:<\/file>|$)/g;
  let offset = 0;
  for (const match of text.matchAll(files)) {
    appendMarkdown(parent, text.slice(offset, match.index));
    const details = disclosure(match[2], 'compaction-summary__file');
    const pre = document.createElement('pre');
    pre.textContent = match[3].trim();
    pre.tabIndex = 0;
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', `Excerpt from ${match[2]}`);
    details.appendChild(pre);
    parent.appendChild(details);
    offset = match.index! + match[0].length;
  }
  appendMarkdown(parent, text.slice(offset));
}

/** Presentation of the exact checkpoint text, independent of the persisted machine state. */
export function createCompactionSummary(text: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'compaction-summary';
  const content = document.createElement('div');
  content.className = 'compaction-summary__content';
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', 'Conversation summary');

  for (const section of summarySections(text)) {
    const shortTitle = section.title.replace(/ \(.+\)$/, '');
    const folded = FOLDED_SECTIONS.has(shortTitle);
    const block = folded
      ? disclosure(shortTitle, 'compaction-summary__section compaction-summary__section--folded')
      : document.createElement('section');
    block.classList.add('compaction-summary__section');
    if (section.title && !folded) {
      const heading = document.createElement('h3');
      heading.textContent = section.title;
      block.appendChild(heading);
    }
    if (shortTitle !== section.title) {
      const note = document.createElement('p');
      note.className = 'compaction-summary__caveat';
      note.textContent = section.title.slice(shortTitle.length + 2, -1);
      block.appendChild(note);
    }
    appendSectionContent(block, section.text);
    content.appendChild(block);
  }
  if (!content.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'compaction-summary__caveat';
    empty.textContent = 'No summary text was saved for this checkpoint.';
    content.appendChild(empty);
  }

  root.appendChild(content);
  if (text.trim()) {
    const source = disclosure('View exact summary', 'compaction-summary__source');
    const pre = document.createElement('pre');
    pre.className = 'compaction-divider__text';
    pre.textContent = text;
    pre.tabIndex = 0;
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', 'Exact summary sent to the model');
    source.appendChild(pre);
    root.appendChild(source);
  }
  return root;
}
