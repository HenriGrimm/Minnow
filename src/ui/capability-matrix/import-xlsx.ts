import * as XLSX from 'xlsx';
import {
  importManualVerdicts,
  loadManualVerdicts,
  manualVerdictKey,
} from '../../benchmark/capabilities/manual-verdicts.ts';
import { parseCapabilityMatrixWorkbook } from '../../benchmark/capabilities/xlsx-workbook.ts';
import type { CapabilityMatrixRosterEntry } from '../../benchmark/capabilities/roster-store.ts';

export interface CapabilityMatrixImportResult {
  importedCount: number;
  warnings: string[];
}

/** Read a File, parse host sheets, PUT import (or local merge). */
export async function importCapabilityMatrixXlsxFile(
  file: File,
  roster: CapabilityMatrixRosterEntry[],
): Promise<CapabilityMatrixImportResult> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const { verdicts, warnings } = parseCapabilityMatrixWorkbook(workbook, { roster });
  if (verdicts.length === 0) {
    return { importedCount: 0, warnings };
  }

  const existing = await loadManualVerdicts();
  const merged = { ...existing };
  for (const row of verdicts) {
    merged[manualVerdictKey(row.targetKey, row.capabilityId)] = row;
  }
  await importManualVerdicts(Object.values(merged));
  return { importedCount: verdicts.length, warnings };
}
