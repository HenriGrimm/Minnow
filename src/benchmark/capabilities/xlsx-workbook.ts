/**
 * Capability matrix .xlsx workbook build + parse (SheetJS; pure aside from xlsx import).
 */

import * as XLSX from 'xlsx';
import { CAPABILITY_CATALOG } from './catalog.ts';
import { CAPABILITY_GROUP_COUNTS, CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER } from './groups.ts';
import {
  CAPABILITY_MATRIX_HOUSE_RULES,
  CAPABILITY_MATRIX_TITLE,
  CAPABILITY_SCORE_FORMULA_DESCRIPTION,
  CAPABILITY_TIER_DESCRIPTIONS,
  CAPABILITY_VERDICT_LEGEND,
} from './house-rules.ts';
import {
  CAPABILITY_HOST_BAND_LABELS,
  type CapabilityHostBand,
} from './host-group.ts';
import type { ManualCapabilityVerdict, ManualVerdictStore } from './manual-verdicts.ts';
import { manualVerdictKey } from './manual-verdicts.ts';
import { rosterEntryHostBand } from './roster-store.ts';
import type { CapabilityMatrixRosterEntry } from './roster-store.ts';
import {
  capabilityRowScore,
  capabilityRowTestedCount,
} from './score.ts';
import { capabilityMatrixTestId } from '../test-catalog.ts';
import type { CapabilityVerdict } from './types.ts';
import type { MergedCapabilityCell } from './merge.ts';
import { targetKeyFromTarget, targetLabel } from '../model-key.ts';

export const CAPABILITY_MATRIX_SHEET_NAMES = [
  'Read me',
  'Cloud',
  'LM Studio',
  'Minnow Hosting',
  'Summary',
  'Test guide',
] as const;

export type CapabilityMatrixSheetName = (typeof CAPABILITY_MATRIX_SHEET_NAMES)[number];

const HOST_SHEET_BY_BAND: Record<CapabilityHostBand, CapabilityMatrixSheetName> = {
  cloud: 'Cloud',
  'lm-studio': 'LM Studio',
  'minnow-hosting': 'Minnow Hosting',
};

const HOST_SHEET_BLURB: Record<CapabilityHostBand, string> = {
  cloud:
    'Cloud models - hosted APIs (OpenRouter, OpenAI, Anthropic, Groq, Mistral, DeepSeek, Copilot)',
  'lm-studio': 'LM Studio - models served by the LM Studio local server',
  'minnow-hosting': 'Minnow hosting - models Minnow serves itself (llama.cpp / MLX)',
};

/** First capability column (0-based); columns A–J are model metadata. */
export const CAPABILITY_MATRIX_FIRST_CAPABILITY_COL = 10;

const META_HEADERS = [
  'Model',
  'Producer',
  'Provider / Host',
  'Quantization',
  'Params',
  'Context',
  'Date tested',
  'Verdict',
  'Score',
  'Tested (n)',
] as const;

const TRAILING_HEADERS = ['Blocking issues', 'Notes'] as const;

/** Spreadsheet header text → stable capability id. */
export const CAPABILITY_HEADER_TO_ID: Record<string, string> = Object.fromEntries(
  CAPABILITY_CATALOG.map((cap) => [cap.header, cap.id]),
);

/** Test guide group labels (match source workbook casing). */
export const TEST_GUIDE_GROUP_LABELS: Record<(typeof CAPABILITY_GROUP_ORDER)[number], string> = {
  'core-protocol': 'Core protocol',
  files: 'Files',
  docs: 'Docs',
  git: 'Git',
  'code-shell': 'Code & shell',
  lsp: 'LSP',
  web: 'Web',
  browser: 'Browser',
  'agents-tasks': 'Agents & tasks',
  knowledge: 'Knowledge',
  apps: 'Apps',
  'mode-control': 'Mode control',
  features: 'Features',
};

const VERDICT_EMOJI: Record<CapabilityVerdict, string> = {
  pass: '✅',
  partial: '⚠️',
  fail: '❌',
  'n-a': '➖',
  untested: '',
};

export interface BuildCapabilityMatrixWorkbookInput {
  roster: CapabilityMatrixRosterEntry[];
  /** Merged cells keyed by `targetKey::capabilityId`. */
  cellByKey: Map<string, MergedCapabilityCell>;
  columnScores: Record<string, number | null>;
  /** Optional manual store for row Notes column on export. */
  manualStore?: ManualVerdictStore;
}

export interface ParseCapabilityMatrixWorkbookInput {
  roster: CapabilityMatrixRosterEntry[];
}

