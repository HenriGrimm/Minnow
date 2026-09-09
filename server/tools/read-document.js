/**
 * Extract plain text from PDF and common office attachments (MIN-32).
 * Used by read_document tool and the composer attachment pipeline.
 */

import {
  fileExtension as extensionOf,
  isOfficeExtension,
  OFFICE_EXTENSIONS,
} from '../../src/attachments/document-extensions.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from '../runtime/path-access.js';
import { wrapUntrusted } from '../security/untrusted.js';
import { capTextOutput } from './output-cap.js';

export { OFFICE_EXTENSIONS, isOfficeExtension };

/** Max decoded bytes (aligns with MAX_ATTACHMENT_BYTES in reader.ts). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** ZIP local-file header (xlsx, xlsm, ods). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** OLE compound document header (legacy .xls). */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * @param {Buffer} buffer
 * @param {Buffer} magic
 * @returns {boolean}
 */
function bufferStartsWith(buffer, magic) {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

/**
 * Reject corrupt spreadsheet binaries before xlsx parses opaque garbage as text.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 */
function assertSpreadsheetMagic(buffer, filename) {
  const ext = extensionOf(filename);
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'ods') {
    if (!bufferStartsWith(buffer, ZIP_MAGIC)) {
      throw new Error(`file does not look like a valid ${ext} workbook (missing ZIP signature)`);
    }
    return;
  }
  if (ext === 'xls') {
    if (!bufferStartsWith(buffer, OLE_MAGIC)) {
      throw new Error('file does not look like a valid xls workbook (missing OLE signature)');
    }
  }
}

/**
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksLikePdf(filename, buffer) {
  return (
    filename.toLowerCase().endsWith('.pdf') ||
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  );
}

/**
 * @param {string} filename
 * @returns {'pdf' | 'spreadsheet' | 'word' | 'presentation' | 'office' | 'unknown'}
 */
function documentKind(filename) {
  const ext = extensionOf(filename);
  if (ext === 'pdf') return 'pdf';
  if (['xlsx', 'xls', 'xlsm', 'ods', 'csv'].includes(ext)) return 'spreadsheet';
  if (['docx', 'doc', 'odt', 'rtf'].includes(ext)) return 'word';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'presentation';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  return 'unknown';
}

/**
 * @param {string} filename
 * @param {string} body
 * @param {string} [meta]
 * @returns {string}
 */
function formatDocumentResult(filename, body, meta) {
  const trimmed = String(body ?? '').trim();
  const suffix = meta ? ` (${meta})` : '';
  if (!trimmed) {
    return `Document "${filename}" parsed but contained no extractable text${suffix}.`;
  }
  return `--- ${filename}${suffix} ---\n${trimmed}`;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function extractPdf(buffer, filename) {
  let PDFParse;
  try {
    const mod = await import('pdf-parse');
    PDFParse = mod.PDFParse;
    if (typeof PDFParse !== 'function') {
      throw new Error('PDFParse export missing');
    }
  } catch {
    throw new Error('Internal error: pdf-parse module unavailable');
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    const text = String(parsed?.text ?? '').trim();
    const pages = parsed?.total ?? '?';
    return formatDocumentResult(filename, text, `${pages} page(s)`);
  } finally {
    await parser.destroy();
  }
}

/** Rows returned per sheet by read_document when the caller does not say. */
export const DEFAULT_SPREADSHEET_MAX_ROWS = 200;

/**
 * Shrink a sheet's declared range to the rows and columns that actually hold data.
 * Spreadsheets routinely declare hundreds of trailing empty columns, and every one
 * of them costs a comma per row in the CSV rendering.
 *
 * @param {any} XLSX
 * @param {any} sheet
 * @returns {{ s: { r: number, c: number }, e: { r: number, c: number } } | null}
 */
function usedCellRange(XLSX, sheet) {
  const ref = sheet?.['!ref'];
  if (!ref) return null;
  const declared = XLSX.utils.decode_range(ref);
  let firstRow = Infinity;
  let firstCol = Infinity;
  let lastRow = -1;
  let lastCol = -1;

  for (let r = declared.s.r; r <= declared.e.r; r += 1) {
    for (let c = declared.s.c; c <= declared.e.c; c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v === undefined || cell.v === null) continue;
      if (String(cell.v).trim() === '') continue;
      if (r < firstRow) firstRow = r;
      if (c < firstCol) firstCol = c;
      if (r > lastRow) lastRow = r;
      if (c > lastCol) lastCol = c;
    }
  }

  if (lastRow < 0) return null;
  return { s: { r: firstRow, c: firstCol }, e: { r: lastRow, c: lastCol } };
}

/**
 * Resolve which sheets to render. Accepts a sheet name or a 1-based index.
 *
 * @param {string[]} names
 * @param {unknown} requested
 * @returns {string[] | null} null when the request matches no sheet
 */
function resolveSheetSelection(names, requested) {
  if (requested === undefined || requested === null || requested === '') return names;
  const raw = String(requested).trim();
  const byName = names.find((name) => name.toLowerCase() === raw.toLowerCase());
  if (byName) return [byName];
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= names.length) {
    return [names[index - 1]];
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ sheet?: unknown, maxRows?: number, startRow?: number }} [options]
 * @returns {Promise<string>}
 */
