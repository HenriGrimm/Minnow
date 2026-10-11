import { PassThrough } from 'node:stream';
import { createCliRpc } from './rpc.js';
import { cliHash } from './checkpoints.js';
import { cursorVariantParts } from '../../../src/models/cursor-variants.mjs';

const EFFORT_OPTION_IDS = new Set(['reasoning', 'effort', 'reasoning_effort', 'thought_level']);
const acpEffort = value => value === 'extra-high' ? 'xhigh' : value === 'none' ? 'off' : value;

/**
 * Cursor's parameterized picker reports the base model and its parameters
 * separately, while `--model` takes the CLI's combined slug
 * (`gpt-5.3-codex-high-fast` → `gpt-5.3-codex` + reasoning=high, fast=true).
 */
export function cursorAcpModelMatches(selected, result) {
  if (!selected) return true;
  const current = String(result?.models?.currentModelId ?? '').replace(/\[.*\]$/, '');
  if (selected === 'auto') return current === 'default';
  const parts = cursorVariantParts(selected);
  if (!parts || (current !== parts.baseId && `cursor-${current}` !== parts.baseId)) return false;
  const options = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const value = id => options.find(option => option.id === id)?.currentValue;
  const effort = options.find(option => EFFORT_OPTION_IDS.has(option.id))?.currentValue;
  if (parts.effort && acpEffort(effort) !== parts.effort) return false;
  if (value('fast') != null && value('fast') !== String(parts.fast)) return false;
  if (parts.thinking && value('thinking') != null && value('thinking') !== 'true') return false;
  return true;
}

/** ACP extensions never gain a second execution/approval path around Minnow. */
export function cursorPermissionAllowed(params, names) {
  const call = params?.toolCall;
  const raw = call?.rawInput;
  // Cursor reports MCP calls as `${providerIdentifier}: ${toolName}`.
  if ((raw?.providerIdentifier === 'minnow' || raw?.serverName === 'minnow') && names.has(raw.toolName)) return true;
  return [...names].some(name => [`mcp__minnow__${name}`, `minnow:${name}`, `minnow: ${name}`].includes(call?.title));
}

/** Cursor announces an MCP call before its arguments arrive, then names it in an update. */
export function cursorUnnamedMcpCall(update) {
  return update?.title === 'MCP: tool' && !update.rawInput?.toolName && !update.rawInput?.providerIdentifier && !update.rawInput?.serverName;
}

