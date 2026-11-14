/**
 * Render workspace PDF/Excel/Word files as HTML for the file viewer preview pane.
 */

import { fileExtension as extensionOf } from '../../src/attachments/document-extensions.mjs';
import { getDocumentPreviewKind } from '../../src/attachments/document-extensions.mjs';
import { previewScrollbarCss } from './scrollbars.js';

/** Maximum spreadsheet rows rendered per sheet in preview HTML. */
const MAX_PREVIEW_ROWS_PER_SHEET = 1000;

/** Maximum spreadsheet sheets rendered in preview HTML. */
const MAX_PREVIEW_SHEETS = 50;

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PREVIEW_STYLES = `
${previewScrollbarCss}
body {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  margin: 0;
  padding: 16px 20px 28px;
  color: #1a1a1a;
  background: #fff;
  line-height: 1.5;
}
h1, h2, h3 { margin: 0 0 12px; }
table { border-collapse: collapse; margin: 0 0 24px; width: max-content; max-width: 100%; }
th, td { border: 1px solid #c8c8c8; padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f3f3f3; font-weight: 600; }
.sheet-title { margin-top: 24px; }
.sheet-title:first-child { margin-top: 0; }
.muted { color: #666; font-size: 13px; }
`;

const FORBIDDEN_EMBED_TAGS = ['script', 'iframe', 'object', 'embed'];

/**
 * @param {string} href
 * @returns {boolean}
 */
function isAllowedDocumentHref(href) {
  const trimmed = String(href ?? '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('#')) return true;
  if (lower.startsWith('http://') || lower.startsWith('https://')) return true;
  if (lower.startsWith('mailto:')) return true;
  return false;
}

/**
 * Strip unsafe markup from SheetJS / mammoth HTML fragments before embedding.
 *
 * @param {string} html
 * @returns {string}
 */
export function sanitizeDocumentHtml(html) {
  let sanitized = String(html ?? '');

  for (const tag of FORBIDDEN_EMBED_TAGS) {
    sanitized = sanitized.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'),
      '',
    );
    sanitized = sanitized.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  sanitized = sanitized.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  sanitized = sanitized.replace(
    /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, doubleQuoted, singleQuoted, bare) => {
      const href = (doubleQuoted ?? singleQuoted ?? bare ?? '').trim();
      return isAllowedDocumentHref(href) ? match : '';
    },
  );

  return sanitized;
}

/**
 * SheetJS `sheet_to_html` returns a full document; keep only the table fragment.
 *
 * @param {string} html
 * @returns {string}
 */
function extractTableFromSheetHtml(html) {
  const match = String(html ?? '').match(/<table\b[\s\S]*?<\/table>/i);
  return match ? match[0] : '';
}

/**
 * Limit a worksheet to the first N rows for preview rendering.
 *
 * @param {typeof import('xlsx')} XLSX
 * @param {import('xlsx').WorkSheet} sheet
 * @param {number} maxRows
 * @returns {{ sheet: import('xlsx').WorkSheet, truncated: boolean }}
 */
