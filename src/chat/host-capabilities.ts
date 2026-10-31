import type { HostToolEnvelope, HostToolCancel, HostToolResult } from '../../server/chats/host-capabilities';
import type { ExecuteToolContext } from '../tools/client';
import type { ToolDefinition } from '../tools/definitions';
import { createServerToolAdmission } from '../tools/server-admission';

type Response = { hostId: string; invocationId: string; result?: HostToolResult; indeterminate?: true };
type Receipt = { version: 1; inputHash: string; fingerprint: string; state: 'started' | 'done'; at: number; result?: HostToolResult; acknowledged?: boolean };
const PREFIX = 'minnow.hostTool.v1.';
const MAX_RESULT = 2 * 1024 * 1024 - 4096;
const MAX_INPUT = 256 * 1024;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const managedTools = new Set(['set_chat_mode', 'create_chat_with_mode', 'propose_mode_switch', 'todo_write',
  'ask_question', 'spawn_sub_agent', 'cancel_sub_agent', 'list_sub_agents', 'get_sub_agent_status']);
const browserTools = new Set(['browser_reserve_tab', 'browser_release_tab', 'browser_list', 'browser_navigate', 'browser_new_tab',
  'browser_switch_tab', 'browser_close_tab', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_eval', 'browser_screenshot']);

/** Advertise actual client handlers; managed chat mutations require server transactions. */
export function chatHostToolCapabilities(catalog: readonly ToolDefinition[], desktopReady: boolean): string[] {
  return catalog.filter(tool => !managedTools.has(tool.definition.function.name) &&
    (browserTools.has(tool.definition.function.name) ? desktopReady : !tool.serverRequired && (!tool.previewRequired || desktopReady)))
    .map(tool => `tool:${tool.definition.function.name}`).sort();
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The started marker is committed before invoking the normal tool executor.
 * A reload with only that marker is indeterminate, never permission to repeat.
 * Done receipts survive a lost HTTP acknowledgement and are returned verbatim.
 */
export function createChatHostCapabilityProcessor(options: {
  hostId: string; capabilities: readonly string[]; storage: Storage;
  execute(name: string, args: Record<string, unknown>, context: ExecuteToolContext): Promise<HostToolResult>;
  respond(response: Response): Promise<unknown>;
  now?: () => number; maxRecords?: number; maxStorageChars?: number;
}) {
  const capabilities = new Set(options.capabilities);
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const now = options.now ?? Date.now;
  let disposed = false;
  function prune() {
    const records: Array<{ key: string; receipt: Receipt; size: number }> = [];
    for (let index = 0; index < options.storage.length; index++) {
      const key = options.storage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = options.storage.getItem(key)!;
      const receipt = JSON.parse(raw) as Receipt;
      records.push({ key, receipt, size: raw.length });
    }
    records.sort((a, b) => a.receipt.at - b.receipt.at);
    let size = records.reduce((sum, record) => sum + record.size, 0), count = records.length;
    for (const record of records) {
      if (count < (options.maxRecords ?? 128) && size < (options.maxStorageChars ?? 3 * 1024 * 1024)) break;
      if (record.receipt.state !== 'done' || !record.receipt.acknowledged) continue;
      options.storage.removeItem(record.key); size -= record.size; count--;
    }
    if (count >= (options.maxRecords ?? 128) || size >= (options.maxStorageChars ?? 3 * 1024 * 1024)) throw new Error('Host tool receipt storage is full');
  }
  async function acknowledge(envelope: HostToolEnvelope, result: HostToolResult, receipt: Receipt) {
    await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, result });
    // An acknowledged result may be pruned; an unacknowledged result may not.
    try { options.storage.setItem(PREFIX + envelope.invocationId, JSON.stringify({ ...receipt, acknowledged: true })); } catch {}
  }
  async function process(envelope: HostToolEnvelope, controller: AbortController) {
    if (disposed) return;
    const key = PREFIX + envelope.invocationId;
    const expected = await fingerprint(envelope);
    if (disposed) return;
    let prior: Receipt | null;
    try { prior = JSON.parse(options.storage.getItem(key) ?? 'null') as Receipt | null; }
    catch { await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, indeterminate: true }); return; }
    if (prior) {
      if (prior.version !== 1 || prior.inputHash !== envelope.inputHash || prior.fingerprint !== expected || prior.state !== 'done' || !prior.result) {
        await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, indeterminate: true }); return;
      }
      await acknowledge(envelope, prior.result, prior); return;
    }
    const started: Receipt = { version: 1, inputHash: envelope.inputHash, fingerprint: expected, state: 'started', at: now() };
    try { prune(); options.storage.setItem(key, JSON.stringify(started)); }
    catch {
      await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId,
        result: { content: 'Error: Host tool receipt storage is unavailable. The tool was not executed.' } });
      return;
    }
    if (controller.signal.aborted || disposed) {
      await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, indeterminate: true }); return;
    }
    let result: HostToolResult;
    try {
      // The server already performed its durable approval. A private one-use
      // token avoids asking twice; enabled/mode/path/origin checks remain live.
      const serverAdmission = createServerToolAdmission({ ...envelope.context, chatId: envelope.chatId,
        executionId: envelope.executionId, toolCallId: envelope.toolCallId, toolName: envelope.name, args: envelope.args });
      result = await options.execute(envelope.name, envelope.args, { ...envelope.context,
        chatId: envelope.chatId, executionId: envelope.executionId, toolCallId: envelope.toolCallId,
        serverAdmission, signal: controller.signal });
    } catch {
      if (disposed) return;
      await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, indeterminate: true }); return;
    }
    if (disposed) return;
    if (!result || typeof result.content !== 'string' || JSON.stringify(result).length > MAX_RESULT) {
      await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, indeterminate: true }); return;
    }
    const done: Receipt = { ...started, state: 'done', result };
    try { options.storage.setItem(key, JSON.stringify(done)); }
    catch { await options.respond({ hostId: options.hostId, invocationId: envelope.invocationId, indeterminate: true }); return; }
    await acknowledge(envelope, result, done);
  }
  return {
    async handle(value: unknown): Promise<void> {
      if (!value || typeof value !== 'object' || disposed) return;
      const envelope = value as HostToolEnvelope | HostToolCancel;
      if (envelope.version !== 1 || !identifier(envelope.invocationId)) throw new Error('Invalid host tool envelope');
      if (envelope.type === 'cancel') { active.get(envelope.invocationId)?.controller.abort(); return; }
      if (envelope.type !== 'execute' || envelope.hostId !== options.hostId || !identifier(envelope.projectId) ||
          !identifier(envelope.chatId) || !identifier(envelope.executionId) || typeof envelope.toolCallId !== 'string' ||
          !capabilities.has(`tool:${envelope.name}`) || managedTools.has(envelope.name) || !envelope.args || typeof envelope.args !== 'object' ||
          Array.isArray(envelope.args) || JSON.stringify(envelope).length > MAX_INPUT ||
          typeof envelope.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.inputHash) ||
          typeof envelope.context?.workspaceRoot !== 'string' || !envelope.context.workspaceRoot.trim() ||
          !['general', 'build', 'plan', 'debug', 'orchestrate', 'onboarding'].includes(envelope.context.modeId)) {
        throw new Error('Host tool capability or invocation scope is invalid');
      }
      const existing = active.get(envelope.invocationId);
      if (existing) return existing.promise;
      if (active.size >= 128) throw new Error('Too many active host tool callbacks');
      const controller = new AbortController();
      const promise = process(envelope, controller);
      active.set(envelope.invocationId, { controller, promise });
      try { await promise; } finally { if (active.get(envelope.invocationId)?.promise === promise) active.delete(envelope.invocationId); }
    },
    dispose() { disposed = true; for (const row of active.values()) row.controller.abort(); active.clear(); },
    get activeCount() { return active.size; },
  };
}

