/**
 * Inline markdown ↔ DOM for the editable blocks.
 *
 * Only the constrained subset from §7 crosses this boundary: bold, italic,
 * strike, inline code, links, and the two mention chips. Anything else in a
 * line survives as literal text, because a block that contains something this
 * cannot represent is still safer round-tripped as its own characters than
 * silently normalized.
 *
 * The pairing that matters is `inlineToHtml` / `htmlToInline`: whatever the
 * first produces, the second must turn back into the same markdown. Blocks are
 * only ever re-serialized when the user edited them, so a drift here costs one
 * edited paragraph, never the document — but it is still tested both ways.
 *
 * Phase 3 of `documentation/plans/issues-app-v2.md`.
 */

import { displayIssueAttachmentSrc, canonicalIssueAttachmentSrc } from '../state/issue-attachments-api';

// ── Patterns ─────────────────────────────────────────────────────────────────

/** Matches `#KEY-12` — an issue mention that becomes a real `issueRefs` entry. */
export const ISSUE_MENTION_RE = /#([A-Z][A-Z0-9]*-\d+)\b/g;

/**
 * Matches `@path/to/file.ts:12-34`, `@file.ts:12`, or `@src/dir/file.ts`.
 *
 * Requires a dot in the last segment so `@builder` (an agent) and an email-ish
 * string do not become code refs.
 */
