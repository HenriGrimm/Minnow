import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { withSessionToken } from '../api/session-token.ts';
import type { CodeChangeDiffLine, CodeChangeStats, ToolImageAttachment } from '../types';
import { BUILT_IN_TOOLS } from '../tools/definitions';
import { renderUnifiedPromptDiff } from './prompt-diff-unified';
import { formatAskQuestionResultAsListItems } from './format-ask-question-result';
import { createIcon } from './icon';
import {
  isImpeccableDetectFindingsResult,
  stripImpeccableDetectExitBanner,
} from '../lib/impeccable-detect-result';
import {
  buildFriendlyToolBody,
  buildToolArgFields,
  buildToolRow,
  describeToolFailure,
  getToolIcon,
  type FriendlyToolBody,
  type ToolRow,
} from './tool-call-presentation';

/** Human-readable labels for built-in tools (fallback: snake_case → spaces). */
const TOOL_LABEL_MAP = new Map(BUILT_IN_TOOLS.map((t) => [t.id, t.label]));

/** Retired tool ids still shown in older transcripts — map to current Issues labels. */
const LEGACY_TOOL_LABELS: Record<string, string> = {
  bug_add: 'Issue add',
  bug_update: 'Issue update',
  bug_get_state: 'Issue get state',
};

/** File write/edit tools that render as open diff cards instead of collapsible rows. */
const FILE_MUTATION_TOOLS = new Set([
  'save_file',
  'replace_text_in_file',
  'append_file',
  'insert_at_line',
  'move_file',
  'delete_path',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
]);

/** Shell tools that expose a user-facing Stop control while a run is active. */
const KILLABLE_SHELL_TOOLS = new Set(['execute_command', 'start_background_command']);

export function isKillableShellTool(name: string): boolean {
  return KILLABLE_SHELL_TOOLS.has(name);
}

/** Parse runId from a successful background shell tool JSON result. */
export function extractShellRunIdFromToolResult(
  toolName: string,
  result: string,
): string | null {
  const payload = parseBackgroundShellToolPayload(toolName, result);
  return payload?.runId ?? null;
}

export interface BackgroundShellToolPayload {
  runId: string;
  output?: string;
  startedAt?: number;
}

