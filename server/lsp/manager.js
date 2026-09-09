import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { getBuiltinLspIds, loadMergedLspConfig } from './config-loader.js';
import { resolveLspSpawnArgv, tryResolveBundledTsserverPath } from './resolve-command.js';
import { buildLspProcessEnv } from './paths.js';
import { applyNodeRuntimeEnv } from './node-runtime.js';
import { logChildProcessDiagnostic } from '../diagnostics/process-handlers.js';
import {
  matchServersForPath,
  serverSupportsDocumentFormatting,
  serverSupportsRangeFormatting,
  serverSupportsWorkspaceSymbols,
} from '../../src/lsp/merge-config.mjs';
import { formatDiagnostics } from '../../src/lsp/format-diagnostics.mjs';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { normalizeFileUri } from './file-uri.js';
import { hashTypeScriptProjectFingerprint } from './project-fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '../..');

const LSP_SCOPE_EDITOR = 'editor';
const LSP_SCOPE_AGENT = 'agent';
export const LSP_SCOPE_INDEX = 'index';

const DEFAULT_DIAG_QUIET_PERIOD_MS = 150;
const DEFAULT_DIAG_EMPTY_QUIET_PERIOD_MS = 500;
const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 6000;
const LSP_COMPLETION_TIMEOUT_MS = 4000;
const LSP_HOVER_TIMEOUT_MS = 1000;
const LSP_SIGNATURE_TIMEOUT_MS = 1000;
const LSP_DEFINITION_TIMEOUT_MS = 3000;
const LSP_FORMAT_TIMEOUT_MS = 10_000;
const LSP_INITIALIZE_TIMEOUT_MS = 20_000;
const DIAG_AGENT_SETTLE_MARGIN_MS = 10_000;
const DEFAULT_DIAG_TOTAL_TIMEOUT_MS = LSP_INITIALIZE_TIMEOUT_MS + DIAG_AGENT_SETTLE_MARGIN_MS;
const MAX_LSP_STDERR_LINES = 80;
const MAX_DIAGNOSTIC_SNAPSHOT_ENTRIES = 128;

let lastLspBridgeError = null;

/** @type {Record<string, { processes: Map<string, object>, pendingConnections: Map<string, Promise<object>>, documentSync: Map<string, { version: number, text: string }>, diagnosticSnapshots: Map<string, { revision: string, projectRevision: string, formatted: string }> }>} */
const scopeStores = {
  [LSP_SCOPE_EDITOR]: {
    processes: new Map(),
    pendingConnections: new Map(),
    documentSync: new Map(),
    diagnosticSnapshots: new Map(),
  },
  [LSP_SCOPE_AGENT]: {
    processes: new Map(),
    pendingConnections: new Map(),
    documentSync: new Map(),
    diagnosticSnapshots: new Map(),
  },
  [LSP_SCOPE_INDEX]: {
    processes: new Map(),
    pendingConnections: new Map(),
    documentSync: new Map(),
    diagnosticSnapshots: new Map(),
  },
};

const diagnosticWaiters = new Map();

let diagQuietPeriodMs = DEFAULT_DIAG_QUIET_PERIOD_MS;
let diagEmptyQuietPeriodMs = DEFAULT_DIAG_EMPTY_QUIET_PERIOD_MS;
let diagTotalTimeoutMs = DEFAULT_DIAG_TOTAL_TIMEOUT_MS;

function getScopeStore(scope) {
  return scopeStores[scope] ?? scopeStores[LSP_SCOPE_EDITOR];
}

function contentRevision(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function lspWorkspaceRoot() {
  return getEffectiveWorkspaceRoot();
}

/**
 * Language-server processes are keyed by workspace in **every** scope.
 *
 * Only the agent scope used to be; the editor and index scopes shared one bare
 * `serverId`, which is exactly why switching folders had to call
 * `shutdownAllLsp()` — a single tsserver could not be pointed at two roots. With
 * the root in the key, two open workspaces each get their own process and no
 * teardown is needed.
 */
function connectionProcessKey(scope, serverId) {
  return `${serverId}::${path.resolve(lspWorkspaceRoot())}`;
}

/**
 * Live language-server processes per scope. Each open workspace adds one process
 * per matched server, so cap the total and evict the least recently used
 * process from a workspace other than the one being served.
 */
const MAX_LSP_PROCESSES_PER_SCOPE = 12;

function touchLspProcess(store, processKey) {
  const state = store.processes.get(processKey);
  if (state) state.lastUsedAt = Date.now();
  return state;
}

function evictLspProcessesLru(scope, store, keepProcessKey) {
  while (store.processes.size > MAX_LSP_PROCESSES_PER_SCOPE) {
    /** @type {string | null} */
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, state] of store.processes) {
      if (key === keepProcessKey) continue;
      const at = typeof state.lastUsedAt === 'number' ? state.lastUsedAt : 0;
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const state = store.processes.get(oldestKey);
    if (state) discardLspState(scope, oldestKey, state);
    else store.processes.delete(oldestKey);
  }
}

function workspaceRootUri(workspaceRoot = lspWorkspaceRoot()) {
  return pathToFileURL(workspaceRoot).href;
}

function toFileUri(relativePath, workspaceRoot = lspWorkspaceRoot()) {
  const abs = path.resolve(workspaceRoot, relativePath);
  return normalizeFileUri(pathToFileURL(abs).href);
}

function guessLanguageId(relativePath) {
  const ext = relativePath.includes('.')
    ? relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()
    : '';
  const map = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.htm': 'html',
    '.py': 'python',
    '.pyi': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.zsh': 'shellscript',
    '.ksh': 'shellscript',
    '.dockerfile': 'dockerfile',
    '.graphql': 'graphql',
    '.gql': 'graphql',
    '.php': 'php',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.rb': 'ruby',
    '.lua': 'lua',
    '.zig': 'zig',
    '.zon': 'zig',
    '.tf': 'terraform',
    '.tfvars': 'terraform',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.astro': 'astro',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.scala': 'scala',
    '.sql': 'sql',
    '.xml': 'xml',
    '.svg': 'xml',
    '.dart': 'dart',
    '.fake': 'fake',
  };
  const base = path.basename(relativePath);
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) {
    return 'dockerfile';
  }
  return map[ext] ?? 'plaintext';
}

function normalizeDocumentation(doc) {
  if (doc == null) return undefined;
  if (typeof doc === 'string') return doc;
  if (typeof doc === 'object' && doc.value != null) {
    return {
      kind: doc.kind === 'markdown' ? 'markdown' : 'plaintext',
      value: String(doc.value),
    };
  }
  return undefined;
}

function normalizeLspRange(range) {
  if (!range || typeof range !== 'object' || !range.start) return undefined;
  const start = range.start;
  const end = range.end ?? start;
  return {
    start: {
      line: Number(start.line ?? 0),
      character: Number(start.character ?? 0),
    },
    end: {
      line: Number(end.line ?? start.line ?? 0),
      character: Number(end.character ?? start.character ?? 0),
    },
  };
}

function fileUriToRelativePath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  try {
    const abs = fileURLToPath(normalizeFileUri(uri));
    const root = path.resolve(lspWorkspaceRoot());
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, '/');
    }
  } catch {
  }
  return uri;
}

