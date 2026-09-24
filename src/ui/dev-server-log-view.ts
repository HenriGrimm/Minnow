import { fetchTerminalLog, streamTerminalRun } from '../api/terminal';
import { stripAnsi } from '../lib/strip-ansi';
import { getActiveChat, scheduleSaveSessions } from '../state/sessions';
import type { TerminalRunRecord } from '../types';
import { appendConsoleOutputWithLinks } from './terminal-console-links';

const MAX_DISPLAY_BYTES = 512_000;
const MAX_TERMINAL_HISTORY = 40;

/** Persist finished runs on the active chat so they still appear in terminal history. */
function upsertChatTerminalRun(
  chat: { terminalHistory?: TerminalRunRecord[] },
  record: TerminalRunRecord,
): void {
  const history = chat.terminalHistory ?? [];
  chat.terminalHistory = [record, ...history.filter((r) => r.id !== record.id)].slice(
    0,
    MAX_TERMINAL_HISTORY,
  );
}

interface ServerLogBuffer {
  el: HTMLElement;
  displayBytes: number;
  stickToBottom: boolean;
  abort: AbortController | null;
  runId: string | null;
  label: string;
}

const buffers = new Map<string, ServerLogBuffer>();
let activeServerId: string | null = null;
let tabsHost: HTMLElement | null = null;
let outputHost: HTMLElement | null = null;
let filterText = '';
let wrapLines = true;

function syncEmptyState(hasServers: boolean): void {
  if (!outputHost) return;
  let empty = outputHost.querySelector<HTMLElement>('[data-role="log-empty"]');
  if (hasServers) {
    empty?.remove();
    return;
  }
  if (empty) return;
  empty = document.createElement('div');
  empty.className = 'dev-server-log__empty';
  empty.dataset.role = 'log-empty';
  empty.innerHTML = '<strong>No server output</strong><span>Start or add a server to stream its logs here.</span>';
  outputHost.appendChild(empty);
}

function scrollIfPinned(buf: ServerLogBuffer): void {
  if (!buf.stickToBottom) return;
  buf.el.scrollTop = buf.el.scrollHeight;
}

function appendText(buf: ServerLogBuffer, text: string, stream: 'stdout' | 'stderr'): void {
  const plain = stripAnsi(text);
  if (!plain) return;
  const addBytes = new TextEncoder().encode(plain).length;
  if (buf.displayBytes + addBytes > MAX_DISPLAY_BYTES) {
    if (!buf.el.dataset.truncated) {
      buf.el.appendChild(document.createTextNode('\n…[truncated]\n'));
      buf.el.dataset.truncated = '1';
    }
    return;
  }
  buf.displayBytes += addBytes;
  appendConsoleOutputWithLinks(buf.el, plain, { stderr: stream === 'stderr' });
  scrollIfPinned(buf);
  applyFilterToActive();
}

function applyFilterToActive(): void {
  if (!activeServerId) return;
  const buf = buffers.get(activeServerId);
  if (!buf) return;
  const q = filterText.trim().toLowerCase();
  buf.el.classList.toggle('dev-server-log__output--wrap', wrapLines);
  if (!q) {
    buf.el.querySelectorAll('.dev-server-log__line-hidden').forEach((n) => {
      n.classList.remove('dev-server-log__line-hidden');
    });
    return;
  }
  for (const node of Array.from(buf.el.childNodes)) {
    const text = node.textContent?.toLowerCase() ?? '';
    if (node instanceof HTMLElement) {
      node.classList.toggle('dev-server-log__line-hidden', !text.includes(q));
    }
  }
}

function ensureBuffer(serverId: string): ServerLogBuffer {
  let buf = buffers.get(serverId);
  if (buf) return buf;
  const el = document.createElement('pre');
  el.className = 'dev-server-log__output mono';
  el.hidden = true;
  el.addEventListener('scroll', () => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    buf!.stickToBottom = distance < 48;
  });
  outputHost?.appendChild(el);
  buf = {
    el,
    displayBytes: 0,
    stickToBottom: true,
    abort: null,
    runId: null,
    label: '',
  };
  buffers.set(serverId, buf);
  return buf;
}

function renderTabs(serverIds: { id: string; name: string }[]): void {
  if (!tabsHost) return;
  tabsHost.replaceChildren();
  for (const s of serverIds) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dev-server-log__tab';
    btn.dataset.serverId = s.id;
    btn.textContent = s.name;
    btn.classList.toggle('is-active', s.id === activeServerId);
    btn.addEventListener('click', () => {
      setActiveLogServer(s.id);
    });
    tabsHost.appendChild(btn);
  }
}

/** Mount log chrome into hosts (tabs + output). */
export function initDevServerLogView(opts: {
  tabsEl: HTMLElement;
  outputEl: HTMLElement;
}): void {
  tabsHost = opts.tabsEl;
  outputHost = opts.outputEl;
}

export function setLogFilter(text: string): void {
  filterText = text;
  applyFilterToActive();
}