export interface ParsedCapabilityMatrixImport {
  verdicts: ManualCapabilityVerdict[];
  /** Non-fatal parse issues (unknown headers, unmatched rows). */
  warnings: string[];
}

function cellMapKey(targetKey: string, capabilityId: string): string {
  return `${targetKey}::${capabilityId}`;
}

function capabilityHeaders(): string[] {
  return CAPABILITY_CATALOG.map((c) => c.header);
}

function buildHeaderRow(): string[] {
  return [...META_HEADERS, ...capabilityHeaders(), ...TRAILING_HEADERS];
}

function buildGroupBandRow(): string[] {
  const row = new Array<string>(buildHeaderRow().length).fill('');
  row[0] = 'MODEL';
  let col = CAPABILITY_MATRIX_FIRST_CAPABILITY_COL;
  for (const groupId of CAPABILITY_GROUP_ORDER) {
    row[col] = CAPABILITY_GROUP_LABELS[groupId];
    col += CAPABILITY_GROUP_COUNTS[groupId];
  }
  const blockingCol = CAPABILITY_MATRIX_FIRST_CAPABILITY_COL + capabilityHeaders().length;
  row[blockingCol] = 'FINDINGS';
  return row;
}

function buildReadMeRows(): (string | number)[][] {
  const rows: (string | number)[][] = [];
  rows.push(['', '', '']);
  rows.push(['', CAPABILITY_MATRIX_TITLE, '']);
  rows.push(['', '', '']);
  rows.push([
    '',
    'What this is',
    'One row per model, one column per capability. Fill cells left to right; export from Minnow Settings preserves roster verdicts.',
  ]);
  rows.push(['', '', '']);
  rows.push(['', 'How to fill it in', '']);
  for (const rule of CAPABILITY_MATRIX_HOUSE_RULES) {
    rows.push(['', '', rule]);
  }
  rows.push(['', '', '']);
  rows.push(['', 'Test tiers', '']);
  rows.push(['', 'Tier 1 - triage (18 cols)', CAPABILITY_TIER_DESCRIPTIONS[1]]);
  rows.push(['', 'Tier 2 - real work', CAPABILITY_TIER_DESCRIPTIONS[2]]);
  rows.push(['', 'Tier 3 - breadth', CAPABILITY_TIER_DESCRIPTIONS[3]]);
  rows.push(['', '', '']);
  rows.push(['', 'Scoring', CAPABILITY_SCORE_FORMULA_DESCRIPTION]);
  rows.push(['', '', '']);
  rows.push(['', 'Verdict legend', '']);
  for (const [key, text] of Object.entries(CAPABILITY_VERDICT_LEGEND)) {
    rows.push(['', key, text]);
  }
  return rows;
}

function formatScorePercent(score: number | null): string {
  if (score == null) return '';
  return `${Math.round(score * 100)}%`;
}

function rowVerdictLabel(verdicts: CapabilityVerdict[], score: number | null): string {
  const tested = capabilityRowTestedCount(verdicts);
  if (tested === 0) return 'Untested';
  if (verdicts.some((v) => v === 'fail') && !verdicts.some((v) => v === 'pass' || v === 'partial')) {
    return 'Unusable';
  }
  if (score != null && score >= 0.99 && !verdicts.includes('partial') && !verdicts.includes('fail')) {
    return 'Works';
  }
  if (verdicts.includes('partial') || (score != null && score < 1)) return 'With caveats';
  return 'Works';
}

function latestTestedDate(cells: MergedCapabilityCell[]): string {
  let latest = '';
  for (const cell of cells) {
    const stamp = cell.autoRanAt;
    if (stamp && stamp > latest) latest = stamp;
  }
  if (!latest) return '';
  return latest.slice(0, 10);
}

function verdictsForTarget(
  targetKey: string,
  cellByKey: Map<string, MergedCapabilityCell>,
): CapabilityVerdict[] {
  return CAPABILITY_CATALOG.map(
    (cap) => cellByKey.get(cellMapKey(targetKey, cap.id))?.verdict ?? 'untested',
  );
}

function rowNotesForTarget(
  targetKey: string,
  manualStore?: ManualVerdictStore,
): string {
  if (!manualStore) return '';
  const notes = new Set<string>();
  for (const cap of CAPABILITY_CATALOG) {
    const note = manualStore[manualVerdictKey(targetKey, cap.id)]?.note?.trim();
    if (note) notes.add(note);
  }
  return [...notes].join(' | ');
}

