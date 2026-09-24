/**
 * Ordered file-tool benchmark probes against ~/.minnow/benchmark-workspace/.minnow-bench/.
 */

import { BUILT_IN_TOOLS } from '../../tools/definitions';
import type { ToolDefinition } from '../../tools/definitions';
import type { ToolFixture } from './tools-fixtures.ts';

export const BENCHMARK_FIXTURE_DIR = '.minnow-bench';
export const BENCHMARK_FIXTURE_FILE = `${BENCHMARK_FIXTURE_DIR}/fixture.txt`;
export const BENCHMARK_FIXTURE_COPY = `${BENCHMARK_FIXTURE_DIR}/fixture-copy.txt`;
export const BENCHMARK_FIXTURE_MOVED = `${BENCHMARK_FIXTURE_DIR}/fixture-moved.txt`;
export const BENCHMARK_FIXTURE_SUBDIR = `${BENCHMARK_FIXTURE_DIR}/subdir`;
/** PDF written by create_pdf, then read by read_document in the probe chain. */
export const BENCHMARK_FIXTURE_PDF = `${BENCHMARK_FIXTURE_DIR}/fixture.pdf`;

export const BENCHMARK_FIXTURE_INITIAL =
  'MINNOW_BENCH_MARKER\nalpha\nbeta\n';

/** Middle file tools run after create + read, before delete_path. */
const FILE_TOOL_MIDDLE_ORDER = [
  'read_file_range',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'apply_patch',
  'search_in_file',
  'grep',
  'list_directory',
  'get_file_metadata',
  'find_files',
  'make_directory',
  'copy_file',
  'move_file',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
  'read_document',
] as const;

/** Serial probe order: create → verify read → mutate → delete. */
export const FILE_TOOL_PROBE_ORDER: string[] = [
  'save_file',
  'read_file',
  ...FILE_TOOL_MIDDLE_ORDER,
  'delete_path',
];

const FILE_TOOL_IDS = new Set(
  BUILT_IN_TOOLS.filter((t) => t.category === 'files').map((t) => t.id),
);

/** Assert every file-category tool appears exactly once in the probe order. */
export function validateFileToolProbeOrder(): void {
  const ordered = new Set(FILE_TOOL_PROBE_ORDER);
  if (ordered.size !== FILE_TOOL_PROBE_ORDER.length) {
    throw new Error('FILE_TOOL_PROBE_ORDER contains duplicates');
  }
  for (const id of FILE_TOOL_IDS) {
    if (!ordered.has(id)) {
      throw new Error(`FILE_TOOL_PROBE_ORDER missing file tool: ${id}`);
    }
  }
  for (const id of FILE_TOOL_PROBE_ORDER) {
    if (!FILE_TOOL_IDS.has(id)) {
      throw new Error(`FILE_TOOL_PROBE_ORDER includes non-file tool: ${id}`);
    }
  }
}

function baseFixture(prompt: string, extra?: Partial<ToolFixture>): ToolFixture {
  return {
    prompt,
    expectArgs: (a) => typeof a === 'object' && a !== null,
    ...extra,
  };
}