/** One capability connection per workspace-bound host view; paired devices observe only. */
export function startChatHostCapabilities(): () => void {
  let closed = false;
  let source: { close(): void } | undefined;
  let processor: ReturnType<typeof createChatHostCapabilityProcessor> | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  void (async () => {
    const [auth, streams, remote, workspace, catalog, shell] = await Promise.all([
      import('../api/session-token'), import('../api/stream-event-source'), import('./remote-chat-client'),
      import('../state/workspace'), import('../tools/definitions'), import('../tools/minnow-shell'),
    ]);
    if (closed || !auth.hasHostSessionToken() || auth.isPairedDevice()) return;
    const reconnect = () => {
      const revision = ++generation;
      source?.close(); processor?.dispose();
      if (closed || !workspace.getWorkspacePath()) return;
      const hostId = remote.getChatHostId();
      const capabilities = chatHostToolCapabilities(catalog.BUILT_IN_TOOLS, shell.isPreviewAutomationReady());
      let storage: Storage;
      try { storage = localStorage; } catch { return; }
      processor = createChatHostCapabilityProcessor({ hostId, capabilities, storage,
        execute: async (name, args, context) => (await import('../tools/client')).executeTool(name, args, context),
        respond: async response => {
          const result = await fetch('/api/chats/host/results', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response), signal: AbortSignal.timeout(8000) });
          if (!result.ok) throw new Error(`Host tool receipt was not accepted (${result.status})`);
        } });
      const current = processor;
      const url = `/api/chats/host?clientVersion=1&hostId=${encodeURIComponent(hostId)}&capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`;
      const connection = new streams.StreamEventSource(url);
      source = connection;
      connection.addEventListener('host-tool', event => {
        if (closed || revision !== generation) return;
        try { void current.handle(JSON.parse((event as MessageEvent).data)).catch(error => console.error('[chats] host tool callback failed:', error)); }
        catch (error) { console.error('[chats] invalid host tool request:', error); }
      });
    };
    unsubscribe = workspace.subscribeWorkspace(reconnect);
    reconnect();
  })().catch(error => { console.error('[chats] host capability registration failed:', error); });
  return () => { closed = true; generation++; unsubscribe?.(); source?.close(); processor?.dispose(); };
}
