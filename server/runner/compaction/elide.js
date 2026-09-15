/** Tool results shorter than this stay verbatim; a stub would save next to nothing. */
export const ELIDE_MIN_CHARS = 1200;

const STUB_PREFIX = '[tool result elided from context — ';

/**
 * @param {unknown} content
 */
export function isElidedToolStub(content) {
  return typeof content === 'string' && content.startsWith(STUB_PREFIX);
}

/**
 * @param {number} chars
 */
function formatSize(chars) {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k chars`;
  return `${chars} chars`;
}

/**
 * Replace an old tool result body with a pointer the model can recall. Returns
 * the row unchanged when it is short, already a stub, or not a tool row.
 *
 * @param {any} row
 * @param {{ rowId: number | null, toolName?: string }} meta
 */
export function elideToolRow(row, meta) {
  if (row?.role !== 'tool' || typeof row.content !== 'string') return row;
  if (row.content.length < ELIDE_MIN_CHARS || isElidedToolStub(row.content)) return row;
  const where = meta.rowId != null ? `#${meta.rowId}` : 'an earlier row';
  const tool = meta.toolName ? `${meta.toolName}, ` : '';
  const recall = meta.rowId != null ? ` Call recall_history with rows "${meta.rowId}" for the full text.` : '';
  const firstLine = row.content.split(/\r?\n/, 1)[0].trim().slice(0, 160);
  return {
    ...row,
    content: `${STUB_PREFIX}${where}, ${tool}${formatSize(row.content.length)}]${firstLine ? ` ${firstLine}` : ''}${recall}`,
  };
}