function buildHostSheetRows(
  host: CapabilityHostBand,
  input: BuildCapabilityMatrixWorkbookInput,
): (string | number)[][] {
  const title = `${CAPABILITY_MATRIX_TITLE} - ${CAPABILITY_HOST_BAND_LABELS[host]}`;
  const row0 = new Array<string>(buildHeaderRow().length).fill('');
  row0[0] = title;
  row0[3] = HOST_SHEET_BLURB[host];

  const rows: (string | number)[][] = [row0, buildGroupBandRow(), buildHeaderRow()];

  const entries = input.roster.filter(
    (e) => e.enabled !== false && rosterEntryHostBand(e) === host,
  );

  for (const entry of entries) {
    const targetKey = targetKeyFromTarget(entry);
    const label = targetLabel(entry);
    const verdicts = verdictsForTarget(targetKey, input.cellByKey);
    const score = input.columnScores[targetKey] ?? capabilityRowScore(verdicts);
    const tested = capabilityRowTestedCount(verdicts);
    const targetCells = CAPABILITY_CATALOG.map((cap) =>
      input.cellByKey.get(cellMapKey(targetKey, cap.id)),
    ).filter((c): c is MergedCapabilityCell => Boolean(c));

    const capabilityCells = verdicts.map((v) => VERDICT_EMOJI[v] ?? '');

    rows.push([
      label,
      '',
      entry.providerId,
      '-',
      '-',
      '-',
      latestTestedDate(targetCells),
      rowVerdictLabel(verdicts, score),
      formatScorePercent(score),
      tested ? String(tested) : '',
      ...capabilityCells,
      '',
      rowNotesForTarget(targetKey, input.manualStore),
    ]);
  }

  return rows;
}

function buildSummaryRows(): (string | number)[][] {
  return [
    ['', '', '', '', '', '', '', ''],
    ['', 'Coverage summary', '', '', '', '', '', ''],
    [
      '',
      'Counts update automatically from the three host sheets when opened in Excel with formulas; Minnow exports static counts on next export.',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
    ['', '', '', '', '', '', '', ''],
    ['', 'Sheet', 'Models', 'Tested', 'Works', 'With caveats', 'Partial', 'Unusable'],
    ['', 'Cloud', '', '', '', '', '', ''],
    ['', 'LM Studio', '', '', '', '', '', ''],
    ['', 'Minnow Hosting', '', '', '', '', '', ''],
    ['', 'Total', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    [
      '',
      "'Tested' counts any model with at least one scored capability cell (pass, partial, or fail).",
      '',
      '',
      '',
      '',
      '',
      '',
    ],
  ];
}

function buildTestGuideRows(): (string | number)[][] {
  const rows: (string | number)[][] = [
    ['', '', '', '', '', ''],
    ['', 'Test guide', '', '', '', ''],
    [
      '',
      'One line per capability column, in sheet order. Scored by + Probe id columns are Minnow-specific (SheetJS export omits header comments).',
      '',
      '',
      '',
      '',
    ],
    ['', '', '', '', '', ''],
    ['Group', 'Column', 'Tier', 'How to test', 'Scored by', 'Probe id'],
  ];

  for (const cap of CAPABILITY_CATALOG) {
    rows.push([
      TEST_GUIDE_GROUP_LABELS[cap.group],
      cap.header,
      cap.tier,
      cap.howToTest,
      cap.scoreMode,
      capabilityMatrixTestId(cap.id),
    ]);
  }

  return rows;
}

function aoaToSheet(rows: (string | number)[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows);
}

/** Build a full capability matrix workbook (no cell comments or Excel validation). */
export function buildCapabilityMatrixWorkbook(
  input: BuildCapabilityMatrixWorkbookInput,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aoaToSheet(buildReadMeRows()), 'Read me');
  XLSX.utils.book_append_sheet(wb, aoaToSheet(buildHostSheetRows('cloud', input)), 'Cloud');
  XLSX.utils.book_append_sheet(wb, aoaToSheet(buildHostSheetRows('lm-studio', input)), 'LM Studio');
  XLSX.utils.book_append_sheet(
    wb,
    aoaToSheet(buildHostSheetRows('minnow-hosting', input)),
    'Minnow Hosting',
  );
  XLSX.utils.book_append_sheet(wb, aoaToSheet(buildSummaryRows()), 'Summary');
  XLSX.utils.book_append_sheet(wb, aoaToSheet(buildTestGuideRows()), 'Test guide');
  return wb;
}

/** Map roster rows to target keys by exported model label (case-insensitive trim). */
export function buildTargetKeyByModelLabel(
  roster: CapabilityMatrixRosterEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of roster) {
    if (entry.enabled === false) continue;
    const key = targetKeyFromTarget(entry);
    const label = targetLabel(entry).trim().toLowerCase();
    if (label) map.set(label, key);
    map.set(`${entry.providerId} / ${entry.modelId}`.trim().toLowerCase(), key);
    map.set(entry.modelId.trim().toLowerCase(), key);
  }
  return map;
}

