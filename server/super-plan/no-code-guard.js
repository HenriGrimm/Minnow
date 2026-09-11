/**
 * Plans and specs describe changes in prose; they never carry implementation
 * code. Server twin of `src/chat/super-plan/no-code-guard.ts`, applied when a
 * Super Plan stage saves its artifact.
 */

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Fence languages allowed anywhere: shells, data formats, diagrams, prose. */
const ALLOWED_FENCE_LANGS = new Set([
  '', 'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'cmd', 'console', 'terminal',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'xml', 'mermaid', 'diff', 'patch', 'text', 'txt',
  'plaintext', 'markdown', 'md', 'csv',
]);

/** Implementation languages that must not appear as fenced blocks. */
const BLOCKED_FENCE_LANGS = new Set([
  'typescript', 'ts', 'tsx', 'javascript', 'js', 'jsx', 'python', 'py', 'rust', 'rs', 'go', 'java',
  'kotlin', 'swift', 'c', 'cpp', 'csharp', 'cs', 'ruby', 'rb', 'php', 'sql', 'html', 'css', 'scss',
  'vue', 'svelte',
]);

const FENCED_BLOCK_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeFenceLang(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0] ?? '';
}

/**
 * @param {string} body
 * @param {number} blockStart
 * @returns {boolean}
 */
function isInTestSection(body, blockStart) {
  const prefix = body.slice(0, blockStart);
  const testHeading = prefix.lastIndexOf('**Test:**');
  const buildHeading = prefix.lastIndexOf('**Build:**');
  if (testHeading < 0) return false;
  return buildHeading < testHeading;
}

/**
 * @param {string} content
 * @returns {string | null} why the content is refused, or null when it passes
 */
export function findImplementationCode(content) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return null;
  const body = trimmed.replace(FRONT_MATTER_RE, '');
  FENCED_BLOCK_RE.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let match;
  while ((match = FENCED_BLOCK_RE.exec(body)) !== null) {
    const lang = normalizeFenceLang(match[1] ?? '');
    if (ALLOWED_FENCE_LANGS.has(lang)) continue;
    if (BLOCKED_FENCE_LANGS.has(lang)) {
      return `Plan files must not include fenced ${lang} implementation blocks. Describe changes in prose with file paths and function names; use bash/sh only under **Test:** steps.`;
    }
    if (!isInTestSection(body, match.index)) {
      return `Plan files must not include fenced \`${lang}\` blocks outside **Test:** steps. Describe implementation in prose with file paths and function names.`;
    }
  }
  return null;
}