function normalizeDocumentSymbol(symbol) {
  if (!symbol || typeof symbol !== 'object') return null;
  const name = String(symbol.name ?? '');
  if (!name) return null;

  if (symbol.location && !symbol.selectionRange) {
    const loc = symbol.location;
    return {
      name,
      kind: typeof symbol.kind === 'number' ? symbol.kind : 0,
      range: normalizeLspRange(loc.range),
      selectionRange: normalizeLspRange(loc.range),
      containerName:
        symbol.containerName != null ? String(symbol.containerName) : undefined,
      children: [],
    };
  }

  const entry = {
    name,
    kind: typeof symbol.kind === 'number' ? symbol.kind : 0,
    range: normalizeLspRange(symbol.range),
    selectionRange: normalizeLspRange(symbol.selectionRange ?? symbol.range),
  };
  if (symbol.detail != null) entry.detail = String(symbol.detail);
  if (Array.isArray(symbol.children) && symbol.children.length > 0) {
    const children = symbol.children.map(normalizeDocumentSymbol).filter(Boolean);
    if (children.length > 0) entry.children = children;
  }
  return entry;
}

function normalizeWorkspaceSymbol(symbol) {
  if (!symbol || typeof symbol !== 'object') return null;
  const name = String(symbol.name ?? '');
  if (!name) return null;
  const loc = symbol.location ?? {};
  const uri = loc.uri ?? symbol.uri ?? '';
  return {
    name,
    kind: typeof symbol.kind === 'number' ? symbol.kind : 0,
    path: fileUriToRelativePath(String(uri)),
    range: normalizeLspRange(loc.range ?? symbol.range),
    containerName:
      symbol.containerName != null ? String(symbol.containerName) : undefined,
  };
}

function normalizeCallHierarchyItem(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name ?? '');
  if (!name) return null;
  const normalized = {
    name,
    kind: typeof item.kind === 'number' ? item.kind : 0,
    path: fileUriToRelativePath(String(item.uri ?? '')),
    range: normalizeLspRange(item.range),
    selectionRange: normalizeLspRange(item.selectionRange ?? item.range),
  };
  if (item.data !== undefined) normalized.data = item.data;
  return normalized;
}

function normalizeIncomingCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const from = normalizeCallHierarchyItem(call.from);
    if (!from) continue;
    out.push({
      from,
      fromRanges: (call.fromRanges ?? [])
        .map(normalizeLspRange)
        .filter(Boolean),
    });
  }
  return out;
}

function normalizeOutgoingCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const to = normalizeCallHierarchyItem(call.to);
    if (!to) continue;
    out.push({
      to,
      fromRanges: (call.fromRanges ?? [])
        .map(normalizeLspRange)
        .filter(Boolean),
    });
  }
  return out;
}

function extractCompletionInsertFields(item) {
  let insertText = String(item.insertText ?? item.label ?? '');
  let textEditRange;
  let textEditInsertRange;
  let textEditReplaceRange;
  const te = item.textEdit;
  if (te && typeof te === 'object') {
    if (te.insert != null && te.replace != null) {
      insertText = String(te.newText ?? insertText);
      textEditInsertRange = normalizeLspRange(te.insert);
      textEditReplaceRange = normalizeLspRange(te.replace);
      textEditRange = textEditReplaceRange;
    } else if (te.range != null && te.newText != null) {
      insertText = String(te.newText);
      textEditRange = normalizeLspRange(te.range);
    } else if (te.replace != null) {
      insertText = String(te.newText ?? insertText);
      textEditRange = normalizeLspRange(te.replace);
    }
  }
  return { insertText, textEditRange, textEditInsertRange, textEditReplaceRange };
}

function completionDedupKey(item) {
  return `${item.sortText ?? ''}\0${item.label}\0${item.detail ?? ''}\0${item.insertText}`;
}

function stableSortCompletionItems(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sa = a.item.sortText ?? a.item.label;
      const sb = b.item.sortText ?? b.item.label;
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function normalizeCompletionItems(result) {
  const raw = Array.isArray(result) ? result : (result?.items ?? []);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label ?? '');
    if (!label) continue;
    const { insertText, textEditRange, textEditInsertRange, textEditReplaceRange } =
      extractCompletionInsertFields(item);
    const entry = {
      label,
      insertText,
      kind: typeof item.kind === 'number' ? item.kind : undefined,
      detail: item.detail != null ? String(item.detail) : undefined,
    };
    if (textEditRange) entry.textEditRange = textEditRange;
    if (textEditInsertRange) entry.textEditInsertRange = textEditInsertRange;
    if (textEditReplaceRange) entry.textEditReplaceRange = textEditReplaceRange;
    const documentation = normalizeDocumentation(item.documentation);
    if (documentation !== undefined) entry.documentation = documentation;
    if (item.data !== undefined) entry.data = item.data;
    if (typeof item.insertTextFormat === 'number') {
      entry.insertTextFormat = item.insertTextFormat;
    }
    if (Array.isArray(item.additionalTextEdits) && item.additionalTextEdits.length > 0) {
      entry.additionalTextEdits = item.additionalTextEdits;
    }
    if (item.sortText != null) entry.sortText = String(item.sortText);
    if (item.filterText != null) entry.filterText = String(item.filterText);
    if (item.preselect === true) entry.preselect = true;
    if (Array.isArray(item.commitCharacters) && item.commitCharacters.length > 0) {
      entry.commitCharacters = item.commitCharacters.map(String);
    }
    out.push(entry);
  }
  return out;
}

function parseCompletionResult(result) {
  const isIncomplete = Boolean(
    result && typeof result === 'object' && !Array.isArray(result) && result.isIncomplete,
  );
  return { items: normalizeCompletionItems(result), isIncomplete };
}

function normalizeStructuredDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  const out = [];
  for (const d of diagnostics) {
    if (!d || typeof d !== 'object') continue;
    const start = d.range?.start ?? {};
    const end = d.range?.end ?? start;
    out.push({
      message: String(d.message ?? ''),
      severity: typeof d.severity === 'number' ? d.severity : 1,
      source: d.source != null ? String(d.source) : undefined,
      code: d.code != null ? String(d.code) : undefined,
      range: {
        start: {
          line: Number(start.line ?? 0),
          character: Number(start.character ?? 0),
        },
        end: {
          line: Number(end.line ?? start.line ?? 0),
          character: Number(end.character ?? start.character ?? 0),
        },
      },
    });
  }
  return out;
}

function formatLspSpawnError(serverId, bin, err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  if (code === 'ENOENT') {
    return (
      `LSP server "${serverId}" not found: "${bin}". ` +
      `Run npm install in the Minnow app folder, or disable "${serverId}" under Settings → Language servers.`
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return `LSP server "${serverId}" failed to start: ${message}`;
}

function spawnLspChild(argv, workspaceRoot = lspWorkspaceRoot()) {
  const [bin, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: applyNodeRuntimeEnv(
        buildLspProcessEnv(
          {
            ...process.env,
            MINNOW_APP_ROOT: APP_ROOT,
          },
          workspaceRoot,
        ),
        bin,
      ),
    });
    /** @type {string[]} */
    const stderrLines = [];
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      appendStderrLine(stderrLines, text);
      if (text.trim()) {
        console.error(`[lsp] stderr: ${text.trimEnd()}`);
      }
    });
    child.stderrLines = stderrLines;
    child.once('error', reject);
    child.once('spawn', () => resolve(child));
  });
}