async function extractSpreadsheet(buffer, filename, options = {}) {
  let XLSX;
  try {
    const mod = await import('xlsx');
    XLSX = mod.default ?? mod;
  } catch {
    throw new Error('Internal error: xlsx module unavailable');
  }

  assertSpreadsheetMagic(buffer, filename);

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const names = workbook.SheetNames;
  const selection = resolveSheetSelection(names, options.sheet);
  if (!selection) {
    return `Error: no sheet named "${options.sheet}" in "${filename}". Sheets: ${names.join(', ')}`;
  }

  const maxRows =
    Number.isFinite(options.maxRows) && Number(options.maxRows) > 0
      ? Math.floor(Number(options.maxRows))
      : Infinity;
  const startRow =
    Number.isFinite(options.startRow) && Number(options.startRow) > 0
      ? Math.floor(Number(options.startRow)) - 1
      : 0;

  const manifest = [];
  const parts = [];

  for (const sheetName of names) {
    const sheet = workbook.Sheets[sheetName];
    const used = usedCellRange(XLSX, sheet);
    if (!used) {
      manifest.push(`${sheetName}: empty`);
      continue;
    }

    const totalRows = used.e.r - used.s.r + 1;
    const totalCols = used.e.c - used.s.c + 1;
    manifest.push(`${sheetName}: ${totalRows} row(s) x ${totalCols} col(s)`);
    if (!selection.includes(sheetName)) continue;

    const firstRow = Math.min(used.s.r + startRow, used.e.r);
    const lastRow = Math.min(used.e.r, maxRows === Infinity ? used.e.r : firstRow + maxRows - 1);
    // sheet_to_csv ignores `range`; sheet_to_json honours it, so window there and
    // re-serialize through the library so CSV quoting stays its problem.
    const windowed = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
      defval: '',
      range: { s: { r: firstRow, c: used.s.c }, e: { r: lastRow, c: used.e.c } },
    });
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(windowed), {
      blankrows: false,
    });
    const body = String(csv ?? '').trim();
    if (!body) continue;

    const shown = lastRow - firstRow + 1;
    const rowNote =
      shown < totalRows
        ? ` (rows ${firstRow - used.s.r + 1}-${lastRow - used.s.r + 1} of ${totalRows} — pass start_row / max_rows for more)`
        : '';
    parts.push(`## Sheet: ${sheetName}${rowNote}\n${body}`);
  }

  const skipped = names.filter((name) => !selection.includes(name));
  const header = [
    `Sheets — ${manifest.join('; ')}`,
    skipped.length > 0 && selection.length < names.length
      ? `Showing "${selection.join(', ')}" only; pass sheet: "<name>" for another.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const meta = `${names.length} sheet(s)`;
  return formatDocumentResult(filename, `${header}\n\n${parts.join('\n\n')}`, meta);
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function extractDocx(buffer, filename) {
  let mammoth;
  try {
    const mod = await import('mammoth');
    mammoth = mod.default ?? mod;
  } catch {
    throw new Error('Internal error: mammoth module unavailable');
  }

  const result = await mammoth.extractRawText({ buffer });
  const warnings =
    Array.isArray(result.messages) && result.messages.length > 0
      ? `${result.messages.length} conversion note(s)`
      : undefined;
  return formatDocumentResult(filename, result.value, warnings);
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function extractOfficeParser(buffer, filename) {
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
  return formatDocumentResult(filename, String(text ?? ''));
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ sheet?: unknown, maxRows?: number, startRow?: number }} [options]
 * @returns {Promise<string>}
 */
export async function extractDocumentText(buffer, filename, options = {}) {
  const safeName =
    typeof filename === 'string' && filename.trim() ? filename.trim() : 'document';

  if (looksLikePdf(safeName, buffer)) {
    return extractPdf(buffer, safeName);
  }

  const kind = documentKind(safeName);

  if (kind === 'spreadsheet') {
    return extractSpreadsheet(buffer, safeName, options);
  }

  if (kind === 'word' && extensionOf(safeName) === 'docx') {
    return extractDocx(buffer, safeName);
  }

  if (
    kind === 'presentation' ||
    kind === 'office' ||
    (kind === 'word' && extensionOf(safeName) !== 'docx')
  ) {
    return extractOfficeParser(buffer, safeName);
  }

  throw new Error(
    `Unsupported document type for "${safeName}". Supported: PDF, Excel (.xlsx, .xls), Word (.docx), PowerPoint (.pptx), OpenDocument, RTF.`,
  );
}

/**
 * @param {string} relPath
 * @param {string} [filenameOverride]
 * @returns {Promise<{ buffer: Buffer, filename: string } | string>}
 */
async function loadDocumentFromPath(relPath, filenameOverride) {
  try {
    const absPath = resolveSafePath(relPath);
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      return `Error: "${relPath}" is not a file`;
    }
    if (stat.size > MAX_DOCUMENT_BYTES) {
      return `Error: document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`;
    }
    const buffer = await fs.readFile(absPath);
    const filename =
      typeof filenameOverride === 'string' && filenameOverride.trim()
        ? filenameOverride.trim()
        : path.basename(absPath);
    return { buffer, filename };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Error:')) {
      return message;
    }
    return `Error: failed to read "${relPath}": ${message}`;
  }
}

/**
 * @param {string} contentB64
 * @param {string} filename
 * @returns {{ buffer: Buffer, filename: string } | string}
 */
function decodeDocumentContent(contentB64, filename) {
  let buffer;
  try {
    buffer = Buffer.from(contentB64, 'base64');
  } catch {
    return 'Error: content is not valid base64';
  }

  if (buffer.length === 0) {
    return 'Error: empty document';
  }

  if (buffer.length > MAX_DOCUMENT_BYTES) {
    return `Error: document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`;
  }

  return { buffer, filename };
}

/**
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isSupportedDocument(filename, buffer) {
  const ext = extensionOf(filename);
  return looksLikePdf(filename, buffer) || ext === 'pdf' || OFFICE_EXTENSIONS.has(ext);
}

/**
 * Cap extracted document text and wrap it as untrusted source data.
 *
 * @param {string} text
 * @param {string} filename
 * @returns {string}
 */
function capAndWrapDocumentText(text, filename) {
  const { text: capped } = capTextOutput(text, {
    footerHint: 'narrow the document scope or read a smaller section',
  });
  return wrapUntrusted(capped, { source: `document:${path.basename(filename)}` });
}

/**
 * Extract workspace document text without the output cap or untrusted wrap.
 * Used by read_file_range so line numbers apply to sheet/PDF text, not ZIP bytes.
 *
 * @param {string} relPath
 * @param {string} [filenameOverride]
 * @param {{ sheet?: unknown, maxRows?: number, startRow?: number }} [options]
 * @returns {Promise<{ filename: string, text: string } | string>}
 */
export async function extractWorkspaceDocumentText(relPath, filenameOverride, options = {}) {
  const loaded = await loadDocumentFromPath(relPath, filenameOverride);
  if (typeof loaded === 'string') {
    return loaded;
  }

  const { buffer, filename } = loaded;
  if (!isSupportedDocument(filename, buffer)) {
    return (
      `Error: read_document supports PDF and office formats ` +
      `(Excel, Word, PowerPoint, OpenDocument, RTF). Got "${filename}".`
    );
  }

  try {
    const text = await extractDocumentText(buffer, filename, options);
    return { filename, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Error:')) {
      return message;
    }
    return `Error: failed to parse "${filename}": ${message}`;
  }
}

/**
 * Spreadsheet windowing for read_document. `full_result` opts out of the row cap
 * the same way it opts out of the character cap.
 *
 * @param {Record<string, unknown> | undefined} args
 * @returns {{ sheet?: unknown, maxRows?: number, startRow?: number }}
 */
function resolveSpreadsheetOptions(args) {
  const explicitRows = Number(args?.max_rows);
  const maxRows =
    Number.isFinite(explicitRows) && explicitRows > 0
      ? explicitRows
      : args?.full_result === true || args?.full === true
        ? Infinity
        : DEFAULT_SPREADSHEET_MAX_ROWS;
  return {
    sheet: args?.sheet,
    maxRows,
    startRow: Number(args?.start_row),
  };
}

/**
 * read_document tool handler — workspace path or base64 attachment bytes.
 *
 * @param {{ path?: string, filename?: string, content?: string, sheet?: unknown, max_rows?: unknown, start_row?: unknown }} args
 * @returns {Promise<string>}
 */
export async function toolReadDocument(args) {
  const relPath = typeof args?.path === 'string' ? args.path.trim() : '';
  const contentB64 = typeof args?.content === 'string' ? args.content : '';
  const filenameArg =
    typeof args?.filename === 'string' && args.filename.trim() ? args.filename.trim() : '';

  if (!relPath && !contentB64) {
    return 'Error: path (workspace-relative) or content (base64 file bytes) is required';
  }

  const sheetOptions = resolveSpreadsheetOptions(args);

  if (relPath) {
    const extracted = await extractWorkspaceDocumentText(
      relPath,
      filenameArg || undefined,
      sheetOptions,
    );
    if (typeof extracted === 'string') {
      return extracted;
    }
    return capAndWrapDocumentText(extracted.text, extracted.filename);
  }

  const filename = filenameArg || 'document.bin';
  const loaded = decodeDocumentContent(contentB64, filename);
  if (typeof loaded === 'string') {
    return loaded;
  }

  if (!isSupportedDocument(loaded.filename, loaded.buffer)) {
    return (
      `Error: read_document supports PDF and office formats ` +
      `(Excel, Word, PowerPoint, OpenDocument, RTF). Got "${loaded.filename}".`
    );
  }

  try {
    const text = await extractDocumentText(loaded.buffer, loaded.filename, sheetOptions);
    return capAndWrapDocumentText(text, loaded.filename);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Error:')) {
      return message;
    }
    return `Error: failed to parse "${loaded.filename}": ${message}`;
  }
}