const FILE_FIXTURE_OVERRIDES: Record<string, ToolFixture> = {
  apply_patch: {
    prompt: `Use apply_patch to change the unique line beta to BETA in ${BENCHMARK_FIXTURE_FILE}. Use Begin Patch, Update File, @@, -beta, +BETA, End Patch on separate lines. Call the tool only.`,
    expectArgs: (a) => typeof a.patch === 'string' && a.patch.includes('*** Update File:') && a.patch.includes('fixture.txt'),
    verifyExec: (result) => result.includes('Applied patch:'),
  },
  save_file: {
    prompt: `Use save_file to create ${BENCHMARK_FIXTURE_FILE} with this exact content on separate lines: MINNOW_BENCH_MARKER, alpha, beta. Call the tool only.`,
    expectArgs: (a) =>
      typeof a.path === 'string' &&
      a.path.includes('fixture.txt') &&
      typeof a.content === 'string' &&
      String(a.content).includes('MINNOW_BENCH_MARKER'),
  },
  read_file: {
    prompt: `Use read_file on ${BENCHMARK_FIXTURE_FILE}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string' && a.path.includes('fixture.txt'),
    verifyExec: (result) => result.includes('MINNOW_BENCH_MARKER'),
  },
  read_file_range: {
    prompt: `Use read_file_range on ${BENCHMARK_FIXTURE_FILE} for lines 2 through 3. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string' && typeof a.start_line === 'number',
  },
  append_file: {
    prompt: `Use append_file to add a new line "gamma" to ${BENCHMARK_FIXTURE_FILE}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string' && typeof a.content === 'string',
  },
  insert_at_line: {
    prompt: `Use insert_at_line to insert "inserted" at line 2 in ${BENCHMARK_FIXTURE_FILE}. Call the tool only.`,
    expectArgs: (a) =>
      typeof a.path === 'string' && typeof a.line_number === 'number' && typeof a.content === 'string',
  },
  replace_text_in_file: {
    prompt: `Use replace_text_in_file to replace "alpha" with "ALPHA" in ${BENCHMARK_FIXTURE_FILE}. Call the tool only.`,
    expectArgs: (a) =>
      typeof a.search === 'string' && typeof a.replace === 'string' && typeof a.path === 'string',
  },
  search_in_file: {
    prompt: `Use search_in_file on ${BENCHMARK_FIXTURE_FILE} with pattern MINNOW_BENCH_MARKER. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string' && typeof a.pattern === 'string',
  },
  grep: {
    prompt: `Use grep to search for MINNOW_BENCH_MARKER under ${BENCHMARK_FIXTURE_DIR}. Call the tool only.`,
    expectArgs: (a) => typeof a.pattern === 'string',
  },
  list_directory: {
    prompt: `Use list_directory on ${BENCHMARK_FIXTURE_DIR}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string',
  },
  get_file_metadata: {
    prompt: `Use get_file_metadata on ${BENCHMARK_FIXTURE_FILE}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string',
  },
  find_files: {
    prompt: `Use find_files with pattern "**/fixture.txt" under ${BENCHMARK_FIXTURE_DIR}. Call the tool only.`,
    expectArgs: (a) => typeof a.pattern === 'string',
  },
  make_directory: {
    prompt: `Use make_directory to create ${BENCHMARK_FIXTURE_SUBDIR}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string',
  },
  copy_file: {
    prompt: `Use copy_file to copy ${BENCHMARK_FIXTURE_FILE} to ${BENCHMARK_FIXTURE_COPY}. Call the tool only.`,
    expectArgs: (a) => typeof a.source === 'string' && typeof a.destination === 'string',
  },
  move_file: {
    prompt: `Use move_file to move ${BENCHMARK_FIXTURE_COPY} to ${BENCHMARK_FIXTURE_MOVED}. Call the tool only.`,
    expectArgs: (a) => typeof a.source === 'string' && typeof a.destination === 'string',
  },
  create_pdf: {
    prompt: `Use create_pdf to write ${BENCHMARK_FIXTURE_PDF} with body text containing MINNOW_BENCH_MARKER. Call the tool only.`,
    expectArgs: (a) =>
      typeof a.path === 'string' &&
      a.path.includes('fixture.pdf') &&
      typeof a.body === 'string' &&
      String(a.body).includes('MINNOW_BENCH_MARKER'),
  },
  read_document: {
    prompt: `Use read_document with path ${BENCHMARK_FIXTURE_PDF}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string' && a.path.includes('fixture.pdf'),
    verifyExec: (result) => result.includes('MINNOW_BENCH_MARKER'),
  },
  delete_path: {
    prompt: `Use delete_path to delete ${BENCHMARK_FIXTURE_FILE}. Call the tool only.`,
    expectArgs: (a) => typeof a.path === 'string' && a.path.includes('fixture'),
  },
};

/** Fixture for a file-category tool probe (benchmark workspace paths). */
export function getFileToolFixture(tool: ToolDefinition): ToolFixture {
  const override = FILE_FIXTURE_OVERRIDES[tool.id];
  if (override) return override;
  return baseFixture(
    `Call ${tool.id} on a path under ${BENCHMARK_FIXTURE_DIR}/fixture.txt with minimal valid arguments. Use the tool only.`,
  );
}

/** Lookup built-in file tool definitions in FILE_TOOL_PROBE_ORDER. */
export function getOrderedFileTools(): ToolDefinition[] {
  return FILE_TOOL_PROBE_ORDER.map((id) => BUILT_IN_TOOLS.find((t) => t.id === id)).filter(
    (t): t is ToolDefinition => t != null,
  );
}

validateFileToolProbeOrder();