function typescriptInitializationOptions() {
  const fallbackPath = tryResolveBundledTsserverPath();
  return {
    ...(fallbackPath ? { tsserver: { fallbackPath } } : {}),
    typescript: {
      implicitProjectConfiguration: {
        checkJs: true,
        module: 'ESNext',
        target: 'ES2022',
      },
    },
  };
}

function isSkippableWorkspaceSymbolError(message) {
  const text = String(message ?? '');
  if (/Unhandled method workspace\/symbol/i.test(text)) return true;
  if (/connection got disposed/i.test(text)) return true;
  if (/timed out after \d+ms/i.test(text)) return true;
  return false;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms]
 * @param {() => void} [onTimeout]
 */
function withRequestTimeout(promise, ms = DEFAULT_LSP_REQUEST_TIMEOUT_MS, onTimeout) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
      }
      reject(new Error(`LSP request timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * @template T
 * @param {import('vscode-jsonrpc').MessageConnection} connection
 * @param {string} method
 * @param {unknown} [params]
 * @param {number} [ms]
 */
async function sendLspRequest(connection, method, params, ms = DEFAULT_LSP_REQUEST_TIMEOUT_MS) {
  const cts = new CancellationTokenSource();
  try {
    const request =
      params === undefined
        ? connection.sendRequest(method, cts.token)
        : connection.sendRequest(method, params, cts.token);
    return await withRequestTimeout(request, ms, () => cts.cancel());
  } finally {
    cts.dispose();
  }
}

function recordLspBridgeError(message, extra = {}) {
  lastLspBridgeError = {
    message: String(message),
    at: new Date().toISOString(),
    ...extra,
  };
}

export function withRequestTimeoutForTest(promise, ms, onTimeout) {
  return withRequestTimeout(promise, ms, onTimeout);
}

export function getLspBridgeHealthSnapshot() {
  return { lastBridgeError: lastLspBridgeError };
}

function textDocumentSyncChangeKind(capabilities) {
  const cap = capabilities?.textDocumentSync;
  if (cap == null) return 1;
  if (typeof cap === 'number') {
    return cap === 2 ? 2 : 1;
  }
  if (typeof cap === 'object' && cap.change != null) {
    return Number(cap.change) === 2 ? 2 : 1;
  }
  return 1;
}

function offsetToLspPosition(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const head = text.slice(0, clamped);
  const lines = head.split('\n');
  const line = lines.length - 1;
  const character = lines[lines.length - 1]?.length ?? 0;
  return { line, character };
}

function buildDidChangeContentChanges(syncKind, previousText, nextText) {
  if (syncKind !== 2 || previousText === nextText) {
    return [{ text: nextText }];
  }
  let start = 0;
  const prevLen = previousText.length;
  const nextLen = nextText.length;
  while (
    start < prevLen &&
    start < nextLen &&
    previousText[start] === nextText[start]
  ) {
    start += 1;
  }
  let endPrev = prevLen;
  let endNext = nextLen;
  while (
    endPrev > start &&
    endNext > start &&
    previousText[endPrev - 1] === nextText[endNext - 1]
  ) {
    endPrev -= 1;
    endNext -= 1;
  }
  return [
    {
      range: {
        start: offsetToLspPosition(previousText, start),
        end: offsetToLspPosition(previousText, endPrev),
      },
      text: nextText.slice(start, endNext),
    },
  ];
}

export function buildDidChangeContentChangesForTest(syncKind, previousText, nextText) {
  return buildDidChangeContentChanges(syncKind, previousText, nextText);
}

function appendStderrLine(stderrLines, text) {
  stderrLines.push(text);
  while (stderrLines.length > MAX_LSP_STDERR_LINES) {
    stderrLines.shift();
  }
}

function trimDiagnosticSnapshotsLru(store) {
  while (store.diagnosticSnapshots.size > MAX_DIAGNOSTIC_SNAPSHOT_ENTRIES) {
    const oldest = store.diagnosticSnapshots.keys().next().value;
    if (oldest === undefined) break;
    store.diagnosticSnapshots.delete(oldest);
  }
}

function invalidateScopeLanguageServer(scope, serverId) {
  const store = getScopeStore(scope);
  store.diagnosticSnapshots.clear();
  store.documentSync.clear();
  for (const key of [...store.pendingConnections.keys()]) {
    if (matchesServerProcessKey(key, serverId)) {
      store.pendingConnections.delete(key);
    }
  }
  for (const key of [...store.processes.keys()]) {
    if (matchesServerProcessKey(key, serverId)) {
      const state = store.processes.get(key);
      if (state) discardLspState(scope, key, state);
    }
  }
}

function restartAgentTypescriptIfProjectChanged(projectRevision) {
  if (!projectRevision) return;
  const store = getScopeStore(LSP_SCOPE_AGENT);
  const processKey = connectionProcessKey(LSP_SCOPE_AGENT, 'typescript');
  const existing = store.processes.get(processKey);
  if (!existing?.projectRevision) return;
  if (existing.projectRevision === projectRevision) return;
  invalidateScopeLanguageServer(LSP_SCOPE_AGENT, 'typescript');
}

const DEFAULT_LSP_WORKSPACE_SECTIONS = {
  bashIde: {
    enableSourceErrorDiagnostics: true,
    shellcheckPath: 'shellcheck',
  },
  html: {
    validate: {
      scripts: true,
      styles: true,
    },
  },
  css: {
    validate: true,
  },
};

/**
 * @param {Record<string, unknown>} settings
 * @param {string | undefined} section
 */
function resolveWorkspaceConfigurationSection(settings, section) {
  if (section && settings[section] != null && typeof settings[section] === 'object') {
    return settings[section];
  }
  if (section && DEFAULT_LSP_WORKSPACE_SECTIONS[section]) {
    return DEFAULT_LSP_WORKSPACE_SECTIONS[section];
  }
  if (!section && Object.keys(settings).length > 0) {
    return settings;
  }
  return {};
}

function bindLspClientHandlers(connection, serverId, config) {
  connection.onRequest('workspace/configuration', (params) => {
    const settings =
      config?.settings && typeof config.settings === 'object' ? config.settings : {};
    const items = Array.isArray(params?.items) ? params.items : [];
    if (items.length === 0) {
      return [resolveWorkspaceConfigurationSection(settings, undefined)];
    }
    return items.map((item) =>
      resolveWorkspaceConfigurationSection(settings, item?.section),
    );
  });
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('client/unregisterCapability', () => null);
  connection.onRequest('window/workDoneProgress/cancel', () => null);
  connection.onNotification('window/logMessage', () => {});
  connection.onNotification('window/showMessage', () => {});
  connection.onNotification('$/progress', () => {});
  connection.onNotification('window/workDoneProgress/create', () => {});
}

function formatWorkspaceSymbolErrors(errors) {
  const joined = errors.join('; ');
  if (/No Project/i.test(joined)) {
    return `${joined} — add tsconfig.json or jsconfig.json at the workspace root (or reindex so Minnow can create .minnow/jsconfig.json), then try again.`;
  }
  return joined;
}

function discardLspState(scope, processKey, state) {
  getScopeStore(scope).processes.delete(processKey);
  try {
    state.connection?.dispose?.();
  } catch {
  }
  try {
    state.child?.kill();
  } catch {
  }
}

function bindLspProcessLifecycle(scope, serverId, processKey, state) {
  state.child.on('error', (err) => {
    console.error(`[lsp] ${serverId}:`, err instanceof Error ? err.message : err);
    discardLspState(scope, processKey, state);
  });
  state.child.on('exit', (code, signal) => {
    if (code !== 0 && code != null) {
      const detail = state.child.stderrLines?.join('').trim();
      console.error(
        `[lsp] ${serverId} exited with code ${code}${detail ? `: ${detail}` : ''}`,
      );
      void logChildProcessDiagnostic({
        kind: 'lsp-exit',
        message: `LSP server ${serverId} exited with code ${code}`,
        stack: detail || undefined,
        extra: { serverId, exitCode: code, scope },
      });
    } else if (signal) {
      console.error(`[lsp] ${serverId} exited on signal ${signal}`);
      void logChildProcessDiagnostic({
        kind: 'lsp-exit',
        message: `LSP server ${serverId} exited on signal ${signal}`,
        extra: { serverId, signal, scope },
      });
    }
    discardLspState(scope, processKey, state);
  });
}

function diagnosticWaiterKey(scope, serverId, fileUri) {
  return `${scope}::${serverId}::${fileUri}`;
}

function notifyDiagnosticWaiters(scope, serverId, fileUri, diagnostics) {
  const waiter = diagnosticWaiters.get(diagnosticWaiterKey(scope, serverId, fileUri));
  if (waiter) {
    waiter.onPublication(diagnostics);
  }
}

/**
 * @param {{ deferTotalTimer?: boolean }} [options]
 * @returns {{ promise: Promise<{ receivedAny: boolean, diagnostics: unknown[], reason: string }>, cancel: () => void, startTotalTimer: () => void, }}
 */
function createDiagnosticWaiter(scope, serverId, fileUri, options = {}) {
  const key = diagnosticWaiterKey(scope, serverId, fileUri);
  let receivedAny = false;
  let settled = false;
  let quietTimer = null;
  let totalTimer = null;
  let latestDiagnostics = [];
  /** @type {(value: { receivedAny: boolean, diagnostics: unknown[], reason: string }) => void} */
  let resolveSettled;

  const promise = new Promise((resolve) => {
    resolveSettled = resolve;
  });

  const settle = (reason) => {
    if (settled) return;
    settled = true;
    if (quietTimer) clearTimeout(quietTimer);
    if (totalTimer) clearTimeout(totalTimer);
    diagnosticWaiters.delete(key);
    resolveSettled({
      receivedAny,
      diagnostics: latestDiagnostics,
      reason,
    });
  };

  const waiter = {
    onPublication(diagnostics) {
      if (settled) return;
      receivedAny = true;
      latestDiagnostics = Array.isArray(diagnostics) ? diagnostics : [];
      if (quietTimer) clearTimeout(quietTimer);
      const quietMs =
        latestDiagnostics.length === 0
          ? Math.max(diagQuietPeriodMs, diagEmptyQuietPeriodMs)
          : diagQuietPeriodMs;
      quietTimer = setTimeout(() => settle('quiet'), quietMs);
    },
    cancel() {
      settle('cancelled');
    },
  };

  const startTotalTimer = () => {
    if (totalTimer != null || settled) return;
    totalTimer = setTimeout(() => {
      if (!receivedAny) {
        settle('timeout');
      } else {
        settle('total-timeout');
      }
    }, diagTotalTimeoutMs);
  };

  if (options.deferTotalTimer !== true) {
    startTotalTimer();
  }

  diagnosticWaiters.set(key, waiter);

  return { promise, cancel: () => waiter.cancel(), startTotalTimer };
}

function cancelAllDiagnosticWaiters() {
  for (const [, waiter] of diagnosticWaiters) {
    waiter.cancel?.();
  }
  diagnosticWaiters.clear();
}

async function connectLspServer(scope, serverId, config) {
  const workspaceRoot = lspWorkspaceRoot();
  const command = config.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(
      `LSP server "${serverId}" has no command. Install the language server or set lsp.${serverId}.command in ~/.minnow/lsp.json`,
    );
  }

  const { argv, displayBin } = resolveLspSpawnArgv(command);
  if (argv.length === 0) {
    throw new Error(
      `LSP server "${serverId}" has no command. Run npm install in the Minnow app folder or set lsp.${serverId}.command in ~/.minnow/lsp.json`,
    );
  }
  let child;
  try {
    child = await spawnLspChild(argv, workspaceRoot);
  } catch (err) {
    recordLspBridgeError(formatLspSpawnError(serverId, displayBin, err), {
      serverId,
      kind: 'spawn',
    });
    throw new Error(formatLspSpawnError(serverId, displayBin, err));
  }

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  const state = {
    connection,
    child,
    diagnostics: new Map(),
    ready: false,
    serverCapabilities: {},
    textDocumentSyncKind: 1,
    completionTriggerCharacters: [],
  };

  bindLspClientHandlers(connection, serverId, config);

  connection.onNotification('textDocument/publishDiagnostics', (params) => {
    const uri = normalizeFileUri(params?.uri);
    if (uri) {
      state.diagnostics.set(uri, params.diagnostics ?? []);
      notifyDiagnosticWaiters(scope, serverId, uri, params.diagnostics ?? []);
    }
  });

  const processKey = connectionProcessKey(scope, serverId);
  bindLspProcessLifecycle(scope, serverId, processKey, state);

  try {
    connection.listen();
    const initParams = {
      processId: process.pid,
      rootUri: workspaceRootUri(workspaceRoot),
      ...(serverId === 'typescript'
        ? { initializationOptions: typescriptInitializationOptions() }
        : {}),
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          references: {},
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          completion: {
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              resolveSupport: {
                properties: ['documentation', 'detail', 'additionalTextEdits'],
              },
            },
          },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          callHierarchy: {},
        },
        workspace: {
          symbol: {},
          configuration: true,
        },
      },
    };
    const initResult = await sendLspRequest(
      connection,
      'initialize',
      initParams,
      LSP_INITIALIZE_TIMEOUT_MS,
    );
    state.serverCapabilities =
      initResult && typeof initResult === 'object' && initResult.capabilities
        ? initResult.capabilities
        : {};
    state.textDocumentSyncKind = textDocumentSyncChangeKind(state.serverCapabilities);
    const completionProvider = state.serverCapabilities.completionProvider ?? {};
    state.completionTriggerCharacters = Array.isArray(completionProvider.triggerCharacters)
      ? completionProvider.triggerCharacters.map(String)
      : [];
    connection.sendNotification('initialized', {});
    state.ready = true;
    return state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordLspBridgeError(`[${serverId}] initialize failed: ${message}`, {
      serverId,
      kind: 'initialize',
    });
    discardLspState(scope, processKey, state);
    throw err;
  }
}

async function getConnection(scope, serverId, config) {
  const processKey = connectionProcessKey(scope, serverId);
  const store = getScopeStore(scope);
  if (store.processes.has(processKey)) {
    return touchLspProcess(store, processKey);
  }
  if (store.pendingConnections.has(processKey)) {
    return store.pendingConnections.get(processKey);
  }

  const connectPromise = connectLspServer(scope, serverId, config).then((state) => {
    state.lastUsedAt = Date.now();
    store.processes.set(processKey, state);
    evictLspProcessesLru(scope, store, processKey);
    return state;
  });
  store.pendingConnections.set(processKey, connectPromise);
  try {
    return await connectPromise;
  } finally {
    store.pendingConnections.delete(processKey);
  }
}

/**
 * @param {string} scope
 */
export async function notifyLspDocumentForScope(scope, relativePath, event, text) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return { ok: false, error: 'LSP is disabled' };
  }

  if (!relativePath || relativePath.includes('..')) {
    return { ok: false, error: 'Invalid path' };
  }

  const fileUri = toFileUri(relativePath);
  const store = getScopeStore(scope);
  const matchers = matchServersForPath(merged, relativePath);
  if (matchers.length === 0) {
    return { ok: false, error: `No LSP server configured for ${relativePath}` };
  }

  if (event === 'open') {
    const body = text ?? '';
    const existing = store.documentSync.get(fileUri);
    if (existing) {
      if (existing.text === body) {
        return { ok: true };
      }
      const previousText = existing.text;
      const nextVersion = existing.version + 1;
      store.documentSync.set(fileUri, { version: nextVersion, text: body });
      for (const { id, config } of matchers) {
        const state = await getConnection(scope, id, config);
        await state.connection.sendNotification('textDocument/didChange', {
          textDocument: { uri: fileUri, version: nextVersion },
          contentChanges: buildDidChangeContentChanges(
            state.textDocumentSyncKind ?? 1,
            previousText,
            body,
          ),
        });
      }
      return { ok: true };
    }
    store.documentSync.set(fileUri, { version: 1, text: body });
    for (const { id, config } of matchers) {
      const state = await getConnection(scope, id, config);
      await state.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId: guessLanguageId(relativePath),
          version: 1,
          text: body,
        },
      });
    }
    return { ok: true };
  }

  if (event === 'change') {
    const prev = store.documentSync.get(fileUri) ?? { version: 0, text: '' };
    const nextVersion = prev.version + 1;
    const nextText = text ?? prev.text;
    const previousText = prev.text;
    store.documentSync.set(fileUri, { version: nextVersion, text: nextText });
    for (const { id, config } of matchers) {
      const state = await getConnection(scope, id, config);
      await state.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri: fileUri, version: nextVersion },
        contentChanges: buildDidChangeContentChanges(
          state.textDocumentSyncKind ?? 1,
          previousText,
          nextText,
        ),
      });
    }
    return { ok: true };
  }

  if (event === 'close') {
    store.documentSync.delete(fileUri);
    for (const { id, config } of matchers) {
      const state = await getConnection(scope, id, config);
      state.diagnostics.delete(fileUri);
      await state.connection.sendNotification('textDocument/didClose', {
        textDocument: { uri: fileUri },
      });
    }
    return { ok: true };
  }

  return { ok: false, error: 'Invalid event' };
}

export async function notifyLspDocument(relativePath, event, text) {
  return notifyLspDocumentForScope(LSP_SCOPE_EDITOR, relativePath, event, text);
}

async function ensureDocumentSyncedForScope(scope, relativePath, options = {}) {
  const store = getScopeStore(scope);
  const fileUri = toFileUri(relativePath);
  const synced = store.documentSync.get(fileUri);
  if (synced) {
    if (options.diskText !== undefined && options.diskText !== synced.text) {
      await notifyLspDocumentForScope(scope, relativePath, 'change', options.diskText);
    } else if (options.editorText !== undefined && options.editorText !== synced.text) {
      await notifyLspDocumentForScope(scope, relativePath, 'change', options.editorText);
    } else if (options.forceChange === true) {
      await notifyLspDocumentForScope(scope, relativePath, 'change', synced.text);
    }
    return fileUri;
  }
  let body = options.diskText ?? options.editorText;
  if (body === undefined) {
    const fs = await import('node:fs/promises');
    const abs = path.resolve(lspWorkspaceRoot(), relativePath);
    body = await fs.readFile(abs, 'utf8').catch(() => '');
  }
  await notifyLspDocumentForScope(scope, relativePath, 'open', body);
  return fileUri;
}

/**
 * @param {string} relativePath
 * @param {{ editorText?: string }} [options]
 */
async function ensureDocumentSynced(relativePath, options = {}) {
  return ensureDocumentSyncedForScope(LSP_SCOPE_EDITOR, relativePath, options);
}

async function withLspMatchersForScope(scope, relativePath, handler, options = {}) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return { ok: false, error: 'LSP is disabled' };
  }
  if (!relativePath || relativePath.includes('..')) {
    return { ok: false, error: 'Invalid path' };
  }
  const matchers = matchServersForPath(merged, relativePath);
  if (matchers.length === 0) {
    return { ok: false, error: `No LSP server configured for ${relativePath}` };
  }
  const fileUri = await ensureDocumentSyncedForScope(scope, relativePath, options);
  return handler({ merged, matchers, fileUri });
}

async function withLspMatchers(relativePath, handler, options = {}) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return { ok: false, error: 'LSP is disabled' };
  }
  if (!relativePath || relativePath.includes('..')) {
    return { ok: false, error: 'Invalid path' };
  }
  const matchers = matchServersForPath(merged, relativePath);
  if (matchers.length === 0) {
    return { ok: false, error: `No LSP server configured for ${relativePath}` };
  }
  const fileUri = await ensureDocumentSynced(relativePath, options);
  return handler({ merged, matchers, fileUri });
}

async function withAllLspServers(handler) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return { ok: false, error: 'LSP is disabled' };
  }
  const servers = Object.entries(merged.lsp ?? {})
    .filter(
      ([, cfg]) =>
        cfg.disabled !== true &&
        Array.isArray(cfg.command) &&
        cfg.command.length > 0,
    )
    .map(([id, config]) => ({ id, config }));
  if (servers.length === 0) {
    return { ok: false, error: 'No LSP servers configured' };
  }
  return handler({ merged, servers });
}

/**
 * @param {string} relativePath
 * @param {number} line
 * @param {number} character
 * @param {{ text?: string, context?: { triggerKind?: number, triggerCharacter?: string } }} [options]
 */
export async function getLspCompletions(relativePath, line, character, options = {}) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return { items: [], error: 'LSP is disabled' };
  }

  if (!relativePath || relativePath.includes('..')) {
    return { items: [], error: 'Invalid path' };
  }

  const matchers = matchServersForPath(merged, relativePath);
  if (matchers.length === 0) {
    return { items: [], error: `No LSP server configured for ${relativePath}` };
  }

  const syncOpts =
    typeof options.text === 'string' ? { editorText: options.text } : {};
  const fileUri = await ensureDocumentSynced(relativePath, syncOpts);

  const completionParams = {
    textDocument: { uri: fileUri },
    position: { line, character },
  };
  const ctx = options.context;
  if (ctx && typeof ctx === 'object' && ctx.triggerKind != null) {
    completionParams.context = {
      triggerKind: Number(ctx.triggerKind),
      ...(ctx.triggerCharacter != null
        ? { triggerCharacter: String(ctx.triggerCharacter) }
        : {}),
    };
  }

  const seen = new Set();
  const items = [];
  const triggerCharacters = new Set();
  let isIncomplete = false;

  for (const { id, config } of matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      for (const ch of state.completionTriggerCharacters ?? []) {
        triggerCharacters.add(ch);
      }
      const result = await sendLspRequest(
        state.connection,
        'textDocument/completion',
        completionParams,
        LSP_COMPLETION_TIMEOUT_MS,
      );
      const parsed = parseCompletionResult(result);
      if (parsed.isIncomplete) isIncomplete = true;
      for (const item of parsed.items) {
        const key = completionDedupKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordLspBridgeError(`[${id}] completion: ${message}`, { serverId: id, kind: 'request' });
      return {
        items,
        isIncomplete,
        triggerCharacters: [...triggerCharacters],
        error: `[${id}] ${message}`,
      };
    }
  }

  return {
    items: stableSortCompletionItems(items),
    isIncomplete,
    triggerCharacters: [...triggerCharacters],
  };
}

export async function getLspDiagnostics(relativePath) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return 'Error: LSP is disabled in settings.';
  }

  if (!relativePath || relativePath.includes('..')) {
    return 'Error: Invalid path.';
  }

  const matchers = matchServersForPath(merged, relativePath);
  if (matchers.length === 0) {
    // The only question `list_lsp_servers` ever answered for an agent was "why
    // did this file get nothing back", so answer it here instead of shipping a
    // second tool whose schema every agent pays for on every turn.
    const available = Object.entries(merged.lsp ?? {})
      .filter(([, cfg]) => cfg?.disabled !== true && Array.isArray(cfg?.command) && cfg.command.length > 0)
      .map(([id, cfg]) => `${id} (${(cfg.extensions ?? []).join(' ') || 'no extensions'})`);
    const suffix = available.length
      ? ` Configured and enabled: ${available.join(', ')}.`
      : ' No language server is enabled — add one in Settings → LSP.';
    return `No LSP server configured for ${relativePath}.${suffix}`;
  }

  const fs = await import('node:fs/promises');
  const workspaceRoot = lspWorkspaceRoot();
  const abs = path.resolve(workspaceRoot, relativePath);
  let diskText;
  try {
    diskText = await fs.readFile(abs, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
    if (code === 'ENOENT') {
      return `Error: File not found: ${relativePath}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }

  const revision = contentRevision(diskText);
  const usesTypescript = matchers.some((m) => m.id === 'typescript');
  const projectRevision = usesTypescript
    ? await hashTypeScriptProjectFingerprint(relativePath, workspaceRoot)
    : '';
  const fileUri = toFileUri(relativePath, workspaceRoot);
  const agentStore = getScopeStore(LSP_SCOPE_AGENT);
  const cached = agentStore.diagnosticSnapshots.get(fileUri);
  if (
    cached &&
    cached.revision === revision &&
    cached.projectRevision === projectRevision
  ) {
    return cached.formatted;
  }

  if (usesTypescript) {
    restartAgentTypescriptIfProjectChanged(projectRevision);
  }

  const parts = [];
  for (const { id, config } of matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_AGENT, id, config);
      if (id === 'typescript') {
        state.projectRevision = projectRevision;
      }

      const waitAfterSync = async () => {
        const { promise, cancel, startTotalTimer } = createDiagnosticWaiter(
          LSP_SCOPE_AGENT,
          id,
          fileUri,
          { deferTotalTimer: true },
        );
        try {
          await ensureDocumentSyncedForScope(LSP_SCOPE_AGENT, relativePath, {
            diskText,
            forceChange: true,
          });
          startTotalTimer();
          return await promise;
        } catch (err) {
          cancel();
          throw err;
        }
      };

      let settled = await waitAfterSync();
      if (!settled.receivedAny) {
        settled = await waitAfterSync();
      }

      const liveState = await getConnection(LSP_SCOPE_AGENT, id, config);
      const diags =
        settled.receivedAny === true
          ? settled.diagnostics
          : (liveState.diagnostics.get(fileUri) ?? []);
      if (diags.length === 0) {
        parts.push(`No LSP diagnostics for ${relativePath} (${id}).`);
      } else {
        parts.push(formatDiagnostics(`${relativePath} (${id})`, diags));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parts.push(`[${id}] Error: ${message}`);
    }
  }

  const formatted = parts.join('\n\n');
  agentStore.diagnosticSnapshots.set(fileUri, {
    revision,
    projectRevision,
    formatted,
  });
  trimDiagnosticSnapshotsLru(agentStore);
  return formatted;
}