export const CODE_MENTION_RE =
  /@((?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?/g;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sentinel wrapping stashed HTML so later passes never rescan it.
 *
 * A NUL cannot appear in markdown anyone typed, so a placeholder can never
 * collide with real content. Written as an escape so the source stays text.
 */
const SENTINEL = '\u0000';

/** Placeholder scheme keeps already-converted spans out of later passes. */
interface Vault {
  slots: string[];
}

function stash(vault: Vault, html: string): string {
  vault.slots.push(html);
  return `${SENTINEL}${vault.slots.length - 1}${SENTINEL}`;
}

function unstash(text: string, vault: Vault): string {
  const pattern = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  return text.replace(pattern, (_all, index) => vault.slots[Number(index)] ?? '');
}

// ── To HTML ──────────────────────────────────────────────────────────────────

/**
 * Render one line of inline markdown to HTML.
 *
 * Order matters: code spans are extracted first so `**` inside backticks is not
 * treated as emphasis, and links before mentions so a `#` inside a URL is not
 * turned into an issue chip.
 */
export function inlineToHtml(markdown: string): string {
  const vault: Vault = { slots: [] };
  let text = markdown ?? '';

  text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_all, ticks: string, body: string) =>
    stash(vault, `<code>${escapeHtml(body)}</code>`),
  );

  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_all, alt: string, src: string, title?: string) => {
      const displaySrc = displayIssueAttachmentSrc(src);
      return stash(
        vault,
        `<img src="${escapeHtml(displaySrc)}" alt="${escapeHtml(alt)}"${
          title ? ` title="${escapeHtml(title)}"` : ''
        }>`,
      );
    },
  );
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_all, label: string, href: string, title?: string) => {
      const displayHref = displayIssueAttachmentSrc(href);
      return stash(
        vault,
        `<a href="${escapeHtml(displayHref)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(
          label,
        )}</a>`,
      );
    },
  );

  text = text.replace(ISSUE_MENTION_RE, (all, id: string) =>
    stash(
      vault,
      `<span class="mn-mention mn-mention--issue" data-mention="issue" data-issue-id="${escapeHtml(
        id,
      )}" contenteditable="false">${escapeHtml(all)}</span>`,
    ),
  );
  text = text.replace(CODE_MENTION_RE, (all, path: string, start?: string, end?: string) => {
    const attrs = [
      `data-mention="code"`,
      `data-path="${escapeHtml(path)}"`,
      start ? `data-start-line="${start}"` : '',
      end ? `data-end-line="${end}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return stash(
      vault,
      `<span class="mn-mention mn-mention--code" ${attrs} contenteditable="false">${escapeHtml(
        all,
      )}</span>`,
    );
  });

  text = text.replace(/<br\s*\/?\s*>/gi, () => stash(vault, '<br>'));

  text = escapeHtml(text);
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');

  return unstash(text, vault);
}

/**
 * Text nodes are emitted as they are, without escaping markdown characters.
 *
 * This is a deliberate call, and it follows from "markdown is canonical". The
 * audience types markdown by reflex; escaping their `**bold**` into
 * `\*\*bold\*\*` would mean the editor silently refuses the notation the file
 * format is made of, and the user would see backslashes appear as they type.
 * Not escaping means typed markdown becomes real markdown on the next commit
 * and renders — which is what they expected in the first place.
 *
 * The cost is that a literal asterisk in prose can be re-read as emphasis on a
 * later parse. That is the trade markdown itself makes, and the user is looking
 * at the rendered result the whole time, so it is visible rather than silent.
 */
function escapeMarkdownText(text: string): string {
  return text;
}

// ── From HTML ────────────────────────────────────────────────────────────────

/**
 * Walk a DOM subtree back to inline markdown.
 *
 * Unknown elements contribute their text and nothing else — the editor should
 * never have produced them, and emitting raw HTML from the WYSIWYG is exactly
 * the "second source of truth" the brief bans.
 */
export function htmlToInline(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) {
    out += nodeToInline(child);
  }
  return out;
}

function nodeToInline(node: Node): string {
  if (node.nodeType === 3 /* text */) {
    return escapeMarkdownText(node.nodeValue ?? '');
  }
  if (node.nodeType !== 1 /* element */) return '';

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (el.getAttribute('data-mention')) {
    return el.textContent ?? '';
  }

  switch (tag) {
    case 'br':
      return '\n';
    case 'code':
      return wrapCode(el.textContent ?? '');
    case 'strong':
    case 'b':
      return `**${htmlToInline(el)}**`;
    case 'em':
    case 'i':
      return `*${htmlToInline(el)}*`;
    case 's':
    case 'del':
    case 'strike':
      return `~~${htmlToInline(el)}~~`;
    case 'a': {
      const href = canonicalIssueAttachmentSrc(el.getAttribute('href') ?? '');
      const label = htmlToInline(el);
      if (!href) return label;
      return `[${label}](${href})`;
    }
    case 'img': {
      const src = canonicalIssueAttachmentSrc(el.getAttribute('src') ?? '');
      const alt = el.getAttribute('alt') ?? '';
      return `![${alt}](${src})`;
    }
    default:
      return htmlToInline(el);
  }
}

/** Choose a backtick run long enough to contain the text. */
function wrapCode(text: string): string {
  const longest = /`+/g;
  let max = 0;
  let match: RegExpExecArray | null;
  while ((match = longest.exec(text)) !== null) max = Math.max(max, match[0].length);
  const ticks = '`'.repeat(max + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** An issue or code reference found in a body of markdown. */
export interface InlineRefs {
  issueIds: string[];
  codeRefs: Array<{ path: string; startLine?: number; endLine?: number }>;
}

/**
 * Collect the mentions in a document so they can be written as real links.
 *
 * Deliberately re-scans the markdown rather than the DOM: an agent writing
 * `#KEY-12` through `issue_update` should produce the same links as a user
 * typing it in the editor.
 */
export function collectInlineRefs(markdown: string): InlineRefs {
  const text = markdown ?? '';
  const issueIds: string[] = [];
  const codeRefs: InlineRefs['codeRefs'] = [];

  const scannable = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '');

  for (const match of scannable.matchAll(ISSUE_MENTION_RE)) {
    const id = match[1];
    if (!issueIds.includes(id)) issueIds.push(id);
  }
  for (const match of scannable.matchAll(CODE_MENTION_RE)) {
    const path = match[1];
    const startLine = match[2] ? Number(match[2]) : undefined;
    const endLine = match[3] ? Number(match[3]) : startLine;
    if (
      codeRefs.some(
        (ref) => ref.path === path && ref.startLine === startLine && ref.endLine === endLine,
      )
    ) {
      continue;
    }
    codeRefs.push({ path, startLine, endLine });
  }

  return { issueIds, codeRefs };
}
