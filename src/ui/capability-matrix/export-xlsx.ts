import * as XLSX from 'xlsx';
import { buildCapabilityMatrixWorkbook } from '../../benchmark/capabilities/xlsx-workbook.ts';
import type { CapabilityMatrixRosterEntry } from '../../benchmark/capabilities/roster-store.ts';
import type { CapabilityMatrixViewModel } from '../../benchmark/capabilities/view-model.ts';
import type { ManualVerdictStore } from '../../benchmark/capabilities/manual-verdicts.ts';

function defaultExportFilename(): string {
  const day = new Date().toISOString().slice(0, 10);
  return `minnow-capability-matrix-${day}.xlsx`;
}

/** Build workbook bytes and trigger a browser download. */
export function downloadCapabilityMatrixXlsx(
  viewModel: CapabilityMatrixViewModel,
  roster: CapabilityMatrixRosterEntry[],
  manualStore?: ManualVerdictStore,
): void {
  const workbook = buildCapabilityMatrixWorkbook({
    roster,
    cellByKey: viewModel.cellByKey,
    columnScores: viewModel.columnScores,
    manualStore,
  });
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = defaultExportFilename();
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