/**
 * @param {string} relativePath
 * @param {string} [editorText]
 */
export async function getLspStructuredDiagnostics(relativePath, editorText) {
  const merged = await loadMergedLspConfig();
  if (merged.enabled === false) {
    return { diagnostics: [], error: 'LSP is disabled' };
  }
  if (!relativePath || relativePath.includes('..')) {
    return { diagnostics: [], error: 'Invalid path' };
  }
  const matchers = matchServersForPath(merged, relativePath);
  if (matchers.length === 0) {
    return { diagnostics: [], error: `No LSP server configured for ${relativePath}` };
  }

  const fileUri = toFileUri(relativePath);
  const syncOpts =
    typeof editorText === 'string' ? { editorText } : {};

  const waiters = matchers.map(({ id }) => {
    const { promise, cancel } = createDiagnosticWaiter(LSP_SCOPE_EDITOR, id, fileUri);
    return { id, promise, cancel };
  });

  try {
    await Promise.all(
      matchers.map(async ({ id, config }) => getConnection(LSP_SCOPE_EDITOR, id, config)),
    );
    await ensureDocumentSyncedForScope(LSP_SCOPE_EDITOR, relativePath, {
      ...syncOpts,
      forceChange: true,
    });

    const settled = await Promise.all(waiters.map((w) => w.promise));

    const parts = [];
    for (let i = 0; i < matchers.length; i += 1) {
      const { id, config } = matchers[i];
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      const waiterResult = settled[i];
      const diags =
        waiterResult?.receivedAny === true
          ? waiterResult.diagnostics
          : (state.diagnostics.get(fileUri) ?? []);
      parts.push(...normalizeStructuredDiagnostics(diags));
    }
    return { diagnostics: parts };
  } catch (err) {
    for (const w of waiters) w.cancel();
    const message = err instanceof Error ? err.message : String(err);
    recordLspBridgeError(message, { kind: 'diagnostics' });
    return { diagnostics: [], error: message };
  }
}