function limitSheetRows(XLSX, sheet, maxRows) {
  if (!sheet?.['!ref']) {
    return { sheet, truncated: false };
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const rowCount = range.e.r - range.s.r + 1;
  if (rowCount <= maxRows) {
    return { sheet, truncated: false };
  }

  const limitedEndRow = range.s.r + maxRows - 1;
  const limited = {};
  for (const [key, value] of Object.entries(sheet)) {
    if (key.startsWith('!')) continue;
    const cell = XLSX.utils.decode_cell(key);
    if (cell.r <= limitedEndRow) {
      limited[key] = value;
    }
  }

  limited['!ref'] = XLSX.utils.encode_range({
    s: range.s,
    e: { c: range.e.c, r: limitedEndRow },
  });
  if (Array.isArray(sheet['!merges'])) {
    limited['!merges'] = sheet['!merges'].filter(
      (merge) => merge.s.r <= limitedEndRow && merge.e.r <= limitedEndRow,
    );
  }
  if (sheet['!cols']) limited['!cols'] = sheet['!cols'];
  if (sheet['!rows']) limited['!rows'] = sheet['!rows'];

  return { sheet: limited, truncated: true };
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function spreadsheetBufferToHtml(buffer, filename) {
  let XLSX;
  try {
    const mod = await import('xlsx');
    XLSX = mod.default ?? mod;
  } catch {
    throw new Error('Internal error: xlsx module unavailable');
  }

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const totalSheets = workbook.SheetNames.length;
  const sheetNames = workbook.SheetNames.slice(0, MAX_PREVIEW_SHEETS);
  const sheetsTruncated = totalSheets > MAX_PREVIEW_SHEETS;

  const parts = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>${escapeHtml(filename)}</title>`,
    `<style>${PREVIEW_STYLES}</style></head><body>`,
    `<p class="muted">${escapeHtml(filename)} · ${totalSheets} sheet(s)</p>`,
  ];

  if (sheetsTruncated) {
    parts.push(
      `<p class="muted">Preview truncated: showing first ${MAX_PREVIEW_SHEETS} of ${totalSheets} sheets.</p>`,
    );
  }

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const { sheet: limitedSheet, truncated: rowsTruncated } = limitSheetRows(
      XLSX,
      sheet,
      MAX_PREVIEW_ROWS_PER_SHEET,
    );
    const rawTableHtml = XLSX.utils.sheet_to_html(limitedSheet);
    const tableHtml = sanitizeDocumentHtml(extractTableFromSheetHtml(rawTableHtml));
    parts.push(`<h2 class="sheet-title">${escapeHtml(sheetName)}</h2>${tableHtml}`);
    if (rowsTruncated) {
      parts.push(
        `<p class="muted">Preview truncated: showing first ${MAX_PREVIEW_ROWS_PER_SHEET} rows of this sheet.</p>`,
      );
    }
  }

  parts.push('</body></html>');
  return parts.join('');
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function wordBufferToHtml(buffer, filename) {
  const ext = extensionOf(filename);
  if (ext === 'docx') {
    let mammoth;
    try {
      const mod = await import('mammoth');
      mammoth = mod.default ?? mod;
    } catch {
      throw new Error('Internal error: mammoth module unavailable');
    }

    const result = await mammoth.convertToHtml({ buffer });
    const bodyHtml = sanitizeDocumentHtml(result.value);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
      filename,
    )}</title><style>${PREVIEW_STYLES}</style></head><body><p class="muted">${escapeHtml(
      filename,
    )}</p>${bodyHtml}</body></html>`;
  }

  let parseOffice;
  try {
    const mod = await import('officeparser');
    parseOffice =
      mod.parseOffice ??
      mod.OfficeParser?.parseOffice ??
      mod.default?.parseOffice ??
      mod.default;
  } catch {
    throw new Error('Internal error: officeparser module unavailable');
  }

  if (typeof parseOffice !== 'function') {
    throw new Error('officeparser did not export parseOffice');
  }

  const ast = await parseOffice(buffer);
  const text =
    typeof ast?.toText === 'function'
      ? ast.toText()
      : String(ast?.content ?? ast ?? '');
  const body = escapeHtml(text).replace(/\n/g, '<br>');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    filename,
  )}</title><style>${PREVIEW_STYLES}</style></head><body><p class="muted">${escapeHtml(
    filename,
  )}</p><div>${body}</div></body></html>`;
}

/**
 * Build HTML preview for a workspace document file.
 *
 * @param {string} absPath
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function renderDocumentPreviewHtml(absPath, buffer) {
  const filename = absPath.split(/[/\\]/).pop() ?? 'document';
  const kind = getDocumentPreviewKind(filename);
  if (kind === 'spreadsheet') {
    return spreadsheetBufferToHtml(buffer, filename);
  }
  if (kind === 'word') {
    return wordBufferToHtml(buffer, filename);
  }
  throw new Error(`No HTML preview available for "${filename}"`);
}

/**
 * True when the relative path can be rendered through the document-html preview route.
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isDocumentHtmlPreviewPath(relativePath) {
  const kind = getDocumentPreviewKind(relativePath);
  return kind === 'spreadsheet' || kind === 'word';
}
