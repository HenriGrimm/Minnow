import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import '../tools/output-cap-als.js';
import { COMMAND_TIMEOUT_MS, formatProcessOutput, runProcess } from '../process-runner.js';
import {
  MAX_READ_FILE_BYTES,
  capReadFileOutput,
  capTextOutput,
  getOutputCapPolicy,
  resolveOutputCapPolicy,
  resolveOutputSliceFromArgs,
  runWithOutputCapPolicy,
  sliceStreamLines,
} from '../tools/output-cap.js';
import { truncateGitDiff } from '../tools/git-diff-truncate.js';
import {
  createBackgroundRun,
  executeCommandBlocking,
  listKnownActiveRuns,
  readCommandLogSnapshot,
  stopActiveRunsForChat,
  waitForRunOutput,
} from '../terminal-runner.js';
import { toolRunImpeccable } from '../impeccable/run-impeccable.js';
import { toolLoadImpeccableContext } from '../impeccable/load-impeccable-context.js';
import { toolLoadAestheticsReference } from '../design/load-aesthetics-reference.js';
import {
  blockPlanModeWrite,
  resolveModeIdFromToolsBody,
} from '../tools/plan-write-guard.js';
import { assessHostKillCommand } from '../tools/host-kill-guard.js';
import { assessHostPortBindCommand } from '../tools/host-port-bind-guard.js';
import { assessUnixPipeOnWindows } from '../tools/windows-pipe-guard.js';
import { resolveExecuteShellProfile } from '../terminal/shell-config.js';
import { describeShellProfileRuntime } from '../terminal/shell-profiles.js';
import {
  coerceContentToFileEol,
  detectDominantEol,
  flexibleReplaceAll,
  matchModeLabel,
  resolveInsertLineFromAnchor,
} from '../tools/flexible-match.js';
import {
  toolBrainAppendLog,
  toolBrainIngestSource,
  toolBrainList,
  toolBrainReadPage,
  toolBrainSearch,
  toolBrainWritePage,
  toolManageBrain,
} from '../tools/brain-tools.js';
import {
  toolGetSettings,
  toolSearchSettings,
  toolUpdateSettings,
} from '../settings/tools.js';
import {
  toolMinnowDocsList,
  toolMinnowDocsRead,
  toolMinnowDocsSearch,
} from '../tools/minnow-docs-tools.js';
import {
  toolFindSymbol,
  toolReadSymbol,
  toolRepoMap,
  toolWhoCalls,
} from '../tools/code-tools.js';
import { toolSaveMemory } from '../tools/memory-tools.js';
import {
  extractWorkspaceDocumentText,
  toolReadDocument,
} from '../tools/read-document.js';
import { decodeTextBuffer } from '../tools/binary-sniff.js';
import { isDocumentFilePath } from '../../src/attachments/document-extensions.mjs';
import { expandGitmojiShortcodes } from '../../src/lib/gitmoji-shortcodes.mjs';
import {
  toolCreatePdf,
  toolCreateSpreadsheet,
  toolCreateWordDocument,
} from '../tools/create-document.js';
import { toolBoardProvisionInfra } from '../workspace/board-infra-provision.js';
import { BROWSER_DRIVER_TOOL_HANDLERS } from '../tools/browser-driver-tools.js';
import {
  toolFetchWebContent,
  toolRagWebContent,
} from '../tools/fetch-web-content.js';
import {
  formatDdgSearchResults,
  searchDdgStructured,
} from '../tools/web-search-ddg.js';
import {
  formatTavilySearchResults,
  searchTavilyStructured,
} from '../tools/web-search-tavily.js';
import {
  formatSearxngSearchResults,
  searchSearxngStructured,
} from '../tools/web-search-searxng.js';
import { appendResultExcerpts } from '../tools/search-enrich.js';
import { loadSearchSettings } from '../research/search.js';
import { getFilesystemAccessFromConfig } from '../config/tool-security.js';
import { callMcpTool, isMcpToolName } from '../mcp/registry.js';
import { callPluginTool, isPluginToolName } from '../tools/loader.js';
import {
  buildAddOnlyDiffLines,
  buildCodeChangePayload,
  buildRemoveOnlyDiffLines,
  codeChangeFromDiff,
  countAppendLineStats,
  countLinesInText,
} from '../tools/line-diff-stats.js';
import { codeChangeForGitCommit } from '../tools/git-change-stats.js';
import {
  captureWorkspaceSnapshot,
  readHeuristicFileSnapshot,
  resolveExecuteCommandCodeChange,
} from '../tools/workspace-change-snapshot.js';
import { runFindFilesSearch, runGrepSearch } from '../tools/grep.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { getAppRoot } from '../workspace/root.js';
import { wrapServerToolResult, wrapUntrusted } from '../security/untrusted.js';
import {
  getEffectiveWorkspaceRoot,
  resolveSafePath,
  runWithToolContext,
} from './path-access.js';
import {
  toolStartBackgroundCommand,
  toolStopBackgroundCommand,
  toolStopCommand,
} from '../dev-server/manager.js';
import { toolManageDevServers } from '../dev-server/tool-handler.js';
import { resolveChatContext } from '../workspace/chat-cwd.js';
import { appendBoardLogLine } from '../orchestrate/board-log-sink.js';
import { guardCdOutsideWorktree as _guardCdRaw } from '../tools/cwd-guard.js';
import { readConfigJson } from '../config/store.js';
import { normalizeToolConfig } from '../config/validators.js';
import { brainWorkspaceKeyFromPath } from '../brain/paths.js';
import { purgeFileFromIndex, getCodeDb } from '../brain/code/schema.js';

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function isGuardCdEnabled() {
  try {
    const meta = await readConfigJson('config.json');
    const autopilot = meta && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta).autopilot : null;
    if (autopilot && typeof autopilot === 'object') {
      const flag = /** @type {Record<string, unknown>} */ (autopilot).guardCdOutsideWorktree;
      if (typeof flag === 'boolean') return flag;
    }
  } catch {
  }
  return true;
}

function toRelativePath(absPath) {
  const rel = path.relative(getEffectiveWorkspaceRoot(), absPath);
  return rel === '' ? '.' : rel.replace(/\\/g, '/');
}