/** Parse runId and optional startup fields from background shell tool JSON. */
export function parseBackgroundShellToolPayload(
  toolName: string,
  result: string,
): BackgroundShellToolPayload | null {
  if (!isKillableShellTool(toolName) || isToolResultFailure(result)) return null;
  try {
    const parsed = JSON.parse(result) as {
      runId?: unknown;
      background?: unknown;
      ok?: unknown;
      output?: unknown;
      startedAt?: unknown;
    };
    if (parsed.ok !== true) return null;
    if (toolName === 'execute_command' && parsed.background !== true) return null;
    const runId =
      typeof parsed.runId === 'string' && parsed.runId.trim()
        ? parsed.runId.trim()
        : null;
    if (!runId) return null;
    return {
      runId,
      ...(typeof parsed.output === 'string' && parsed.output.length
        ? { output: parsed.output }
        : {}),
      ...(typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)
        ? { startedAt: parsed.startedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

function appendKillButton(summary: HTMLElement, wrap: HTMLElement): void {
  const killBtn = document.createElement('button');
  killBtn.type = 'button';
  killBtn.className = 'tool-call-kill hidden';
  killBtn.textContent = 'Stop';
  killBtn.setAttribute('aria-label', 'Stop shell command');
  killBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  summary.appendChild(killBtn);
  wrap.dataset.shellKillable = 'true';
}

/** Show or hide the Stop button for a tool-call row. */
export function setToolCallShellRun(
  wrap: HTMLElement,
  runId: string | null,
  running: boolean,
): void {
  if (!wrap.dataset.shellKillable) return;

  if (runId && running) {
    wrap.dataset.shellRunId = runId;
  } else {
    delete wrap.dataset.shellRunId;
  }

  const killBtn = wrap.querySelector<HTMLButtonElement>('.tool-call-kill');
  if (!killBtn) return;
  killBtn.classList.toggle('hidden', !(runId && running));
  killBtn.toggleAttribute('disabled', !(runId && running));
}

/** Sync kill buttons: hide Stop when the run is no longer active. */
export function syncToolCallKillButtons(activeRunIds: Set<string>): void {
  for (const wrap of document.querySelectorAll<HTMLElement>(
    '.tool-call-msg[data-shell-killable="true"]',
  )) {
    const runId = wrap.dataset.shellRunId?.trim();
    const show = Boolean(runId && activeRunIds.has(runId));
    setToolCallShellRun(wrap, runId ?? null, show);
  }
}

export function humanizeToolName(name: string): string {
  return LEGACY_TOOL_LABELS[name] ?? TOOL_LABEL_MAP.get(name) ?? name.replace(/_/g, ' ');
}

/** Last path segment for file-card link titles. */
function pathBasename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

/** Open a workspace-relative path in the Code editor. */
function bindOpenFileLink(el: HTMLElement, workspacePath: string): void {
  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void import('./file-viewer').then((m) => m.openFileInViewer(workspacePath));
  });
}

/** Resolve workspace path for a file-mutation tool row. */
function resolveFileCardPath(
  wrap: HTMLElement,
  codeChange?: CodeChangeStats,
  toolArgs?: Record<string, unknown> | unknown,
): string | undefined {
  if (codeChange?.path) return codeChange.path;
  const args = toolArgs ?? tryParseArgsFromToolWrap(wrap);
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const path = (args as Record<string, unknown>).path;
    return typeof path === 'string' ? path : undefined;
  }
  return undefined;
}

/** Max characters shown in raw output blocks. */
const RESULT_DISPLAY_CAP = 2048;

/** Treat executor error strings as failed tool runs. */
export function isToolResultFailure(result: string): boolean {
  // Detect exit 2 means "anti-patterns found", not a crashed tool.
  if (isImpeccableDetectFindingsResult(result)) return false;
  return result.trimStart().startsWith('Error:');
}

function argsRecordFromUnknown(
  argsObj: Record<string, unknown> | unknown,
): Record<string, unknown> {
  if (argsObj && typeof argsObj === 'object' && !Array.isArray(argsObj)) {
    return argsObj as Record<string, unknown>;
  }
  return {};
}

/** Accessible one-line description of the collapsed row. */
function rowAriaLabel(row: ToolRow, status: 'running' | 'failed' | 'succeeded'): string {
  const parts = [row.action];
  if (row.target) parts.push(row.target);
  if (row.outcome) parts.push(row.outcome);
  parts.push(status === 'running' ? 'running' : status);
  return `${parts.join(', ')}, show details`;
}

function paintTarget(el: HTMLElement, row: ToolRow): void {
  el.textContent = '';
  el.classList.remove('tool-call-target--path', 'tool-call-target--code');

  if (!row.target) {
    el.classList.add('hidden');
    el.removeAttribute('title');
    return;
  }

  el.classList.remove('hidden');
  el.title = row.target;

  if (row.targetKind === 'code') {
    el.classList.add('tool-call-target--code');
    el.textContent = row.target;
    return;
  }

  if (row.targetKind === 'path' && row.target.includes('/')) {
    el.classList.add('tool-call-target--path');
    const idx = row.target.lastIndexOf('/');
    const dir = document.createElement('span');
    dir.className = 'tool-call-target__dir';
    dir.textContent = row.target.slice(0, idx + 1);
    const base = document.createElement('span');
    base.className = 'tool-call-target__base';
    base.textContent = row.target.slice(idx + 1);
    el.appendChild(dir);
    el.appendChild(base);
    return;
  }

  if (row.targetKind === 'path') el.classList.add('tool-call-target--path');
  el.textContent = row.target;
}

/** Write the row zones (action / target / outcome) onto an existing summary. */
function paintRow(
  wrap: HTMLElement,
  row: ToolRow,
  status: 'running' | 'failed' | 'succeeded',
): void {
  const summary = wrap.querySelector<HTMLElement>('.tool-call-summary');
  const action = wrap.querySelector<HTMLElement>('.tool-call-action');
  const target = wrap.querySelector<HTMLElement>('.tool-call-target');
  const outcome = wrap.querySelector<HTMLElement>('.tool-call-outcome');

  if (action && !action.dataset.locked) action.textContent = row.action;
  if (target && !target.dataset.locked) paintTarget(target, row);

  if (outcome) {
    outcome.textContent = row.outcome ?? '';
    outcome.classList.toggle('hidden', !row.outcome);
    outcome.classList.toggle('tool-call-outcome--danger', row.outcomeTone === 'danger');
  }

  summary?.setAttribute('aria-label', rowAriaLabel(row, status));
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tool-call-section-label';
  el.textContent = text;
  return el;
}

function monoBlock(text: string, extraClass?: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = extraClass ? `tool-call-pre ${extraClass}` : 'tool-call-pre';
  pre.textContent = text;
  return pre;
}

function truncationNote(count: number, noun: string): HTMLElement {
  const note = document.createElement('p');
  note.className = 'tool-call-more';
  note.textContent = `+${count} more ${noun}${count === 1 ? '' : 's'}`;
  return note;
}

function mountFriendlyBodyElement(body: FriendlyToolBody): HTMLElement {
  const root = document.createElement('div');
  root.className = 'tool-call-friendly';

  if (body.kind === 'shell') {
    if (body.output) {
      root.appendChild(monoBlock(body.output, 'tool-call-pre--output'));
    } else {
      const empty = document.createElement('p');
      empty.className = 'tool-call-friendly__empty';
      empty.textContent = 'No output.';
      root.appendChild(empty);
    }
    return root;
  }

  if (body.kind === 'listing') {
    if (!body.dirs.length && !body.files.length) {
      const empty = document.createElement('p');
      empty.className = 'tool-call-friendly__empty';
      empty.textContent = 'This folder is empty.';
      root.appendChild(empty);
      return root;
    }
    const list = document.createElement('ul');
    list.className = 'tool-call-entries';
    for (const name of body.dirs) {
      const li = document.createElement('li');
      li.className = 'tool-call-entry tool-call-entry--dir';
      li.appendChild(createIcon('folder', { className: 'tool-call-entry__icon', size: 13 }));
      const label = document.createElement('span');
      label.className = 'tool-call-entry__name';
      label.textContent = name;
      li.appendChild(label);
      list.appendChild(li);
    }
    for (const name of body.files) {
      const li = document.createElement('li');
      li.className = 'tool-call-entry tool-call-entry--file';
      li.appendChild(createIcon('fileText', { className: 'tool-call-entry__icon', size: 13 }));
      const label = document.createElement('span');
      label.className = 'tool-call-entry__name';
      label.textContent = name;
      li.appendChild(label);
      list.appendChild(li);
    }
    root.appendChild(list);
    return root;
  }

  if (body.kind === 'paths') {
    const list = document.createElement('ul');
    list.className = 'tool-call-entries';
    for (const path of body.paths) {
      const li = document.createElement('li');
      li.className = 'tool-call-entry tool-call-entry--file';
      li.appendChild(createIcon('fileText', { className: 'tool-call-entry__icon', size: 13 }));
      const label = document.createElement('span');
      label.className = 'tool-call-entry__name';
      label.textContent = path;
      li.appendChild(label);
      list.appendChild(li);
    }
    root.appendChild(list);
    if (body.truncated) root.appendChild(truncationNote(body.truncated, 'file'));
    return root;
  }

  if (body.kind === 'matches') {
    for (const group of body.groups) {
      const block = document.createElement('div');
      block.className = 'tool-call-match';
      const head = document.createElement('div');
      head.className = 'tool-call-match__path';
      head.textContent = group.path;
      block.appendChild(head);
      const pre = document.createElement('pre');
      pre.className = 'tool-call-pre tool-call-pre--output tool-call-match__lines';
      pre.textContent = group.lines.join('\n');
      block.appendChild(pre);
      root.appendChild(block);
    }
    if (body.truncated) root.appendChild(truncationNote(body.truncated, 'file'));
    return root;
  }

  if (body.kind === 'commits') {
    const list = document.createElement('ol');
    list.className = 'tool-call-entries tool-call-commits';
    for (const row of body.commits) {
      const li = document.createElement('li');
      li.className = 'tool-call-entry';
      const sha = document.createElement('span');
      sha.className = 'tool-call-commit__sha';
      sha.textContent = row.sha.slice(0, 7);
      const subject = document.createElement('span');
      subject.className = 'tool-call-entry__name';
      subject.textContent = expandGitmojiShortcodes(row.subject);
      li.appendChild(sha);
      li.appendChild(subject);
      list.appendChild(li);
    }
    root.appendChild(list);
    return root;
  }

  if (body.kind === 'git-status') {
    if (body.entries.length === 0) {
      const clean = document.createElement('p');
      clean.className = 'tool-call-friendly__empty';
      clean.textContent = 'Working tree clean.';
      root.appendChild(clean);
      return root;
    }
    const list = document.createElement('ul');
    list.className = 'tool-call-entries';
    for (const entry of body.entries) {
      const li = document.createElement('li');
      li.className = 'tool-call-entry';
      const code = document.createElement('span');
      code.className = 'tool-call-status-code';
      code.textContent = entry.code;
      const path = document.createElement('span');
      path.className = 'tool-call-entry__name';
      path.textContent = entry.path;
      li.appendChild(code);
      li.appendChild(path);
      list.appendChild(li);
    }
    root.appendChild(list);
    return root;
  }

  if (body.kind === 'questions') {
    const list = document.createElement('ol');
    list.className = 'tool-call-questions';
    for (const item of body.items) {
      const li = document.createElement('li');
      const prompt = document.createElement('p');
      prompt.className = 'tool-call-question__prompt';
      prompt.textContent = item.prompt;
      li.appendChild(prompt);
      if (item.options.length || item.other) {
        const opts = document.createElement('ul');
        opts.className = 'tool-call-question__options';
        for (const option of item.options) {
          const opt = document.createElement('li');
          opt.className = option.selected
            ? 'tool-call-question__option tool-call-question__option--picked'
            : 'tool-call-question__option';
          opt.textContent = option.label;
          if (option.selected) opt.setAttribute('aria-label', `${option.label} (chosen)`);
          opts.appendChild(opt);
        }
        if (item.other) {
          const opt = document.createElement('li');
          opt.className = 'tool-call-question__option tool-call-question__option--picked';
          opt.textContent = item.other;
          opts.appendChild(opt);
        }
        li.appendChild(opts);
      }
      list.appendChild(li);
    }
    root.appendChild(list);
    if (body.cancelled) {
      const note = document.createElement('p');
      note.className = 'tool-call-friendly__empty';
      note.textContent = 'Cancelled without answering.';
      root.appendChild(note);
    }
    return root;
  }

  root.appendChild(monoBlock(body.lines.join('\n'), 'tool-call-pre--output'));
  if (body.truncated) root.appendChild(truncationNote(body.truncated, 'line'));
  return root;
}

/** Readable key/value view of the arguments a tool was called with. */
function mountArgFields(
  toolName: string,
  args: Record<string, unknown>,
): HTMLElement | null {
  const fields = buildToolArgFields(toolName, args);
  if (!fields.length) return null;

  const list = document.createElement('dl');
  list.className = 'tool-call-fields';
  for (const field of fields) {
    const dt = document.createElement('dt');
    dt.className = field.block
      ? 'tool-call-fields__key tool-call-fields__key--block'
      : 'tool-call-fields__key';
    dt.textContent = field.label;
    const dd = document.createElement('dd');
    dd.className = field.block
      ? 'tool-call-fields__value tool-call-fields__value--block'
      : 'tool-call-fields__value';
    if (field.block) {
      dd.appendChild(monoBlock(field.value, 'tool-call-pre--args'));
    } else {
      dd.textContent = field.value;
    }
    list.appendChild(dt);
    list.appendChild(dd);
  }
  return list;
}

/** Single disclosure holding the verbatim input and output. */
function appendRawDisclosure(
  body: HTMLElement,
  argsObj: unknown,
  result?: string,
): void {
  const hasArgs = argsObj != null && Object.keys(argsRecordFromUnknown(argsObj)).length > 0;
  if (!hasArgs && !result) return;

  const details = document.createElement('details');
  details.className = 'tool-call-raw-details';
  const summary = document.createElement('summary');
  summary.className = 'tool-call-raw-details__summary';
  summary.textContent = hasArgs && result ? 'Raw input and output' : hasArgs ? 'Raw input' : 'Raw output';
  details.appendChild(summary);

  if (hasArgs) {
    if (result) details.appendChild(sectionLabel('Input'));
    details.appendChild(monoBlock(formatForPre(argsObj), 'tool-call-pre--args'));
  }
  if (result) {
    if (hasArgs) details.appendChild(sectionLabel('Output'));
    details.appendChild(monoBlock(capDisplayText(result), 'tool-call-pre--result'));
  }
  body.appendChild(details);
}

/** GitHub-style +/− badge, shown in the outcome zone of file-mutation rows. */
function appendCodeChangeBadge(summary: Element, codeChange?: CodeChangeStats): void {
  summary.querySelector('.tool-call-code-change')?.remove();
  if (!codeChange || (codeChange.additions === 0 && codeChange.deletions === 0)) return;

  const badge = document.createElement('span');
  badge.className = 'tool-call-code-change';
  badge.setAttribute('aria-label', `Lines changed: plus ${codeChange.additions}, minus ${codeChange.deletions}`);

  if (codeChange.additions > 0) {
    const add = document.createElement('span');
    add.className = 'tool-call-code-change__add';
    add.textContent = `+${codeChange.additions}`;
    badge.appendChild(add);
  }
  if (codeChange.deletions > 0) {
    const del = document.createElement('span');
    del.className = 'tool-call-code-change__del';
    del.textContent = `−${codeChange.deletions}`;
    badge.appendChild(del);
  }

  const outcome = summary.querySelector('.tool-call-outcome');
  if (outcome) {
    outcome.textContent = '';
    outcome.classList.remove('hidden');
    outcome.appendChild(badge);
  } else {
    summary.appendChild(badge);
  }
}

/** Mount changed-line diff (with line numbers) in the file tool card body. */
function appendCodeChangeDiffPanel(
  body: Element,
  codeChange?: CodeChangeStats,
  workspacePath?: string,
): void {
  body.querySelector('.tool-call-diff')?.remove();
  if (!codeChange) return;
  const lines = codeChange.diffLines;
  if (!lines?.length) return;

  const panel = document.createElement('div');
  panel.className = 'tool-call-diff';

  const pathLabel =
    codeChange.path ??
    workspacePath ??
    (codeChange.paths?.length ? codeChange.paths.join(', ') : 'Changes');
  const sourceHint =
    codeChange.source === 'backfill'
      ? ' (approximate from history)'
      : codeChange.source === 'command-heuristic'
        ? ' (estimated)'
        : '';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'tool-call-diff__header tool-call-diff__header--link';
  header.textContent = `${pathLabel}${sourceHint}`;
  header.title = pathLabel;
  header.setAttribute('aria-label', `Open ${pathLabel}`);
  if (workspacePath ?? codeChange.path) {
    bindOpenFileLink(header, workspacePath ?? codeChange.path!);
  }
  panel.appendChild(header);

  const host = document.createElement('div');
  renderUnifiedPromptDiff(host, lines as CodeChangeDiffLine[], {
    changedOnly: true,
    lineNumbers: true,
  });
  panel.appendChild(host);

  if (codeChange.diffTruncated) {
    const note = document.createElement('p');
    note.className = 'settings-field-hint prompt-diff__truncated';
    note.textContent = 'Diff truncated for display.';
    panel.appendChild(note);
  }

  body.appendChild(panel);
}

/** Truncate long tool output for the UI while keeping the full string in history. */
function capDisplayText(text: string): string {
  if (text.length <= RESULT_DISPLAY_CAP) return text;
  const omitted = text.length - RESULT_DISPLAY_CAP;
  return `${text.slice(0, RESULT_DISPLAY_CAP)}\n\n… (${omitted} more characters)`;
}

/** Pretty-print args or results inside monospace <pre> blocks. */
function formatForPre(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Pending tool invocation row: collapsed summary with spinner, expandable body. */
export function renderToolCall(
  name: string,
  argsObj: Record<string, unknown> | unknown
): HTMLElement {
  const empty = document.getElementById('emptyState');
  if (empty) empty.remove();

  const wrap = document.createElement('div');
  wrap.className = 'tool-call-msg';
  wrap.dataset.toolName = name;
  wrap.setAttribute('aria-busy', 'true');
  rememberToolArgs(wrap, argsObj);

  const details = document.createElement('details');
  details.className = 'tool-call-details';

  const summary = document.createElement('summary');
  summary.className = 'tool-call-summary tool-call-summary--running';

  const argsRecord = argsRecordFromUnknown(argsObj);
  const pathArg = typeof argsRecord.path === 'string' ? argsRecord.path : undefined;
  const isFileCard = FILE_MUTATION_TOOLS.has(name) && pathArg !== undefined;

  const statusGlyph = document.createElement('span');
  statusGlyph.className = 'tool-call-status';
  const spinner = document.createElement('span');
  spinner.className = 'tool-call-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  statusGlyph.appendChild(spinner);

  const action = document.createElement('span');
  action.className = 'tool-call-action';

  const target = document.createElement(isFileCard ? 'button' : 'span');
  target.className = 'tool-call-target';
  if (isFileCard) target.setAttribute('type', 'button');

  const outcome = document.createElement('span');
  outcome.className = 'tool-call-outcome hidden';

  const chevron = createIcon('chevronDown', {
    className: 'tool-call-chevron',
    size: 14,
  });

  summary.appendChild(statusGlyph);
  summary.appendChild(action);
  summary.appendChild(target);
  summary.appendChild(outcome);
  summary.appendChild(chevron);

  details.appendChild(summary);
  wrap.appendChild(details);
  paintRow(wrap, buildToolRow(name, argsRecord, 'running'), 'running');

  if (isFileCard) {
    wrap.classList.add('tool-call-msg--file');
    details.classList.add('tool-call-details--file');
    details.open = true;
    wrap.dataset.filePath = pathArg;
    applyFileCardTarget(wrap, pathArg);
  }

  if (KILLABLE_SHELL_TOOLS.has(name)) {
    appendKillButton(summary, wrap);
  }

  const body = document.createElement('div');
  body.className = 'tool-call-body';
  const fields = mountArgFields(name, argsRecord);
  if (fields) body.appendChild(fields);

  details.appendChild(body);

  return wrap;
}

/** Turn the target zone of a file-mutation row into a link that opens the file. */
function applyFileCardTarget(wrap: HTMLElement, filePath: string): void {
  const target = wrap.querySelector<HTMLElement>('.tool-call-target');
  if (!target) return;
  target.textContent = '';
  target.classList.remove('tool-call-target--path', 'tool-call-target--code', 'hidden');
  target.classList.add('tool-call-target--file-link');
  target.dataset.locked = 'true';
  target.textContent = pathBasename(filePath);
  target.title = filePath;
  target.setAttribute('aria-label', `Open ${filePath}`);
  if (!target.dataset.linkBound) {
    bindOpenFileLink(target, filePath);
    target.dataset.linkBound = 'true';
  }
}

/** Largest argument blob worth keeping on the DOM node for later re-rendering. */
const ARGS_STASH_CAP = 20_000;

/** Keep the invocation args on the row. */
function rememberToolArgs(wrap: HTMLElement, argsObj: unknown): void {
  if (argsObj == null) return;
  try {
    const json = JSON.stringify(argsObj);
    if (json && json.length <= ARGS_STASH_CAP) wrap.dataset.toolArgs = json;
  } catch {
  }
}

function tryParseArgsFromToolWrap(wrap: HTMLElement): unknown {
  const stashed = wrap.dataset.toolArgs;
  if (stashed) {
    try {
      return JSON.parse(stashed) as unknown;
    } catch {
    }
  }
  const pre = wrap.querySelector('.tool-call-pre--args');
  if (!pre?.textContent) return undefined;
  try {
    return JSON.parse(pre.textContent) as unknown;
  } catch {
    return undefined;
  }
}

/** Mark a tool-call row complete: swap the spinner for the tool glyph, fill the outcome zone, and build the expanded body. */
export function renderToolResult(
  wrap: HTMLElement,
  result: string,
  attachments?: ToolImageAttachment[],
  toolArgs?: Record<string, unknown> | unknown,
  codeChange?: CodeChangeStats,
): void {
  const details = wrap.querySelector('.tool-call-details');
  const summary = wrap.querySelector('.tool-call-summary');
  const statusGlyph = wrap.querySelector('.tool-call-status');
  const body = wrap.querySelector('.tool-call-body') as HTMLElement | null;
  if (!details || !summary || !statusGlyph || !body) return;

  const toolName = wrap.dataset.toolName || 'tool';
  const failed = isToolResultFailure(result);
  // Detect exit 2 still used to ship an Error: banner; drop it for display.
  const displayResult = isImpeccableDetectFindingsResult(result)
    ? stripImpeccableDetectExitBanner(result)
    : result;
  const argsForPresentation = toolArgs ?? tryParseArgsFromToolWrap(wrap);
  const argsRecord = argsRecordFromUnknown(argsForPresentation);

  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  wrap.removeAttribute('aria-busy');
  wrap.classList.toggle('tool-call-msg--fail', failed);
  wrap.classList.toggle('tool-call-msg--ok', !failed);
  summary.classList.toggle('tool-call-summary--fail', failed);
  summary.classList.toggle('tool-call-summary--ok', !failed);
  summary.classList.remove('tool-call-summary--running');

  statusGlyph.innerHTML = '';
  statusGlyph.classList.toggle('tool-call-status--fail', failed);
  statusGlyph.appendChild(
    createIcon(getToolIcon(toolName), { className: 'tool-call-icon', size: 15 }),
  );

  const isFileCard = wrap.classList.contains('tool-call-msg--file');
  const displayPath = isFileCard ? resolveFileCardPath(wrap, codeChange, toolArgs) : undefined;
  if (isFileCard && displayPath) {
    wrap.dataset.filePath = displayPath;
    applyFileCardTarget(wrap, displayPath);
  }

  paintRow(
    wrap,
    buildToolRow(toolName, argsRecord, failed ? 'failed' : 'done', displayResult),
    failed ? 'failed' : 'succeeded',
  );

  if (!failed) {
    appendCodeChangeBadge(summary, codeChange);
  } else {
    summary.querySelector('.tool-call-code-change')?.remove();
  }

  appendSandboxBadge(summary, result);

  if (body.dataset.resultRendered === 'true') return;
  body.dataset.resultRendered = 'true';

  if (failed) {
    const notice = document.createElement('p');
    notice.className = 'tool-call-error';
    notice.textContent = describeToolFailure(result).sentence;
    body.prepend(notice);
    appendRawDisclosure(body, argsForPresentation, result);
    return;
  }

  if (isFileCard) {
    appendCodeChangeDiffPanel(body, codeChange, displayPath);
    appendRawDisclosure(body, argsForPresentation, result);
    return;
  }

  const friendlyBody = buildFriendlyToolBody(toolName, argsRecord, displayResult, failed);
  if (friendlyBody) {
    body.appendChild(mountFriendlyBodyElement(friendlyBody));
  }

  const answerList =
    toolName === 'ask_question' && !friendlyBody
      ? buildAnswerList(result, argsForPresentation)
      : null;
  if (answerList) {
    body.appendChild(sectionLabel('Answers'));
    body.appendChild(answerList);
  }

  const rawShownInline = !friendlyBody && !answerList;
  if (rawShownInline) {
    body.appendChild(monoBlock(capDisplayText(displayResult), 'tool-call-pre--result'));
  }

  appendCodeChangeDiffPanel(body, codeChange, codeChange?.path);

  if (attachments?.length) {
    for (const att of attachments) {
      if (att.type !== 'image' || !att.url) continue;
      const authenticatedUrl = withSessionToken(att.url);
      const link = document.createElement('a');
      link.className = 'tool-call-screenshot-link';
      link.href = authenticatedUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Open screenshot in a new tab';
      const img = document.createElement('img');
      img.className = 'tool-call-screenshot';
      img.loading = 'lazy';
      img.alt = att.alt ?? 'Browser screenshot';
      img.src = authenticatedUrl;
      link.appendChild(img);
      body.appendChild(link);
    }
  }

  if (!rawShownInline) appendRawDisclosure(body, argsForPresentation, displayResult);
}

/** Sandbox trailer badge on agent shell tool rows (MIN-553). */
function appendSandboxBadge(summary: Element, result: string): void {
  summary.querySelector('.tool-call-sandbox-badge')?.remove();
  const sandboxed = result.match(/\[sandboxed:\s*([^\]]+)\]/i);
  const notSandboxed = result.match(/\[NOT sandboxed:\s*([^\]]+)\]/i);
  if (!sandboxed && !notSandboxed) return;

  const badge = document.createElement('span');
  badge.className = sandboxed
    ? 'tool-call-sandbox-badge tool-call-sandbox-badge--ok'
    : 'tool-call-sandbox-badge tool-call-sandbox-badge--warn';
  badge.textContent = sandboxed
    ? `Sandboxed · ${sandboxed[1]!.trim()}`
    : 'Not sandboxed';
  badge.title = sandboxed
    ? `Sandboxed: ${sandboxed[1]!.trim()}`
    : `Not sandboxed: ${notSandboxed?.[1]?.trim() ?? ''}`;
  const outcome = summary.querySelector('.tool-call-outcome');
  if (outcome) {
    outcome.classList.remove('hidden');
    outcome.appendChild(badge);
  } else {
    summary.appendChild(badge);
  }
}

/** Numbered answers for ask_question; the source lines already carry "N." prefixes. */
function buildAnswerList(result: string, toolArgs: unknown): HTMLElement | null {
  const items = formatAskQuestionResultAsListItems(result, toolArgs);
  if (!items.length) return null;
  const list = document.createElement('ol');
  list.className = 'tool-call-answer-list';
  for (const line of items) {
    const li = document.createElement('li');
    li.textContent = line.replace(/^\d+\.\s*/, '');
    list.appendChild(li);
  }
  return list;
}
