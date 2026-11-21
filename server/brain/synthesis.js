/** Text helpers shared by skill suggestions and legacy memory import. */
const CONTEXT_WINDOW = 6;

export function slugifyFactTitle(title) {
  const slug = String(title ?? 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

/**
 * @param {Array<{ role?: string, content?: string | unknown[] }>} messages
 * @param {{ window?: number, perMessageChars?: number, roles?: string[] }} [opts]
 * @returns {string}
 */
export function formatMessagesForExtraction(messages, opts = {}) {
  const window = Math.max(1, opts.window ?? CONTEXT_WINDOW);
  const perMessageChars = Math.max(100, opts.perMessageChars ?? 500);
  const roles = Array.isArray(opts.roles) && opts.roles.length > 0 ? new Set(opts.roles) : null;

  const lines = [];
  for (const msg of messages.slice(-window)) {
    const role = String(msg.role ?? '?');
    if (roles && !roles.has(role)) continue;
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content
        .filter((b) => b && typeof b === 'object' && /** @type {{ type?: string }} */ (b).type === 'text')
        .map((b) => String(/** @type {{ text?: string }} */ (b).text ?? ''))
        .join(' ');
    }
    let text = String(content ?? '').trim();
    if (text.length > perMessageChars) text = `${text.slice(0, perMessageChars)}...`;
    if (text) lines.push(`[${role}] ${text}`);
  }
  return lines.join('\n');
}

export const TITLE_STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'at', 'to',
  'for', 'and', 'or', 'but', 'with', 'by', 'from', 'user', 'has', 'have',
  'had', 'be', 'been', 'being', 'uses', 'use', 'used', 'my', 'me', 'our',
  'your', 'his', 'her', 'their', 'its', 'this', 'that', 'they', 'it', 'who',
  'what', 'when', 'where', 'will', 'would', 'could', 'should', 'may', 'not',
  'no', 'so', 'as', 'if', 'he', 'she', 'we', 'you',
]);

export function titleKeywords(title) {
  return new Set(
    String(title ?? '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !TITLE_STOP.has(w)),
  );
}