/** Parse a single spreadsheet cell into a scored verdict (blank → null). */
export function parseSpreadsheetVerdictCell(raw: unknown): CapabilityVerdict | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text === '✅' || /^works$/i.test(text) || /^pass$/i.test(text)) return 'pass';
  if (text === '⚠️' || /^partial$/i.test(text) || /caveat/i.test(text)) return 'partial';
  if (text === '❌' || /^fail$/i.test(text) || /^broken$/i.test(text) || /^unusable$/i.test(text)) {
    return 'fail';
  }
  if (text === '➖' || /^n\/?a$/i.test(text) || /^not applicable/i.test(text)) return 'n-a';
  if (/^untested$/i.test(text) || text === '·') return null;
  return null;
}

function findHeaderRow(sheet: XLSX.WorkSheet): { row: number; headers: string[] } | null {
  const ref = sheet['!ref'];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  for (let r = 0; r <= Math.min(range.e.r, 8); r++) {
    const headers: string[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      headers.push(String(sheet[addr]?.v ?? '').trim());
    }
    if (headers[0] === 'Model' && headers.includes('Tested (n)')) {
      return { row: r, headers };
    }
  }
  return null;
}

function capabilityColumnsFromHeaders(headers: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (let c = 0; c < headers.length; c++) {
    const header = headers[c]?.trim();
    if (!header || header === 'Blocking issues' || header === 'Notes') break;
    if (c < CAPABILITY_MATRIX_FIRST_CAPABILITY_COL) continue;
    const id = CAPABILITY_HEADER_TO_ID[header];
    if (id) map.set(c, id);
  }
  return map;
}

function parseHostSheet(
  sheet: XLSX.WorkSheet,
  sheetName: string,
  targetByLabel: Map<string, string>,
  warnings: string[],
): ManualCapabilityVerdict[] {
  const headerInfo = findHeaderRow(sheet);
  if (!headerInfo) {
    warnings.push(`${sheetName}: could not find header row (Model / Tested (n)).`);
    return [];
  }

  const { row: headerRow, headers } = headerInfo;
  const capCols = capabilityColumnsFromHeaders(headers);
  if (capCols.size === 0) {
    warnings.push(`${sheetName}: no capability columns matched catalog headers.`);
    return [];
  }

  const notesCol = headers.indexOf('Notes');
  const ref = sheet['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const verdicts: ManualCapabilityVerdict[] = [];
  const now = new Date().toISOString();

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const modelAddr = XLSX.utils.encode_cell({ r, c: 0 });
    const modelLabel = String(sheet[modelAddr]?.v ?? '').trim();
    if (!modelLabel || /^example/i.test(modelLabel)) continue;

    const targetKey = targetByLabel.get(modelLabel.toLowerCase());
    if (!targetKey) {
      warnings.push(`${sheetName} row ${r + 1}: no roster match for model "${modelLabel}".`);
      continue;
    }

    let rowNote = '';
    if (notesCol >= 0) {
      const noteAddr = XLSX.utils.encode_cell({ r, c: notesCol });
      rowNote = String(sheet[noteAddr]?.v ?? '').trim();
    }

    for (const [col, capabilityId] of capCols) {
      const addr = XLSX.utils.encode_cell({ r, c: col });
      const verdict = parseSpreadsheetVerdictCell(sheet[addr]?.v);
      if (!verdict) continue;
      verdicts.push({
        targetKey,
        capabilityId,
        verdict,
        note: rowNote || undefined,
        updatedAt: now,
      });
    }
  }

  return verdicts;
}

/** Import manual verdicts from a workbook (host sheets only; headers matched verbatim). */
export function parseCapabilityMatrixWorkbook(
  workbook: XLSX.WorkBook,
  input: ParseCapabilityMatrixWorkbookInput,
): ParsedCapabilityMatrixImport {
  const warnings: string[] = [];
  const targetByLabel = buildTargetKeyByModelLabel(input.roster);
  const verdicts: ManualCapabilityVerdict[] = [];

  for (const sheetName of ['Cloud', 'LM Studio', 'Minnow Hosting'] as const) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      warnings.push(`Missing sheet "${sheetName}" (skipped).`);
      continue;
    }
    verdicts.push(...parseHostSheet(sheet, sheetName, targetByLabel, warnings));
  }

  return { verdicts, warnings };
}

export function hostSheetNameForBand(host: CapabilityHostBand): CapabilityMatrixSheetName {
  return HOST_SHEET_BY_BAND[host];
}