export async function openCursorAcp(invocation, { tools = [], saved, onNativeData, signal } = {}) {
  const names = new Set(tools.map(row => row.name));
  const output = new PassThrough();
  let sessionId, loading = false, started = false, failure, resolveDone;
  let ledger = [], ledgerBytes = 0;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const emit = row => output.write(`${JSON.stringify(row)}\n`);
  const rpc = createCliRpc({ ...invocation, argsPrefix: [] }, { name: 'Cursor ACP', jsonrpc: true, onRequest: async row => {
    if (row.method === 'session/request_permission' && row.params?.sessionId === sessionId
      && cursorPermissionAllowed(row.params, names)) {
      const allow = row.params.options?.find(option => option.kind === 'allow_once');
      if (allow) { await rpc.respond(row.id, { outcome: { outcome: 'selected', optionId: allow.optionId } }); return; }
    }
    await rpc.respond(row.id, null, { code: -32601, message: 'Only exposed Minnow tools are allowed.' });
    fail(new Error('Cursor requested a native permission or unsupported blocking extension.'));
  } });
  rpc.child.stdout.on('data', chunk => onNativeData?.(chunk));
  rpc.child.once('close', code => { output.end(); resolveDone({ code: code ?? 1, stderr: failure?.message ?? '' }); });
  rpc.child.once('error', error => { failure = error; resolveDone({ code: 1, stderr: error.message }); });
  function fail(error) {
    if (failure) return;
    failure = error;
    emit({ type: 'error', message: error.message });
    void rpc.close().catch(() => {});
  }
  rpc.onFailure(error => { if (started) fail(error); });
  function record(row) {
    ledgerBytes += Buffer.byteLength(JSON.stringify(row));
    if (ledgerBytes > 8 * 1024 * 1024) throw new Error('Cursor native history exceeded its verification limit.');
    const last = ledger.at(-1);
    if (row.role && row.role === last?.role) last.text += row.text;
    else if (row.toolId) {
      const previous = ledger.findLast(entry => entry.toolId === row.toolId);
      if (previous) Object.assign(previous, row); else ledger.push(row);
    } else ledger.push(row);
  }
  function digest() { return cliHash(ledger.map(({ toolId, ...row }) => row)); }
  function verifyModel(result) {
    if (!cursorAcpModelMatches(invocation.selectedModel, result)) {
      throw new Error('Cursor ACP did not confirm the selected model.');
    }
  }
  rpc.subscribe(row => {
    if (row.method !== 'session/update') return;
    const p = row.params ?? {}, u = p.update ?? {};
    if (!loading && p.sessionId !== sessionId) return;
    try {
      const type = u.sessionUpdate;
      if (type === 'user_message_chunk') {
        if (loading && u.content?.type === 'text') record({ role: 'user', text: u.content.text });
      } else if (type === 'agent_message_chunk') {
        if (u.content?.type !== 'text') throw new Error('Unsupported Cursor response content.');
        record({ role: 'assistant', text: u.content.text });
        if (!loading && started) emit({ type: 'assistant', message: { content: [{ type: 'text', text: u.content.text }] } });
      } else if (type === 'agent_thought_chunk') {
        if (!loading && started && u.content?.type === 'text') emit({ type: 'thinking', text: u.content.text });
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        // Check every identity Cursor reports, not only the first row: its
        // MCP placeholder is unnamed until a later tool_call_update.
        const identifies = type === 'tool_call' || u.title != null || u.rawInput != null;
        if (!loading && identifies && !cursorPermissionAllowed({ toolCall: u }, names) && !cursorUnnamedMcpCall(u)) {
          throw new Error('Cursor attempted an unexposed native tool.');
        }
        const known = ledger.findLast(entry => entry.toolId === u.toolCallId);
        record({ ...(known ?? {}), toolId: u.toolCallId, ...(u.title ? { title: u.title } : {}),
          ...(u.kind ? { kind: u.kind } : {}), ...(u.rawInput != null ? { input: u.rawInput } : {}),
          ...(u.rawOutput != null ? { output: u.rawOutput } : {}), ...(u.status ? { status: u.status } : {}) });
      }
    } catch (error) { fail(error); }
  });
  try {
    // The variants picker collapses each model to one default variant and
    // reports e.g. reasoning=medium for `--model gpt-5.3-codex-low`; the
    // parameterized picker reports what `--model` actually selected.
    const init = await rpc.request('initialize', { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
      clientInfo: { name: 'minnow', version: '1' } }, { signal });
    if (init.protocolVersion !== 1 || init.agentCapabilities?.loadSession !== true) throw new Error('Cursor ACP does not support verified session loading.');
    await rpc.request('authenticate', { methodId: 'cursor_login' }, { signal });
    const params = { cwd: invocation.cwd, mcpServers: [] };
    let method = 'new';
    if (saved) {
      loading = true;
      try {
        verifyModel(await rpc.request('session/load', { ...params, sessionId: saved.nativeId }, { signal }));
        if (failure || digest() !== saved.nativeDigest) throw new Error('Cursor saved history failed verification.');
        sessionId = saved.nativeId; method = 'resumed';
      } catch {
        ledger = []; ledgerBytes = 0; method = 'rebuilt';
      } finally { loading = false; }
    }
    if (!sessionId) {
      const created = await rpc.request('session/new', params, { signal });
      verifyModel(created);
      sessionId = created.sessionId;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error('Cursor ACP returned an invalid session ID.');
      // Cursor persists a session only after its first prompt, so an empty
      // session cannot be loaded back. A later failed load rebuilds instead.
      if (failure) throw failure;
    }
    return {
      child: { stdout: output, stderr: rpc.child.stderr, get pid() { return rpc.child.pid; },
        get exitCode() { return rpc.child.exitCode; }, get signalCode() { return rpc.child.signalCode; } },
      done, nativeId: sessionId, method, digest, rpc,
      async send(text, sendSignal) {
        if (failure) throw failure;
        started = true;
        record({ role: 'user', text });
        void rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, { signal: sendSignal, timeoutMs: 0 })
          .then(result => {
            if (failure) return;
            if (result.stopReason !== 'end_turn') { fail(new Error(`Cursor prompt stopped (${result.stopReason}).`)); return; }
            emit({ type: 'result', subtype: 'success' });
          }).catch(fail);
      },
      async stop() {
        if (started) await rpc.notify('session/cancel', { sessionId }).catch(() => {});
        await rpc.close();
      },
    };
  } catch (error) {
    try { await rpc.close(); }
    catch {
      // Do not start the replay transport while this preflight child still
      // owns its private configuration and bridge files.
      if (rpc.child.pid && rpc.child.exitCode == null && rpc.child.signalCode == null) {
        error.cliTerminationUnconfirmed = true;
        error.cliProcessRun = { child: rpc.child, done, stop: () => rpc.close() };
      }
    }
    throw error;
  }
}
