import { createHash, randomUUID } from 'node:crypto';
import { HEADLESS_RESULT_VERSION, type HeadlessRunResult, type HeadlessTurnRecord } from './result';
import type { RunHeadlessOptions } from './runner';
import type { TurnEvent } from '../../server/runner/run-turn.js';

interface Receipt {
  commandId: string;
  executionId?: string | null;
  runId?: string | null;
  revision?: number;
  state: string;
  disposition?: string;
  link?: string;
  result?: any;
  error?: { message?: string; code?: string } | null;
  assistantFinal?: string | null;
}
interface Snapshot {
  chat?: { id?: string; chatCommandVersion?: number; providerId?: string; modelId?: string; modeId?: string; workspacePath?: string };
  execution?: { executionId?: string; status?: string; commandId?: string } | null;
  frame?: { epoch?: string; fields?: Record<string, any>; live?: Record<string, any> | null; history?: { messages?: any[] } };
}
export interface ManagedChatAdapters {
  fetch?: typeof fetch;
  now?: () => number;
  id?: () => string;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

class ManagedChatError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Only an absent id may use fresh CLI persistence; existing history stays server-owned. */
export async function runManagedChatIfPresent(options: RunHeadlessOptions, adapters: ManagedChatAdapters = {}): Promise<HeadlessRunResult | null> {
  const { cli, signal } = options;
  if (!cli.chatId) return null;
  const fetchApi = adapters.fetch ?? globalThis.fetch;
  const now = adapters.now ?? Date.now;
  const sleep = adapters.sleep ?? delay;
  const newId = adapters.id ?? randomUUID;
  const started = now(), startedAt = new Date(started).toISOString();
  const chatPath = `/api/chats/${encodeURIComponent(cli.chatId)}`;
  const clientRequestId = cli.clientRequestId ?? newId();
  const headers = { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1', 'X-Minnow-Chat-Client': cli.schedulerRun ? 'scheduler' : 'cli' };
  let snapshot: Snapshot = {}, receipt: Receipt | null = null, assistantFinal = '';
  let knownManaged = false, roundOpen = false, lastText = '', lastThinking = '', lastTool = '';
  let admissionAttempted = false;
  const turns: HeadlessTurnRecord[] = [];
  function emit(event: TurnEvent) { options.onEvent?.(event); }
  function observe(value: Snapshot) {
    snapshot = value;
    if (cli.chatAction === 'steer') return;
    const executionId = receipt?.executionId ?? receipt?.result?.executionId;
    if (!executionId) return;
    const frame = value.frame;
    const live = frame && frame.epoch === executionId ? frame.live : null;
    if (live) {
      if (!roundOpen) { emit({ type: 'round_start', index: turns.length }); roundOpen = true; }
      if (typeof live.lastDelta === 'string' && live.lastDelta !== lastText) {
        if (lastText && !live.lastDelta.startsWith(lastText)) {
          emit({ type: 'round_start', index: turns.length + 1 }); lastText = ''; lastThinking = '';
        }
        lastText = live.lastDelta; assistantFinal = lastText; emit({ type: 'delta', text: lastText });
      }
      if (typeof live.lastThinking === 'string' && live.lastThinking !== lastThinking) {
        lastThinking = live.lastThinking; emit({ type: 'thinking', text: lastThinking });
      }
      if (typeof live.currentTool === 'string' && live.currentTool !== lastTool) {
        lastTool = live.currentTool; emit({ type: 'tool_streaming', name: lastTool });
      }
    }
    const prefix = `m-${createHash('sha256').update(executionId).digest('hex').slice(0, 32)}-`;
    const assistants = (frame?.history?.messages ?? []).filter(row => row.role === 'assistant' &&
      typeof row.messageId === 'string' && row.messageId.startsWith(prefix));
    const last = assistants.at(-1);
    if (typeof last?.content === 'string') assistantFinal = last.content;
  }
  async function request(route: string, init: RequestInit = {}, requestSignal?: AbortSignal): Promise<any> {
    const response = await fetchApi(route, { ...init, headers, cache: 'no-store',
      signal: requestSignal ? AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ManagedChatError(typeof body.error === 'string' ? body.error : body.error?.message ?? `Conversation request failed (${response.status})`, response.status, body.error?.code);
    return body;
  }
  async function submit(body: Record<string, unknown>): Promise<any> {
    // Admission retries retain one receipt identity even when the response is lost.
    for (let attempt = 0; ; attempt++) {
      try { return await request(`${chatPath}/commands`, { method: 'POST', body: JSON.stringify(body) }); }
      catch (error) {
        if (error instanceof ManagedChatError || attempt >= 1) throw error;
      }
    }
  }
  async function readReceipt(): Promise<Receipt> {
    const body = await request(`/api/chat-commands/${encodeURIComponent(receipt!.commandId)}`, {}, signal);
    if (!body.receipt?.commandId || body.receipt.commandId !== receipt!.commandId) throw new ManagedChatError('The server returned a different command receipt');
    receipt = body.receipt;
    return receipt!;
  }
  async function cancelOwnCommand(): Promise<void> {
    if (!receipt) return;
    // Queue cancellation never stops a different execution already in this chat.
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = await request(`/api/chat-commands/${encodeURIComponent(receipt.commandId)}`);
      const current: Receipt = body.receipt;
      if (!current || current.commandId !== receipt.commandId) throw new ManagedChatError('The interrupted command receipt is unavailable');
      receipt = current;
      if (['settled', 'failed', 'cancelled'].includes(current.state)) return;
      try {
        if (['accepted', 'queued', 'waiting_for_host'].includes(current.state)) {
          await submit({ action: 'remove', itemId: current.commandId, expectedRevision: current.revision, clientRequestId: `${clientRequestId}-remove` });
        } else if (current.executionId) {
          await submit({ action: 'stop', scope: 'turn', executionId: current.executionId, clientRequestId: `${clientRequestId}-stop` });
        } else throw new ManagedChatError('The interrupted command has no bound execution; its durable receipt is preserved');
        return;
      } catch (error) {
        if (!(error instanceof ManagedChatError) || error.code !== 'stale_revision' || attempt) throw error;
      }
    }
  }
  function finish(ok: boolean, exitCode: number, error: string | null): HeadlessRunResult {
    const completedAt = now();
    if (assistantFinal && turns.length === 0 && receipt?.state === 'settled') {
      turns.push({ generationId: '', finishReason: null, assistantText: assistantFinal, toolCalls: [] });
      if (roundOpen) emit({ type: 'round_end', index: 0, text: assistantFinal, reasoning: lastThinking,
        toolCallCount: 0, t0: started, tFirst: null, tEnd: completedAt });
      else { emit({ type: 'round_start', index: 0 }); emit({ type: 'delta', text: assistantFinal }); }
    }
    if (error) options.log?.(error);
    return {
      version: HEADLESS_RESULT_VERSION, ok, exitCode, startedAt, finishedAt: new Date(completedAt).toISOString(),
      workspace: snapshot.chat?.workspacePath ?? options.workspaceAbs, modeId: snapshot.chat?.modeId ?? cli.modeId,
      workAgentId: snapshot.frame?.fields?.workAgentId ?? null, providerId: snapshot.chat?.providerId ?? '', modelId: snapshot.chat?.modelId ?? '',
      promptProfile: 'managed', userPrompt: cli.prompt, assistantFinal, turns,
      stats: { toolRounds: turns.length, durationMs: completedAt - started }, error, chatId: cli.chatId,
      managedChat: { clientRequestId, commandId: receipt?.commandId ?? null, executionId: receipt?.executionId ?? receipt?.result?.executionId ?? null,
        state: receipt?.state ?? 'unknown', disposition: receipt?.disposition ?? 'unknown', link: receipt?.link ?? `#/app/code/chat?chatId=${encodeURIComponent(cli.chatId!)}` },
    };
  }
  try {
    signal.throwIfAborted();
    try { snapshot = await request(chatPath, {}, signal); }
    catch (error) {
      if (error instanceof ManagedChatError && error.status === 404 && error.code === 'chat_not_found' && !cli.chatAction && !cli.clientRequestId && !cli.waitTimeoutSec) return null;
      throw error;
    }
    if (snapshot.chat?.id !== cli.chatId) throw new ManagedChatError('The server did not return the requested conversation; no message was admitted.');
    if (snapshot.chat.chatCommandVersion !== 1) {
      const capability = await request('/api/chats/capabilities', {}, signal);
      if (capability.creationEnabled !== true || capability.conversationStorage !== 'sqlite') {
        throw new ManagedChatError('This existing chat cannot accept server-owned messages in this build. Open it in Minnow; its saved history has been preserved.');
      }
    }
    knownManaged = true;
    if (cli.noApproval) throw new ManagedChatError('Managed conversations use their saved tool approvals. --no-approval applies to fresh CLI runs.');
    if ((cli.providerId && cli.providerId !== snapshot.chat.providerId) || (cli.modelId && cli.modelId !== snapshot.chat.modelId) ||
      cli.agentId || (cli.managedModeExplicit && cli.modeId !== snapshot.chat.modeId) || cli.managedProfileExplicit) {
      throw new ManagedChatError('This conversation uses its saved agent, model, mode and prompt profile. Configure it in Minnow before sending this message.');
    }
    signal.throwIfAborted();
    const action = cli.chatAction ?? 'send';
    admissionAttempted = true;
    const admitted = await submit({ action: action === 'steer' ? 'steer' : 'send', text: cli.prompt,
      ...(action === 'queue' ? { mode: 'queue' } : {}), clientRequestId });
    if (!admitted.receipt?.commandId) throw new ManagedChatError('The server did not return a durable command receipt');
    receipt = admitted.receipt;
    if (admitted.frame) observe({ ...snapshot, frame: admitted.frame });
    const deadline = cli.waitTimeoutSec ? now() + cli.waitTimeoutSec * 1000 : Infinity;
    let waitingState = '';
    while (true) {
      signal.throwIfAborted();
      const current = receipt!;
      if (['settled', 'failed', 'cancelled'].includes(current.state)) {
        if (cli.chatAction !== 'steer') {
          if (Object.hasOwn(current, 'assistantFinal')) assistantFinal = current.assistantFinal ?? '';
          else observe(await request(chatPath, {}, signal));
        }
        const ok = current.state === 'settled' && !['crashed', 'timeout', 'fail', 'blocked'].includes(current.result?.outcome);
        return finish(ok, ok ? 0 : current.state === 'cancelled' ? 130 : 1,
          ok ? null : current.error?.message ?? current.result?.error ?? current.result?.summary ?? `Conversation command ${current.state}`);
      }
      if (now() >= deadline) return finish(false, 124, 'Timed out waiting for the command. Its accepted work remains in Minnow.');
      const state = snapshot.execution?.status ?? current.state;
      if (/^waiting_for_/.test(state) && state !== waitingState) {
        waitingState = state; options.log?.(`Conversation ${cli.chatId}: ${state.replaceAll('_', ' ')} (${current.commandId})`);
      }
      await sleep(adapters.pollMs ?? 250, signal);
      await readReceipt();
      observe(await request(chatPath, {}, signal));
    }
  } catch (error) {
    if (signal.aborted) {
      let cancelError = '';
      try { await cancelOwnCommand(); } catch (failure) { cancelError = ` Could not confirm cancellation: ${failure instanceof Error ? failure.message : String(failure)}.`; }
      return finish(false, 130, receipt ? `Interrupted. The admitted command is preserved in Minnow.${cancelError}`
        : admissionAttempted ? `Interrupted before admission could be confirmed. Retry with --client-request-id ${clientRequestId}.`
        : 'Interrupted before a command was admitted.');
    }
    // An authenticated managed/unknown request failure must never fall through
    // into the local runner or write a replacement session transcript.
    return finish(false, error instanceof ManagedChatError && !knownManaged && error.status === 404 ? 2 : 1,
      error instanceof Error ? error.message : String(error));
  }
}