export function setLogWrap(wrap: boolean): void {
  wrapLines = wrap;
  applyFilterToActive();
}

export function clearActiveLog(): void {
  if (!activeServerId) return;
  const buf = buffers.get(activeServerId);
  if (!buf) return;
  buf.el.textContent = '';
  delete buf.el.dataset.truncated;
  buf.displayBytes = 0;
}

export function setActiveLogServer(serverId: string): void {
  activeServerId = serverId;
  for (const [id, buf] of buffers) {
    buf.el.hidden = id !== serverId;
  }
  if (tabsHost) {
    for (const btn of tabsHost.querySelectorAll<HTMLElement>('.dev-server-log__tab')) {
      btn.classList.toggle('is-active', btn.dataset.serverId === serverId);
    }
  }
  applyFilterToActive();
}

/** Sync tab list and attach/detach streams for each server's runId. */
export async function syncDevServerLogs(
  servers: { id: string; name: string; runId: string | null; command: string | null }[],
): Promise<void> {
  syncEmptyState(servers.length > 0);
  renderTabs(servers.map((s) => ({ id: s.id, name: s.name })));
  if (!activeServerId || !servers.some((s) => s.id === activeServerId)) {
    activeServerId = servers[0]?.id ?? null;
  }
  if (activeServerId) setActiveLogServer(activeServerId);

  const liveIds = new Set(servers.map((s) => s.id));
  for (const id of [...buffers.keys()]) {
    if (!liveIds.has(id)) {
      stopServerStream(id);
      const buf = buffers.get(id);
      buf?.el.remove();
      buffers.delete(id);
    }
  }

  for (const s of servers) {
    const buf = ensureBuffer(s.id);
    buf.label = s.command ?? s.name;
    if (!s.runId) {
      if (buf.runId) stopServerStream(s.id);
      if (buf.displayBytes === 0) {
        appendText(buf, `[${s.name} is not running. Start it to see output.]\n`, 'stdout');
      }
      continue;
    }
    if (buf.runId === s.runId && buf.abort) continue;
    await attachServerStream(s.id, s.runId, s.command ?? s.name);
  }
}

async function attachServerStream(serverId: string, runId: string, label: string): Promise<void> {
  const buf = ensureBuffer(serverId);
  stopServerStream(serverId);
  buf.runId = runId;
  buf.label = label;
  buf.el.textContent = '';
  delete buf.el.dataset.truncated;
  buf.displayBytes = 0;
  buf.stickToBottom = true;

  const prior = await fetchTerminalLog(runId);
  if (prior) {
    appendText(buf, prior.endsWith('\n') ? prior : `${prior}\n`, 'stdout');
  } else {
    appendText(buf, `$ ${label}\n`, 'stdout');
  }

  const abort = new AbortController();
  buf.abort = abort;
  const chatId = getActiveChat()?.id ?? '';

  void (async () => {
    let finished = false;
    let exitCode: number | null = null;
    let timedOut = false;
    try {
      await streamTerminalRun(
        runId,
        (ev) => {
          if (buffers.get(serverId)?.runId !== runId) return;
          if (ev.type === 'stdout') appendText(buf, ev.text, 'stdout');
          else if (ev.type === 'stderr') appendText(buf, ev.text, 'stderr');
          else if (ev.type === 'exit') {
            finished = true;
            exitCode = ev.code;
            timedOut = ev.timedOut;
            appendText(
              buf,
              `\n[exit ${ev.code ?? '?'}${ev.timedOut ? ', timed out' : ''}]\n`,
              'stderr',
            );
          } else if (ev.type === 'error') {
            appendText(buf, `\nError: ${ev.message}\n`, 'stderr');
          }
        },
        abort.signal,
      );
    } catch (err) {
      if (!abort.signal.aborted) {
        appendText(buf, `\nError: ${err instanceof Error ? err.message : String(err)}\n`, 'stderr');
      }
    } finally {
      if (buf.abort === abort) buf.abort = null;
    }

    if (!finished || abort.signal.aborted || !chatId) return;
    const chat = getActiveChat();
    if (chat?.id !== chatId) return;
    upsertChatTerminalRun(chat, {
      id: runId,
      command: label,
      cwd: '.',
      source: 'agent',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      exitCode,
      timedOut,
      logPath: `logs/dev-server/${runId}.log`,
    });
    scheduleSaveSessions();
  })();
}

function stopServerStream(serverId: string): void {
  const buf = buffers.get(serverId);
  if (!buf) return;
  buf.abort?.abort();
  buf.abort = null;
  buf.runId = null;
}

/** Tear down all streams when the screen closes. */
export function teardownDevServerLogView(): void {
  for (const id of [...buffers.keys()]) {
    stopServerStream(id);
    buffers.get(id)?.el.remove();
    buffers.delete(id);
  }
  activeServerId = null;
  tabsHost = null;
  outputHost = null;
  filterText = '';
}