export async function getLspHover(relativePath, line, character) {
  const ctx = await withLspMatchers(relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }));
  if (!ctx.ok) {
    return { hover: null, error: ctx.error };
  }

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      const hover = await sendLspRequest(
        state.connection,
        'textDocument/hover',
        {
          textDocument: { uri: ctx.fileUri },
          position: { line, character },
        },
        LSP_HOVER_TIMEOUT_MS,
      );
      return { hover: hover ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordLspBridgeError(`[${id}] hover: ${message}`, { serverId: id, kind: 'request' });
      return { hover: null, error: `[${id}] ${message}` };
    }
  }
  return { hover: null };
}

export async function getLspDefinition(relativePath, line, character) {
  const ctx = await withLspMatchers(relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }));
  if (!ctx.ok) {
    return { locations: [], error: ctx.error };
  }

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      const result = await sendLspRequest(
        state.connection,
        'textDocument/definition',
        {
          textDocument: { uri: ctx.fileUri },
          position: { line, character },
        },
        LSP_DEFINITION_TIMEOUT_MS,
      );
      if (result != null) {
        return { locations: result };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordLspBridgeError(`[${id}] definition: ${message}`, { serverId: id, kind: 'request' });
      return { locations: [], error: `[${id}] ${message}` };
    }
  }
  return { locations: [] };
}