async function runGit(args) {
  try {
    const result = await runProcess('git', args, { cwd: getEffectiveWorkspaceRoot() });
    return formatProcessOutput(`git ${args.join(' ')}`, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error running git: ${message}`;
  }
}

function globToRegExp(globPattern) {
  let re = '^';
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i];
    if (ch === '*' && globPattern[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (globPattern[i + 1] === '/') {
        i += 1;
      }
    } else if (ch === '*') {
      re += '[^/\\\\]*';
    } else if (ch === '?') {
      re += '[^/\\\\]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re, 'i');
}

// ── Web tools ────────────────────────────────────────────────────────────────

async function readTavilyApiKeyFromConfig() {
  const settings = await loadSearchSettings();
  return settings.tavilyApiKey;
}

function wantsDeepRead(args) {
  return args?.deep_read === true || args?.deep_read === 'true';
}

/**
 * @param {string} query
 * @param {{ results: import('../tools/search-result.js').SearchResult[]; error?: string }} outcome
 * @param {(query: string, results: import('../tools/search-result.js').SearchResult[]) => string} format
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
async function finishWebSearch(query, outcome, format, args) {
  if (outcome.error) {
    return outcome.error;
  }
  const formatted = format(query, outcome.results);
  if (!wantsDeepRead(args)) {
    return formatted;
  }
  return appendResultExcerpts(query, outcome.results, formatted);
}

async function toolWebSearchDdg(args) {
  const query = args?.query;
  if (!query || typeof query !== 'string') {
    return 'Error: query is required';
  }

  const outcome = await searchDdgStructured(query);
  return finishWebSearch(query, outcome, formatDdgSearchResults, args);
}

async function toolWebSearchTavily(args) {
  const query = args?.query;
  if (!query || typeof query !== 'string') {
    return 'Error: query is required';
  }

  const apiKey = await readTavilyApiKeyFromConfig();
  if (!apiKey) {
    return 'Error: Tavily API key not configured. Add one in Settings → Tools.';
  }

  const outcome = await searchTavilyStructured(query, apiKey);
  return finishWebSearch(query, outcome, formatTavilySearchResults, args);
}

async function toolWebSearchSearxng(args) {
  const query = args?.query;
  if (!query || typeof query !== 'string') {
    return 'Error: query is required';
  }

  const settings = await loadSearchSettings();
  const outcome = await searchSearxngStructured(query, settings.searxngUrl);
  return finishWebSearch(query, outcome, formatSearxngSearchResults, args);
}

// ── File tools ───────────────────────────────────────────────────────────────

async function toolListDirectory(args) {
  const dirPath = resolveSafePath(args?.path ?? '.');
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((ent) => `${ent.isDirectory() ? '[dir]' : '[file]'} ${ent.name}`);
  return lines.length ? lines.join('\n') : '(empty directory)';
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

/**
 * @param {string} filePath
 * @param {unknown} requestedPath
 */
function shouldExtractAsDocument(filePath, requestedPath) {
  const requested = typeof requestedPath === 'string' ? requestedPath : '';
  return isDocumentFilePath(requested) || isDocumentFilePath(filePath);
}

async function toolReadFile(args) {
  const filePath = resolveSafePath(args?.path);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    return `Error: "${args.path}" is not a file`;
  }
  const rel = toRelativePath(filePath);

  if (shouldExtractAsDocument(filePath, args?.path)) {
    return toolReadDocument({ path: args.path });
  }

  if (stat.size > MAX_READ_FILE_BYTES) {
    return `Error: file is ${formatMb(stat.size)} (limit ${formatMb(MAX_READ_FILE_BYTES)}). Use grep to search it or read_file_range for a bounded line range.`;
  }
  const buffer = await fs.readFile(filePath);
  const decoded = decodeTextBuffer(buffer);
  if (!decoded) {
    return (
      `Error: "${rel}" looks like a binary file and cannot be read as text. ` +
      `Use read_document for PDF, Excel, Word, and other office files.`
    );
  }
  const { text } = capReadFileOutput(decoded.text, rel);
  return decoded.note ? `[${decoded.note}]\n${text}` : text;
}

async function readUtf8OrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') return '';
    throw err;
  }
}

const MAX_DIFF_STAT_BYTES = 5 * 1024 * 1024;

async function statSizeOrNull(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return null;
  }
}

function isDiffableSize(size) {
  return size === null || size <= MAX_DIFF_STAT_BYTES;
}

function withCodeChange(message, codeChange) {
  if (codeChange && (codeChange.additions > 0 || codeChange.deletions > 0)) {
    return { result: message, codeChange };
  }
  return message;
}

function purgeBrainCodeIndexAfterDelete(relPath, isDirectory) {
  try {
    const normalized = String(relPath ?? '').trim().replace(/\\/g, '/');
    if (!normalized) return;
    const root = getEffectiveWorkspaceRoot();
    const repo = brainWorkspaceKeyFromPath(root) || 'workspace';
    const db = getCodeDb(repo);
    if (isDirectory) {
      const base = normalized.replace(/\/$/, '');
      const rows = db
        .prepare(
          `SELECT file FROM file_hashes WHERE repo = ? AND (file = ? OR file LIKE ?)`,
        )
        .all(repo, base, `${base}/%`);
      for (const row of rows) {
        purgeFileFromIndex(db, repo, String(row.file));
      }
    } else {
      purgeFileFromIndex(db, repo, normalized);
    }
  } catch {
  }
}

/**
 * @param {string} content
 * @param {number} startLine
 * @param {number} endLine
 */
function renderNumberedLineRange(content, startLine, endLine) {
  const lines = content.split(/\r?\n/);
  const slice = lines.slice(startLine - 1, endLine);
  const rendered = slice.map((line, idx) => `${startLine + idx}: ${line}`).join('\n');
  const { text } = capTextOutput(rendered, {
    maxLineChars: getOutputCapPolicy().maxOutputChars,
    footerHint: 'request a smaller line range',
  });
  return text;
}

async function toolReadFileRange(args) {
  const filePath = resolveSafePath(args?.path);
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return 'Error: start_line and end_line must be valid integers (1-based, start <= end)';
  }

  if (shouldExtractAsDocument(filePath, args?.path)) {
    const extracted = await extractWorkspaceDocumentText(args.path);
    if (typeof extracted === 'string') {
      return extracted;
    }
    const numbered = renderNumberedLineRange(extracted.text, startLine, endLine);
    return wrapUntrusted(numbered, {
      source: `document:${path.basename(extracted.filename)}`,
    });
  }

  const stat = await fs.stat(filePath);
  if (stat.size > MAX_READ_FILE_BYTES) {
    return `Error: file is ${formatMb(stat.size)} (limit ${formatMb(MAX_READ_FILE_BYTES)}). Use grep to locate specific content instead.`;
  }
  const buffer = await fs.readFile(filePath);
  const rel = toRelativePath(filePath);
  const decoded = decodeTextBuffer(buffer);
  if (!decoded) {
    return (
      `Error: "${rel}" looks like a binary file and cannot be read as text. ` +
      `Use read_document for PDF, Excel, Word, and other office files.`
    );
  }
  const numbered = renderNumberedLineRange(decoded.text, startLine, endLine);
  return decoded.note ? `[${decoded.note}]\n${numbered}` : numbered;
}

async function toolSaveFile(args) {
  const filePath = resolveSafePath(args?.path, { write: true });
  if (args?.content === undefined) {
    return 'Error: content is required';
  }
  const rel = toRelativePath(filePath);
  const nextContent = String(args.content);
  const before = await readUtf8OrEmpty(filePath);
  const { content: normalizedContent, converted, eol } = coerceContentToFileEol(
    nextContent,
    before,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, normalizedContent, 'utf8');
  const eolNote =
    converted && eol ? `, preserved ${eol === '\r\n' ? 'CRLF' : 'LF'} line endings` : '';
  const overwriteNote = before
    ? `, overwrote ${countLinesInText(before)} existing line(s)`
    : '';
  const message = `Saved ${rel} (${normalizedContent.length} bytes${eolNote}${overwriteNote})`;
  return withCodeChange(message, codeChangeFromDiff(before, normalizedContent, rel));
}

async function toolAppendFile(args) {
  const filePath = resolveSafePath(args?.path, { write: true });
  if (args?.content === undefined) {
    return 'Error: content is required';
  }
  const rel = toRelativePath(filePath);
  const content = String(args.content);
  const appendStats = countAppendLineStats(content);
  const { lines, truncated } = buildAddOnlyDiffLines(content);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readUtf8OrEmpty(filePath);
  const { content: normalizedContent, converted, eol } = coerceContentToFileEol(
    content,
    existing,
  );
  await fs.appendFile(filePath, normalizedContent, 'utf8');
  const eolNote =
    converted && eol ? ` (preserved ${eol === '\r\n' ? 'CRLF' : 'LF'} line endings)` : '';
  const message = `Appended to ${rel}${eolNote}`;
  return withCodeChange(
    message,
    buildCodeChangePayload({
      ...appendStats,
      path: rel,
      source: 'file-tool',
      diffLines: lines,
      diffTruncated: truncated,
    }),
  );
}

async function toolInsertAtLine(args) {
  const filePath = resolveSafePath(args?.path, { write: true });
  if (args?.content === undefined) {
    return 'Error: content is required';
  }

  const afterText =
    args?.after_text !== undefined && args?.after_text !== null
      ? String(args.after_text)
      : undefined;
  const beforeText =
    args?.before_text !== undefined && args?.before_text !== null
      ? String(args.before_text)
      : undefined;
  const hasLineNumber = args?.line_number !== undefined && args?.line_number !== null;
  const lineNumber = hasLineNumber ? Number(args.line_number) : undefined;

  if (!afterText && !beforeText && !hasLineNumber) {
    return 'Error: provide line_number, after_text, or before_text';
  }
  if (hasLineNumber && (!Number.isInteger(lineNumber) || lineNumber < 1)) {
    return 'Error: line_number must be a positive integer (1-based)';
  }

  const rel = toRelativePath(filePath);
  let content = String(args.content);
  content = content.replace(/\r?\n$/, '');
  const insertStats = countAppendLineStats(content);
  const { lines: diffLines, truncated } = buildAddOnlyDiffLines(content);
  const existing = await fs.readFile(filePath, 'utf8');
  const eol = detectDominantEol(existing);
  const lines = existing.split(/\r?\n/);
  const insertLines = content.split(/\r?\n/);

  let index;
  let locationLabel;
  if (afterText !== undefined) {
    const resolved = resolveInsertLineFromAnchor(existing, afterText, 'after');
    if ('error' in resolved) return `Error: ${resolved.error}`;
    index = resolved.lineIndex;
    locationLabel = `after "${afterText}"`;
  } else if (beforeText !== undefined) {
    const resolved = resolveInsertLineFromAnchor(existing, beforeText, 'before');
    if ('error' in resolved) return `Error: ${resolved.error}`;
    index = resolved.lineIndex;
    locationLabel = `before "${beforeText}"`;
  } else {
    index = Math.min(lineNumber - 1, lines.length);
    locationLabel = `line ${lineNumber}`;
  }

  lines.splice(index, 0, ...insertLines);
  await fs.writeFile(filePath, lines.join(eol), 'utf8');
  const message = `Inserted ${insertLines.length} line(s) at ${locationLabel} in ${rel}`;
  return withCodeChange(
    message,
    buildCodeChangePayload({
      ...insertStats,
      path: rel,
      source: 'file-tool',
      diffLines,
      diffTruncated: truncated,
    }),
  );
}

async function toolReplaceTextInFile(args) {
  const filePath = resolveSafePath(args?.path, { write: true });
  const search = args?.search;
  const replace = args?.replace ?? '';
  if (search === undefined) {
    return 'Error: search is required';
  }
  const rel = toRelativePath(filePath);
  const content = await fs.readFile(filePath, 'utf8');
  const result = flexibleReplaceAll(content, String(search), String(replace));
  if (result.count === 0) {
    const hint = result.hint ?? 'No occurrences of search text';
    return `${hint} in ${rel}`;
  }
  if (args?.expected_count !== undefined && args?.expected_count !== null) {
    const expected = Number(args.expected_count);
    if (Number.isInteger(expected) && expected >= 0 && result.count !== expected) {
      return `Error: expected ${expected} occurrence(s) but found ${result.count} in ${rel}. No changes written — refine the search text or set expected_count=${result.count}.`;
    }
  }
  const after = result.output;
  await fs.writeFile(filePath, after, 'utf8');
  const modeSuffix = matchModeLabel(result.mode);
  const message = modeSuffix
    ? `Replaced ${result.count} occurrence(s) in ${rel} (${modeSuffix})`
    : `Replaced ${result.count} occurrence(s) in ${rel}`;
  return withCodeChange(message, codeChangeFromDiff(content, after, rel));
}

async function toolSearchInFile(args) {
  const pattern = args?.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return 'Error: pattern is required';
  }
  return runGrepSearch(
    { pattern, path: args?.path, output_mode: 'content' },
    {
      resolveSafePath,
      toRelativePath,
      getWorkspaceRoot: getEffectiveWorkspaceRoot,
    },
  );
}

async function toolGrep(args) {
  return runGrepSearch(args, {
    resolveSafePath,
    toRelativePath,
    getWorkspaceRoot: getEffectiveWorkspaceRoot,
  });
}

async function toolMakeDirectory(args) {
  const dirPath = resolveSafePath(args?.path, { write: true });
  await fs.mkdir(dirPath, { recursive: true });
  return `Created directory ${toRelativePath(dirPath)}`;
}

async function toolMoveFile(args) {
  const source = resolveSafePath(args?.source);
  const destination = resolveSafePath(args?.destination, { write: true });
  const destRel = toRelativePath(destination);

  const srcSize = await statSizeOrNull(source);
  const destSize = await statSizeOrNull(destination);
  const canDiff = isDiffableSize(srcSize) && isDiffableSize(destSize);

  let destBefore = '';
  let sourceContent = '';
  if (canDiff) {
    destBefore = await readUtf8OrEmpty(destination);
    try {
      const srcStat = await fs.stat(source);
      if (srcStat.isFile()) {
        sourceContent = await fs.readFile(source, 'utf8');
      }
    } catch {
    }
  }

  const finish = () => {
    const message = `Moved ${toRelativePath(source)} -> ${destRel}`;
    return canDiff
      ? withCodeChange(message, codeChangeFromDiff(destBefore, sourceContent, destRel))
      : message;
  };

  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'EXDEV') {
      try {
        await fs.cp(source, destination, { recursive: true, force: true });
        await fs.rm(source, { recursive: true, force: true });
      } catch (copyErr) {
        const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
        return `Error: cross-device move failed (${msg})`;
      }
      return finish();
    }
    if (code === 'EBUSY' || code === 'EPERM') {
      const hint =
        code === 'EBUSY'
          ? 'File is in use — close other apps using it, then try again.'
          : 'Permission denied — check file permissions or close apps using this file.';
      return `Error: ${hint}`;
    }
    throw err;
  }
  return finish();
}

async function toolCopyFile(args) {
  const source = resolveSafePath(args?.source);
  const destination = resolveSafePath(args?.destination, { write: true });
  const stat = await fs.stat(source);
  if (!stat.isFile()) {
    return `Error: source "${args.source}" is not a file (use move for directories)`;
  }
  const destRel = toRelativePath(destination);
  const destSize = await statSizeOrNull(destination);
  const canDiff = isDiffableSize(stat.size) && isDiffableSize(destSize);
  const destBefore = canDiff ? await readUtf8OrEmpty(destination) : '';
  const sourceContent = canDiff ? await fs.readFile(source, 'utf8') : '';
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  const message = `Copied ${toRelativePath(source)} -> ${destRel}`;
  return canDiff
    ? withCodeChange(message, codeChangeFromDiff(destBefore, sourceContent, destRel))
    : message;
}

const IMPORT_WORKSPACE_FILE_MAX_BYTES = 10 * 1024 * 1024;

async function toolImportWorkspaceFile(args) {
  const filePath = resolveSafePath(args?.path, { write: true });
  const kind = String(args?.kind ?? 'file').toLowerCase();
  if (kind === 'dir' || kind === 'directory') {
    await fs.mkdir(filePath, { recursive: true });
    return `Imported directory ${toRelativePath(filePath)}`;
  }
  if (args?.content === undefined || args?.content === null) {
    return 'Error: content (base64 file bytes) is required';
  }
  let buffer;
  try {
    buffer = Buffer.from(String(args.content), 'base64');
  } catch {
    return 'Error: content is not valid base64';
  }
  if (buffer.length > IMPORT_WORKSPACE_FILE_MAX_BYTES) {
    return `Error: file exceeds ${IMPORT_WORKSPACE_FILE_MAX_BYTES / (1024 * 1024)}MB limit`;
  }
  const rel = toRelativePath(filePath);
  const before = await readUtf8OrEmpty(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  const message = `Imported ${rel} (${buffer.length} bytes)`;
  const afterText = buffer.toString('utf8');
  return withCodeChange(message, codeChangeFromDiff(before, afterText, rel));
}

async function toolDeletePath(args) {
  const target = resolveSafePath(args?.path, { write: true });
  const rel = toRelativePath(target);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
    purgeBrainCodeIndexAfterDelete(rel, true);
    return `Deleted ${rel}`;
  }
  if (stat.size > MAX_DIFF_STAT_BYTES) {
    await fs.unlink(target);
    purgeBrainCodeIndexAfterDelete(rel, false);
    return `Deleted ${rel}`;
  }
  const content = await fs.readFile(target, 'utf8');
  const deletions = countLinesInText(content);
  const { lines, truncated } = buildRemoveOnlyDiffLines(content);
  await fs.unlink(target);
  purgeBrainCodeIndexAfterDelete(rel, false);
  const message = `Deleted ${rel}`;
  if (deletions === 0) return message;
  return withCodeChange(
    message,
    buildCodeChangePayload({
      additions: 0,
      deletions,
      path: rel,
      source: 'file-tool',
      diffLines: lines,
      diffTruncated: truncated,
    }),
  );
}

async function toolFindFiles(args) {
  const pattern = args?.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return 'Error: pattern is required';
  }

  return runFindFilesSearch(args, {
    resolveSafePath,
    toRelativePath,
    getWorkspaceRoot: getEffectiveWorkspaceRoot,
  });
}

async function toolGetFileMetadata(args) {
  const target = resolveSafePath(args?.path);
  const stat = await fs.stat(target);
  const lines = [
    `path: ${toRelativePath(target)}`,
    `type: ${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'}`,
    `size: ${stat.size} bytes`,
    `modified: ${stat.mtime.toISOString()}`,
    `created: ${stat.birthtime.toISOString()}`,
  ];
  if (stat.isFile() && stat.size > 0) {
    try {
      const sampleBytes = Math.min(stat.size, 64 * 1024);
      const handle = await fs.open(target, 'r');
      let sample;
      try {
        const buffer = Buffer.alloc(sampleBytes);
        await handle.read(buffer, 0, sampleBytes, 0);
        sample = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
      const crlf = (sample.match(/\r\n/g) || []).length;
      const lf = (sample.match(/(?<!\r)\n/g) || []).length;
      if (crlf === 0 && lf === 0) {
        lines.push('line_ending: none');
      } else if (crlf > 0 && lf === 0) {
        lines.push('line_ending: CRLF');
      } else if (lf > 0 && crlf === 0) {
        lines.push('line_ending: LF');
      } else {
        lines.push('line_ending: mixed');
      }
    } catch {
    }
  }
  return lines.join('\n');
}

// ── Git tools ────────────────────────────────────────────────────────────────

async function toolGitStatus() {
  return runGit(['status', '--porcelain', '-b']);
}

async function toolGitDiff(args) {
  const gitArgs = ['diff'];
  if (args?.staged) {
    gitArgs.push('--cached');
  }
  if (args?.path) {
    gitArgs.push('--', args.path);
  }

  const label = `git ${gitArgs.join(' ')}`;
  const cwd = getEffectiveWorkspaceRoot();
  const policy = getOutputCapPolicy();
  const patchBudget = policy.maxOutputChars - 2_000;

  try {
    const result = await runProcess('git', gitArgs, { cwd });
    const patch = String(result.stdout ?? '');

    if (policy.applyResultCap && patch.trimEnd().length > patchBudget) {
      const numstatArgs = ['diff', '--numstat'];
      if (args?.staged) {
        numstatArgs.push('--cached');
      }
      if (args?.path) {
        numstatArgs.push('--', args.path);
      }
      const numstatResult = await runProcess('git', numstatArgs, { cwd });
      const { text } = truncateGitDiff(patch, numstatResult.stdout ?? '', {
        maxChars: patchBudget,
        staged: Boolean(args?.staged),
        scopePath: typeof args?.path === 'string' ? args.path : undefined,
      });
      return formatProcessOutput(label, { ...result, stdout: text });
    }

    return formatProcessOutput(label, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error running git: ${message}`;
  }
}

async function toolGitLog(args) {
  const count = Number(args?.count) || 10;
  return runGit(['log', `--oneline`, `-n`, String(Math.max(1, Math.min(count, 100)))]);
}

async function toolGitAdd(args) {
  const paths = args?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return 'Error: paths array is required';
  }
  return runGit(['add', '--', ...paths.map(String)]);
}

async function toolGitCommit(args) {
  const message = args?.message;
  if (!message || typeof message !== 'string') {
    return 'Error: message is required';
  }
  const result = await runGit(['commit', '-m', expandGitmojiShortcodes(message)]);
  if (String(result).trimStart().startsWith('Error')) {
    return result;
  }
  const codeChange = await codeChangeForGitCommit(getEffectiveWorkspaceRoot());
  return withCodeChange(String(result), codeChange);
}

async function toolGitCheckout(args) {
  const branch = args?.branch;
  if (!branch || typeof branch !== 'string') {
    return 'Error: branch is required';
  }
  if (branch.startsWith('-')) {
    return `Error: invalid branch name "${branch}" (cannot start with "-")`;
  }
  const gitArgs = args?.create ? ['checkout', '-b', branch] : ['checkout', branch];
  return runGit(gitArgs);
}

async function toolGitBranch(args) {
  const gitArgs = ['branch', '--no-color'];
  if (args?.all === true) {
    gitArgs.push('--all');
  }
  gitArgs.push('--sort=-committerdate');
  return runGit(gitArgs);
}

// ── Code exec ────────────────────────────────────────────────────────────────

const BLOCK_UNTIL_MS_MAX = 120_000;

function clampBlockUntilMs(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.floor(n), BLOCK_UNTIL_MS_MAX));
}

function resolveCommandCwd(args) {
  const cwdUser =
    typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.';
  return resolveSafePath(cwdUser, { write: false });
}

/**
 * @param {string | undefined} chatId
 * @returns {Promise<string>}
 */
async function resolveDefaultCwd(chatId) {
  if (chatId) {
    const { worktreeRoot } = await resolveChatContext(chatId);
    if (worktreeRoot) return worktreeRoot;
  }
  return getEffectiveWorkspaceRoot();
}

/**
 * @param {string} command
 * @param {string} worktreeRoot
 * @param {{ chatId?: string; groupId?: string }} meta
 * @returns {{ command: string; redirected: boolean }}
 */
function guardCdOutsideWorktree(command, worktreeRoot, meta) {
  const result = _guardCdRaw(command, worktreeRoot);
  if (result.redirected && meta.groupId) {
    void appendBoardLogLine(meta.groupId, {
      type: 'cwd_redirect',
      chatId: meta.chatId,
      from: /** @type {any} */ (result).originalTarget ?? '(unknown)',
      to: worktreeRoot,
      reason: 'worktree_isolation',
      ts: Date.now(),
    });
  }
  return result;
}

async function resolveBoardSpawnEnv(args, cwd, chatId) {
  try {
    const { resolveBoardTaskSpawnEnvForCommand } = await import(
      '../workspace/board-task-ports.js'
    );
    return await resolveBoardTaskSpawnEnvForCommand({ chatId, cwd });
  } catch {
    return undefined;
  }
}

async function toolExecuteCommand(args) {
  if (args?.stop === true) {
    return toolStopCommand(args);
  }

  const shellProfile = await resolveExecuteShellProfile(getEffectiveWorkspaceRoot());
  const runtime = describeShellProfileRuntime(shellProfile).runtime;
  const skipUnixPipeGuard =
    process.platform === 'win32' &&
    (runtime === 'wsl' || runtime === 'git-bash');

  if (typeof args?.command === 'string') {
    const hostKill = assessHostKillCommand(args.command);
    if (hostKill) return hostKill;
    const portBind = assessHostPortBindCommand(args.command);
    if (portBind) return portBind;
    if (!skipUnixPipeGuard) {
      const unixPipe = assessUnixPipeOnWindows(args.command);
      if (unixPipe) return unixPipe;
    }
  }

  if (args?.background === true) {
    let command = typeof args?.command === 'string' ? args.command.trim() : '';
    if (!command) return 'Error: command is required';

    const chatId = typeof args?.chatId === 'string' ? args.chatId : undefined;

    let cwd;
    /** @type {string | undefined} */
    let worktreeRoot;
    /** @type {string | undefined} */
    let groupId;
    if (typeof args?.cwd === 'string' && args.cwd.trim()) {
      try {
        cwd = resolveCommandCwd(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: ${message}`;
      }
      const ctx = await resolveChatContext(chatId ?? '');
      worktreeRoot = ctx.worktreeRoot;
      groupId = ctx.groupId;
    } else {
      const ctx = await resolveChatContext(chatId ?? '');
      worktreeRoot = ctx.worktreeRoot;
      groupId = ctx.groupId;
      cwd = await resolveDefaultCwd(chatId);
      if (worktreeRoot && (await isGuardCdEnabled())) {
        const guarded = guardCdOutsideWorktree(command, worktreeRoot, { chatId, groupId });
        if (guarded.redirected) command = guarded.command;
      }
    }
    const toolCallId =
      typeof args?.toolCallId === 'string' ? args.toolCallId : undefined;
    const spawnEnv = await resolveBoardSpawnEnv(args, cwd, chatId);

    try {
      const started = await createBackgroundRun({
        command,
        cwd,
        shell: false,
        source: 'agent',
        chatId,
        toolCallId,
        logSubdir: 'terminal',
        shellProfile,
        allowUnsandboxed: args?.allow_unsandboxed === true,
        worktreeRoot: worktreeRoot || undefined,
        ...(spawnEnv ? { env: spawnEnv } : {}),
      });
      const blockUntilMs = clampBlockUntilMs(args?.block_until_ms);
      const rawOutput =
        blockUntilMs > 0
          ? await waitForRunOutput(started.runId, blockUntilMs)
          : '';
      // Same head/tail and budget controls as the blocking path — read_command_log
      // has the whole log either way.
      const output = rawOutput
        ? capTextOutput(sliceStreamLines(rawOutput, resolveOutputSliceFromArgs(args)), {
            middleElide: true,
            footerHint: 'read the rest with read_command_log',
          }).text
        : '';
      return JSON.stringify(
        {
          ok: true,
          background: true,
          runId: started.runId,
          pid: started.pid,
          logPath: started.logPath,
          startedAt: started.startedAt,
          output,
        },
        null,
        2,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
  }

  const rawCommand = args?.command;
  if (!rawCommand || typeof rawCommand !== 'string') {
    return 'Error: command is required';
  }

  const chatId = typeof args?.chatId === 'string' ? args.chatId : undefined;
  const toolCallId = typeof args?.toolCallId === 'string' ? args.toolCallId : undefined;

  let command = rawCommand;
  let cwd;
  /** @type {string | undefined} */
  let worktreeRoot;
  /** @type {string | undefined} */
  let groupId;
  if (typeof args?.cwd === 'string' && args.cwd.trim()) {
    try {
      cwd = resolveCommandCwd(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }
    const ctx = await resolveChatContext(chatId ?? '');
    worktreeRoot = ctx.worktreeRoot;
    groupId = ctx.groupId;
  } else {
    const ctx = await resolveChatContext(chatId ?? '');
    worktreeRoot = ctx.worktreeRoot;
    groupId = ctx.groupId;
    cwd = worktreeRoot ?? getEffectiveWorkspaceRoot();
    if (worktreeRoot && await isGuardCdEnabled()) {
      const guarded = guardCdOutsideWorktree(rawCommand, worktreeRoot, { chatId, groupId });
      if (guarded.redirected) command = guarded.command;
    }
  }
  const spawnEnv = await resolveBoardSpawnEnv(args, cwd, chatId);

  const workspaceRoot = getEffectiveWorkspaceRoot();
  const beforeSnapshot = await captureWorkspaceSnapshot(workspaceRoot);
  const beforeFileContents = new Map();
  const heuristicRel = String(command).match(
    /\bsed\s+(?:-[^\s]+\s+)*['"]?([^'"\s|>]+)['"]?/i,
  )?.[1];
  if (heuristicRel) {
    beforeFileContents.set(
      heuristicRel,
      await readHeuristicFileSnapshot(workspaceRoot, heuristicRel),
    );
  }

  try {
    const output = await executeCommandBlocking({
      command,
      cwd,
      shell: false,
      chatId,
      toolCallId,
      timeoutMs: typeof args?.timeout_ms === 'number' ? args.timeout_ms : undefined,
      shellProfile,
      allowUnsandboxed: args?.allow_unsandboxed === true,
      worktreeRoot: worktreeRoot || undefined,
      outputSlice: resolveOutputSliceFromArgs(args),
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });
    if (groupId) {
      const text = String(output);
      const sandboxed = /\[sandboxed:/i.test(text);
      const notSandboxed = /\[NOT sandboxed:/i.test(text);
      if (sandboxed || notSandboxed || text.trimStart().startsWith('Error: Agent shell sandbox')) {
        void appendBoardLogLine(groupId, {
          type: 'sandbox',
          chatId,
          applied: sandboxed,
          trailer: sandboxed
            ? (text.match(/\[sandboxed:[^\]]+\]/i)?.[0] ?? null)
            : (text.match(/\[NOT sandboxed:[^\]]+\]/i)?.[0] ?? null),
          error: text.trimStart().startsWith('Error: Agent shell sandbox') ? text.slice(0, 400) : null,
          ts: Date.now(),
        });
      }
    }
    if (String(output).trimStart().startsWith('Error')) {
      return output;
    }
    const codeChange = await resolveExecuteCommandCodeChange({
      cwd: workspaceRoot,
      command,
      beforeSnapshot,
      beforeFileContents,
    });
    return withCodeChange(String(output), codeChange);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

async function toolReadCommandLog(args) {
  const runId = typeof args?.run_id === 'string' ? args.run_id.trim() : '';
  if (!runId) return 'Error: run_id is required';

  const policy = getOutputCapPolicy();
  const hasExplicitMax =
    typeof args?.max_bytes === 'number' && Number.isFinite(args.max_bytes);
  const maxBytes = hasExplicitMax
    ? Math.max(1024, Math.min(Math.floor(args.max_bytes), 512 * 1024))
    : policy.applyResultCap
      ? 64 * 1024
      : 512 * 1024;

  try {
    const snapshot = await readCommandLogSnapshot(runId, maxBytes);
    return JSON.stringify(snapshot, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

async function toolListRunningCommands(args) {
  const chatId =
    typeof args?.chat_id === 'string' && args.chat_id.trim()
      ? args.chat_id.trim()
      : undefined;
  const runs = await listKnownActiveRuns({
    source: 'agent',
    ...(chatId ? { chatId } : {}),
  });
  return JSON.stringify({ ok: true, runs }, null, 2);
}

async function toolRunJavascript(args) {
  const code = args?.code;
  if (!code || typeof code !== 'string') {
    return 'Error: code is required';
  }

  try {
    return await executeCommandBlocking({
      command: 'node',
      args: ['-e', code],
      cwd: getEffectiveWorkspaceRoot(),
      shell: false,
      timeoutMs: COMMAND_TIMEOUT_MS,
      allowUnsandboxed: args?.allow_unsandboxed === true,
      chatId: typeof args?.chatId === 'string' ? args.chatId : undefined,
      toolCallId: typeof args?.toolCallId === 'string' ? args.toolCallId : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

async function resolvePythonBin(cwd) {
  const candidates =
    process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  let lastError = '';

  for (const bin of candidates) {
    try {
      await runProcess(bin, ['--version'], { cwd, timeout: 5_000 });
      return { bin };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { error: lastError };
}

async function toolRunPython(args) {
  const code = args?.code;
  if (!code || typeof code !== 'string') {
    return 'Error: code is required';
  }

  const cwd = getEffectiveWorkspaceRoot();
  const resolved = await resolvePythonBin(cwd);
  if (!resolved.bin) {
    return `Error: could not run Python (${resolved.error || 'no interpreter found'})`;
  }

  try {
    return await executeCommandBlocking({
      command: resolved.bin,
      args: ['-c', code],
      cwd,
      shell: false,
      timeoutMs: COMMAND_TIMEOUT_MS,
      allowUnsandboxed: args?.allow_unsandboxed === true,
      chatId: typeof args?.chatId === 'string' ? args.chatId : undefined,
      toolCallId: typeof args?.toolCallId === 'string' ? args.toolCallId : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

async function toolSendNotification(args) {
  const title = String(args?.title ?? 'Minnow');
  const message = String(args?.message ?? args?.body ?? '');
  if (!message) {
    return 'Error: message is required';
  }

  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
      await execFileAsync('osascript', ['-e', script]);
      return `Notification sent: ${title}`;
    }

    if (platform === 'linux') {
      await execFileAsync('notify-send', [title, message]);
      return `Notification sent: ${title}`;
    }

    if (platform === 'win32') {
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        `[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`,
      ].join('; ');
      await execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { windowsHide: true },
      );
      return `Notification shown: ${title}`;
    }

    return `Error: notifications not supported on ${platform}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error sending notification: ${msg}`;
  }
}

const SERVER_TOOL_HANDLERS = {
  web_search_ddg: toolWebSearchDdg,
  web_search_tavily: toolWebSearchTavily,
  web_search_searxng: toolWebSearchSearxng,
  fetch_web_content: toolFetchWebContent,
  rag_web_content: toolRagWebContent,
  list_directory: toolListDirectory,
  read_file: toolReadFile,
  read_file_range: toolReadFileRange,
  save_file: toolSaveFile,
  append_file: toolAppendFile,
  insert_at_line: toolInsertAtLine,
  replace_text_in_file: toolReplaceTextInFile,
  search_in_file: toolSearchInFile,
  grep: toolGrep,
  make_directory: toolMakeDirectory,
  move_file: toolMoveFile,
  copy_file: toolCopyFile,
  import_workspace_file: toolImportWorkspaceFile,
  delete_path: toolDeletePath,
  find_files: toolFindFiles,
  get_file_metadata: toolGetFileMetadata,
  git_status: toolGitStatus,
  git_diff: toolGitDiff,
  git_log: toolGitLog,
  git_add: toolGitAdd,
  git_commit: toolGitCommit,
  git_checkout: toolGitCheckout,
  git_branch: toolGitBranch,
  execute_command: toolExecuteCommand,
  read_command_log: toolReadCommandLog,
  list_running_commands: toolListRunningCommands,
  stop_command: toolStopCommand,
  start_background_command: toolStartBackgroundCommand,
  stop_background_command: toolStopBackgroundCommand,
  manage_dev_servers: toolManageDevServers,
  run_javascript: toolRunJavascript,
  run_python: toolRunPython,
  send_notification: toolSendNotification,
  read_document: toolReadDocument,
  create_pdf: toolCreatePdf,
  create_spreadsheet: toolCreateSpreadsheet,
  create_word_document: toolCreateWordDocument,
  run_impeccable: (args) =>
    toolRunImpeccable(args, getAppRoot(), getEffectiveWorkspaceRoot()),
  load_impeccable_context: () =>
    toolLoadImpeccableContext(getAppRoot(), getEffectiveWorkspaceRoot()),
  load_aesthetics_reference: () => toolLoadAestheticsReference(getAppRoot()),
  get_lsp_diagnostics: async (args) => {
    const { getLspDiagnostics } = await import('../lsp/manager.js');
    return getLspDiagnostics(String(args?.path ?? ''));
  },
  brain_search: toolBrainSearch,
  brain_read_page: toolBrainReadPage,
  brain_list: toolBrainList,
  minnow_docs_search: toolMinnowDocsSearch,
  minnow_docs_read: toolMinnowDocsRead,
  minnow_docs_list: toolMinnowDocsList,
  brain_write_page: toolBrainWritePage,
  brain_append_log: toolBrainAppendLog,
  brain_ingest_source: toolBrainIngestSource,
  manage_brain: toolManageBrain,
  search_settings: toolSearchSettings,
  get_settings: toolGetSettings,
  update_settings: toolUpdateSettings,
  save_memory: toolSaveMemory,
  board_provision_infra: toolBoardProvisionInfra,
  repo_map: toolRepoMap,
  find_symbol: toolFindSymbol,
  who_calls: toolWhoCalls,
  read_symbol: toolReadSymbol,
  read_diagnostics: async (args) => {
    const { loadGroupedErrors, loadDiagnosticLogTail } = await import('../diagnostics/store.js');
    const { formatDiagnosticReportMarkdown } = await import('../diagnostics/redact.js');
    const { buildDiagnosticsHealth } = await import('../diagnostics/middleware.js');
    const format = typeof args?.format === 'string' ? args.format : 'summary';
    const source =
      args?.source === 'renderer' || args?.source === 'server' || args?.source === 'electron'
        ? args.source
        : 'all';
    const maxLines = Number(args?.maxLines) || 50;

    if (format === 'report') {
      const health = await buildDiagnosticsHealth();
      const errors = await loadGroupedErrors({ maxLines: 100, source, redact: true });
      const logLines = await loadDiagnosticLogTail({ maxLines: 50, redact: true });
      return formatDiagnosticReportMarkdown({
        version: health.version,
        platform: health.platform,
        nodeVersion: health.nodeVersion,
        electronVersion: health.electronVersion,
        health,
        errors,
        logLines,
      });
    }

    const errors = await loadGroupedErrors({ maxLines, source, redact: true });
    const health = await buildDiagnosticsHealth();
    return JSON.stringify(
      {
        health: {
          version: health.version,
          platform: health.platform,
          components: health.components,
          lastError: health.lastError,
        },
        errors,
      },
      null,
      2,
    );
  },
  ...BROWSER_DRIVER_TOOL_HANDLERS,
};

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {{ workspaceRoot?: string }} [options]
 */
export async function executeServerTool(name, args, options = {}) {
  const fsAccess = await getFilesystemAccessFromConfig();
  const allowOutsideWorkspace = fsAccess === 'full';
  const toolsRaw = await readConfigJson('tools.json');
  const tools = normalizeToolConfig(toolsRaw);
  const outputPolicy = resolveOutputCapPolicy(tools.toolOutput, args ?? {});
  return runWithToolContext(async () => {
    return runWithOutputCapPolicy(outputPolicy, async () => {
    try {
      if (isPluginToolName(name)) {
        const result = await callPluginTool(name, args ?? {});
        return { result: wrapServerToolResult(name, args ?? {}, String(result)) };
      }
      if (isMcpToolName(name)) {
        const result = await callMcpTool(name, args ?? {});
        return { result: wrapServerToolResult(name, args ?? {}, String(result)) };
      }
      const handler = SERVER_TOOL_HANDLERS[name];
      if (!handler) {
        return { result: `Not implemented: ${name}` };
      }
      const out = await handler(args ?? {});
      if (out && typeof out === 'object' && 'result' in out) {
        return {
          ...out,
          result: wrapServerToolResult(name, args ?? {}, String(out.result)),
        };
      }
      return { result: wrapServerToolResult(name, args ?? {}, String(out)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Error: ${message}` };
    }
    });
  }, {
    allowOutsideWorkspace,
    workspaceRoot: options.workspaceRoot,
  });
}

// ── Middleware ───────────────────────────────────────────────────────────────

const MAX_TOOLS_BODY_BYTES = 32 * 1024 * 1024;

function readJsonBody(req, maxBytes = MAX_TOOLS_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function statusForToolsBodyError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'Body too large') return 413;
  return 400;
}

export function createToolsMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';

    if (!url.startsWith('/api/tools')) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url === '/api/tools/ping' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === '/api/tools/code-change-for-commit' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const body = await readJsonBody(req);
        const sha = typeof body?.sha === 'string' ? body.sha.trim() : '';
        if (!sha) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing or invalid "sha"' }));
          return;
        }
        const codeChange = await codeChangeForGitCommit(getEffectiveWorkspaceRoot(), sha);
        res.statusCode = 200;
        res.end(JSON.stringify({ codeChange: codeChange ?? null }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.statusCode = statusForToolsBodyError(err);
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    if (url === '/api/tools' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const body = await readJsonBody(req);
        const name = body?.name;
        const args = body?.args ?? {};
        if (!name || typeof name !== 'string') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing or invalid "name"' }));
          return;
        }
        const modeId = resolveModeIdFromToolsBody(body);
        const planWriteBlock = blockPlanModeWrite(modeId, name, args);
        if (planWriteBlock) {
          res.statusCode = 200;
          res.end(JSON.stringify({ result: planWriteBlock }));
          return;
        }

        if (modeId === 'plan' && name === 'update_settings') {
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              result: 'Error: Plan mode does not allow update_settings. Use launch_minnow_app to open Settings.',
            }),
          );
          return;
        }

        let workspaceRoot;
        if (body?.workspaceRoot != null) {
          if (typeof body.workspaceRoot !== 'string' || !body.workspaceRoot.trim()) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid workspaceRoot' }));
            return;
          }
          try {
            workspaceRoot = await validateAllowedWorkspaceRoot(body.workspaceRoot);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: message }));
            return;
          }
        }

        const out = await executeServerTool(name, args, { workspaceRoot });
        res.statusCode = 200;
        const payload = { result: String(out.result ?? '') };
        if (Array.isArray(out.attachments) && out.attachments.length > 0) {
          payload.attachments = out.attachments;
        }
        if (out.codeChange && typeof out.codeChange === 'object') {
          payload.codeChange = out.codeChange;
        }
        res.end(JSON.stringify(payload));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.statusCode = statusForToolsBodyError(err);
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}