export async function getLspSignatureHelp(relativePath, line, character) {
  const ctx = await withLspMatchers(relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }));
  if (!ctx.ok) {
    return { signatureHelp: null, error: ctx.error };
  }

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      const signatureHelp = await sendLspRequest(
        state.connection,
        'textDocument/signatureHelp',
        {
          textDocument: { uri: ctx.fileUri },
          position: { line, character },
        },
        LSP_SIGNATURE_TIMEOUT_MS,
      );
      return { signatureHelp: signatureHelp ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordLspBridgeError(`[${id}] signature: ${message}`, { serverId: id, kind: 'request' });
      return { signatureHelp: null, error: `[${id}] ${message}` };
    }
  }
  return { signatureHelp: null };
}

export async function getLspDocumentSymbols(relativePath) {
  return getLspDocumentSymbolsForScope(LSP_SCOPE_EDITOR, relativePath);
}

/**
 * @param {string} scope
 * @param {string} relativePath
 */
export async function getLspDocumentSymbolsForScope(scope, relativePath) {
  const ctx = await withLspMatchersForScope(scope, relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }));
  if (!ctx.ok) {
    return { symbols: [], error: ctx.error };
  }

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(scope, id, config);
      const result = await sendLspRequest(
        state.connection,
        'textDocument/documentSymbol',
        {
          textDocument: { uri: ctx.fileUri },
        },
      );
      const raw = Array.isArray(result) ? result : [];
      const symbols = raw.map(normalizeDocumentSymbol).filter(Boolean);
      return { symbols };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { symbols: [], error: `[${id}] ${message}` };
    }
  }
  return { symbols: [] };
}

export async function getLspWorkspaceSymbols(query) {
  const q = String(query ?? '');
  const ctx = await withAllLspServers(async ({ servers }) => ({ ok: true, servers }));
  if (!ctx.ok) {
    return { symbols: [], error: ctx.error };
  }

  const seen = new Set();
  const symbols = [];
  const errors = [];
  for (const { id, config } of ctx.servers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      if (!serverSupportsWorkspaceSymbols(id, config, state.serverCapabilities)) {
        continue;
      }
      const result = await sendLspRequest(
        state.connection,
        'workspace/symbol',
        {
          query: q,
        },
      );
      const raw = Array.isArray(result) ? result : [];
      for (const sym of raw) {
        const normalized = normalizeWorkspaceSymbol(sym);
        if (!normalized) continue;
        const key = `${normalized.path}:${normalized.name}:${normalized.range?.start?.line ?? 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push(normalized);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isSkippableWorkspaceSymbolError(message)) continue;
      errors.push(`[${id}] ${message}`);
    }
  }
  if (symbols.length === 0 && errors.length > 0) {
    return { symbols: [], error: formatWorkspaceSymbolErrors(errors) };
  }
  return { symbols, ...(errors.length > 0 ? { warnings: errors } : {}) };
}

/**
 * @param {string} relativePath
 * @param {number} line
 * @param {number} character
 * @param {{ scope?: string, includeIncoming?: boolean }} [options]
 */
export async function getLspCallHierarchy(relativePath, line, character, options = {}) {
  const scope = options.scope ?? LSP_SCOPE_EDITOR;
  const includeIncoming = options.includeIncoming !== false;
  const ctx = await withLspMatchersForScope(scope, relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }));
  if (!ctx.ok) {
    return {
      item: null,
      incomingCalls: [],
      outgoingCalls: [],
      error: ctx.error,
    };
  }

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(scope, id, config);
      const prepared = await sendLspRequest(
        state.connection,
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: ctx.fileUri },
          position: { line, character },
        },
        LSP_DEFINITION_TIMEOUT_MS,
      );
      const items = Array.isArray(prepared) ? prepared : prepared ? [prepared] : [];
      if (items.length === 0) {
        return { item: null, incomingCalls: [], outgoingCalls: [] };
      }
      const rawItem = items[0];
      const outgoingRaw = await sendLspRequest(
        state.connection,
        'callHierarchy/outgoingCalls',
        { item: rawItem },
        LSP_DEFINITION_TIMEOUT_MS,
      );
      let incomingRaw = [];
      if (includeIncoming) {
        incomingRaw = await sendLspRequest(
          state.connection,
          'callHierarchy/incomingCalls',
          { item: rawItem },
          LSP_DEFINITION_TIMEOUT_MS,
        );
      }
      return {
        item: normalizeCallHierarchyItem(rawItem),
        incomingCalls: normalizeIncomingCalls(incomingRaw),
        outgoingCalls: normalizeOutgoingCalls(outgoingRaw),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        item: null,
        incomingCalls: [],
        outgoingCalls: [],
        error: `[${id}] ${message}`,
      };
    }
  }
  return { item: null, incomingCalls: [], outgoingCalls: [] };
}

function normalizeTextEdits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const edit of raw) {
    if (!edit || typeof edit !== 'object') continue;
    const range = edit.range;
    if (!range || typeof range !== 'object') continue;
    const start = range.start;
    const end = range.end;
    if (!start || !end) continue;
    out.push({
      range: {
        start: { line: Number(start.line) || 0, character: Number(start.character) || 0 },
        end: { line: Number(end.line) || 0, character: Number(end.character) || 0 },
      },
      newText: typeof edit.newText === 'string' ? edit.newText : '',
    });
  }
  return out;
}

/**
 * @param {string} relativePath
 * @param {{ editorText?: string, tabSize?: number, insertSpaces?: boolean }} [options]
 */
export async function getLspDocumentFormatting(relativePath, options = {}) {
  const ctx = await withLspMatchers(relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }), { editorText: options.editorText });
  if (!ctx.ok) {
    return { edits: [], error: ctx.error };
  }

  const tabSize = Number.isFinite(options.tabSize) ? options.tabSize : 2;
  const insertSpaces = options.insertSpaces !== false;
  const formatOptions = { tabSize, insertSpaces };

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      if (!serverSupportsDocumentFormatting(state.serverCapabilities)) {
        continue;
      }
      const edits = await sendLspRequest(
        state.connection,
        'textDocument/formatting',
        {
          textDocument: { uri: ctx.fileUri },
          options: formatOptions,
        },
        LSP_FORMAT_TIMEOUT_MS,
      );
      return { edits: normalizeTextEdits(edits), serverId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordLspBridgeError(`[${id}] formatting: ${message}`, { serverId: id, kind: 'request' });
      return { edits: [], error: `[${id}] ${message}` };
    }
  }
  return { edits: [], error: 'No document formatting provider for this file' };
}

/**
 * @param {string} relativePath
 * @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} range
 * @param {{ editorText?: string, tabSize?: number, insertSpaces?: boolean }} [options]
 */
export async function getLspRangeFormatting(relativePath, range, options = {}) {
  const ctx = await withLspMatchers(relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }), { editorText: options.editorText });
  if (!ctx.ok) {
    return { edits: [], error: ctx.error };
  }

  const tabSize = Number.isFinite(options.tabSize) ? options.tabSize : 2;
  const insertSpaces = options.insertSpaces !== false;
  const formatOptions = { tabSize, insertSpaces };

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      if (!serverSupportsRangeFormatting(state.serverCapabilities)) {
        continue;
      }
      const edits = await sendLspRequest(
        state.connection,
        'textDocument/rangeFormatting',
        {
          textDocument: { uri: ctx.fileUri },
          range,
          options: formatOptions,
        },
        LSP_FORMAT_TIMEOUT_MS,
      );
      return { edits: normalizeTextEdits(edits), serverId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordLspBridgeError(`[${id}] rangeFormatting: ${message}`, {
        serverId: id,
        kind: 'request',
      });
      return { edits: [], error: `[${id}] ${message}` };
    }
  }
  return { edits: [], error: 'No range formatting provider for this file' };
}

export async function resolveLspCompletion(relativePath, item) {
  const ctx = await withLspMatchers(relativePath, async ({ matchers, fileUri }) => ({
    ok: true,
    matchers,
    fileUri,
  }));
  if (!ctx.ok) {
    return { item: null, error: ctx.error };
  }
  if (!item || typeof item !== 'object') {
    return { item: null, error: 'Invalid completion item' };
  }

  for (const { id, config } of ctx.matchers) {
    try {
      const state = await getConnection(LSP_SCOPE_EDITOR, id, config);
      const resolved = await sendLspRequest(
        state.connection,
        'completionItem/resolve',
        item,
        LSP_COMPLETION_TIMEOUT_MS,
      );
      const [normalized] = normalizeCompletionItems([resolved]);
      return { item: normalized ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { item: null, error: `[${id}] ${message}` };
    }
  }
  return { item: null };
}

function formatRequirements(requirements) {
  if (!requirements || typeof requirements !== 'object') return undefined;
  const bits = [];
  if (requirements.package) {
    bits.push(`npm package ${requirements.package}`);
  }
  if (requirements.binary) {
    bits.push(`binary ${requirements.binary}`);
  }
  if (requirements.command) {
    bits.push(`command ${requirements.command}`);
  }
  if (bits.length === 0) return undefined;
  return `Requires: ${bits.join(', ')}`;
}

function deriveDisabledReason(cfg, { disabled, hasCommand, running }) {
  if (running) return undefined;
  const parts = [];
  if (disabled) {
    parts.push('Disabled in settings');
  }
  if (!hasCommand && !disabled) {
    parts.push(
      'No command configured — add command in ~/.minnow/lsp.json or install tooling',
    );
  }
  const reqLine = formatRequirements(cfg.requirements);
  if (reqLine) parts.push(reqLine);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export async function listLspServers() {
  const merged = await loadMergedLspConfig();
  const builtinIds = await getBuiltinLspIds();
  return Object.entries(merged.lsp ?? {}).map(([id, cfg]) => {
    const disabled = cfg.disabled === true;
    const hasCommand = Array.isArray(cfg.command) && cfg.command.length > 0;
    // Every scope now keys processes as `${id}::${root}`, so match on the prefix
    // rather than the bare id (which older builds used for the editor scope).
    const editorRunning = [...getScopeStore(LSP_SCOPE_EDITOR).processes.keys()].some(
      (key) => matchesServerProcessKey(key, id),
    );
    const agentRunning = [...getScopeStore(LSP_SCOPE_AGENT).processes.keys()].some(
      (key) => matchesServerProcessKey(key, id),
    );
    const running = editorRunning || agentRunning;
    const requirements =
      cfg.requirements && typeof cfg.requirements === 'object'
        ? cfg.requirements
        : undefined;
    return {
      id,
      label: cfg.label ?? id,
      disabled,
      running,
      extensions: cfg.extensions ?? [],
      builtin: builtinIds.has(id),
      hasCommand,
      requirements,
      disabledReason: deriveDisabledReason(cfg, { disabled, hasCommand, running }),
      defaultEnabled: cfg.defaultEnabled === true,
    };
  });
}

export function getLspDocumentSyncForTest(relativePath, scope = LSP_SCOPE_EDITOR) {
  const fileUri = toFileUri(relativePath);
  const entry = getScopeStore(scope).documentSync.get(fileUri);
  if (!entry) return null;
  return { version: entry.version, text: entry.text };
}

export function getLspDiagnosticsMapForTest(
  relativePath,
  serverId = 'fake',
  scope = LSP_SCOPE_EDITOR,
) {
  const fileUri = toFileUri(relativePath);
  const processKey = connectionProcessKey(scope, serverId);
  const state = getScopeStore(scope).processes.get(processKey);
  if (!state) return undefined;
  return state.diagnostics.get(fileUri);
}

export function setLspDiagnosticWaitForTest({
  quietPeriodMs,
  emptyQuietPeriodMs,
  totalTimeoutMs,
} = {}) {
  if (quietPeriodMs != null) diagQuietPeriodMs = quietPeriodMs;
  if (emptyQuietPeriodMs != null) diagEmptyQuietPeriodMs = emptyQuietPeriodMs;
  if (totalTimeoutMs != null) diagTotalTimeoutMs = totalTimeoutMs;
}

export function resetLspDiagnosticWaitForTest() {
  diagQuietPeriodMs = DEFAULT_DIAG_QUIET_PERIOD_MS;
  diagEmptyQuietPeriodMs = DEFAULT_DIAG_EMPTY_QUIET_PERIOD_MS;
  diagTotalTimeoutMs = DEFAULT_DIAG_TOTAL_TIMEOUT_MS;
}

function matchesServerProcessKey(processKey, serverId) {
  return processKey === serverId || processKey.startsWith(`${serverId}::`);
}

export function shutdownLspServers(serverIds) {
  const ids = new Set(serverIds.map((id) => String(id)));
  for (const scope of [LSP_SCOPE_EDITOR, LSP_SCOPE_AGENT, LSP_SCOPE_INDEX]) {
    const store = getScopeStore(scope);
    for (const id of ids) {
      for (const key of [...store.pendingConnections.keys()]) {
        if (matchesServerProcessKey(key, id)) {
          store.pendingConnections.delete(key);
        }
      }
      for (const key of [...store.processes.keys()]) {
        if (matchesServerProcessKey(key, id)) {
          const state = store.processes.get(key);
          if (state) discardLspState(scope, key, state);
        }
      }
    }
  }
}

export function shutdownAllLsp() {
  cancelAllDiagnosticWaiters();
  for (const scope of [LSP_SCOPE_EDITOR, LSP_SCOPE_AGENT, LSP_SCOPE_INDEX]) {
    const store = getScopeStore(scope);
    store.pendingConnections.clear();
    for (const [id, state] of store.processes) {
      discardLspState(scope, id, state);
    }
    store.processes.clear();
    store.documentSync.clear();
    store.diagnosticSnapshots.clear();
  }
}
