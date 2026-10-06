import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { killProcessTree, killProcessTreeAndWait } from '../../terminal-runner.js';
import { cliHash } from './checkpoints.js';
import { detectAgentCli } from '../../models/agent-cli-detect.js';

const MAX_TRANSCRIPT = 64 * 1024 * 1024;
const MAX_HOOK = 16 * 1024 * 1024;
const HANDOFF_COMMIT_WAIT_MS = 1500;
const textOf = blocks => (blocks ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
export function supportsClaudeInteractiveVersion(version) {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version ?? '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 289);
}

/** Read only owned native logs. A complete stop_reason is the commit boundary,
 * not the arrival of an MCP call (which can precede the end of streaming). */
export function createInteractiveTranscript(files) {
  const cursors = new Map(files.filter(Boolean).map(file => [file, { offset: 0, pending: Buffer.alloc(0) }]));
  const uuids = new Set(), messages = new Map();
  let changed = 0;
  let chain = Promise.resolve();
  async function read() {
    for (const [file, cursor] of cursors) {
      const stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!stat) continue;
      const parent = await fs.lstat(path.dirname(file));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Claude interactive transcript directory failed verification.');
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT || stat.size < cursor.offset) throw new Error('Claude interactive transcript failed verification.');
      if (stat.size === cursor.offset) continue;
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - cursor.offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
        cursor.offset += bytesRead;
        const data = Buffer.concat([cursor.pending, buffer.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(10);
        cursor.pending = data.subarray(end + 1);
        if (cursor.pending.length > MAX_HOOK) throw new Error('Claude transcript record exceeded its size limit.');
        if (end < 0) continue;
        for (const line of data.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
          const row = JSON.parse(line);
          if (row.type === 'system' && row.subtype === 'compact_boundary') throw new Error('Context length exceeded: Minnow must compact its recorded context and retry.');
          if (row.type !== 'assistant' || row.isSidechain || row.message?.model === '<synthetic>' || !row.message?.id || !row.uuid || uuids.has(row.uuid)) continue;
          uuids.add(row.uuid);
          if (uuids.size > 100_000) throw new Error('Claude transcript record limit exceeded.');
          const message = messages.get(row.message.id) ?? { ...row.message, content: [], rows: [] };
          message.content.push(...(row.message.content ?? []));
          message.rows.push(row.uuid);
          message.usage = row.message.usage;
          message.stop_reason = row.message.stop_reason;
          messages.set(message.id, message);
          changed = Date.now();
        }
      } finally { await handle.close(); }
    }
    return { messages, stable: Date.now() - changed >= 100 };
  }
  return { read: () => { const next = chain.then(read); chain = next.catch(() => {}); return next; } };
}

/** Real interactive Claude. Model output comes from documented hooks and native
 * transcripts. The terminal is used only for startup and a fixed MCP command. */
export async function openClaudeInteractive(invocation, { bridge, nativeId, configRoot, resumePath, signal, onNativeData = () => {}, onSecret = () => {}, spawnPty } = {}) {
  signal?.throwIfAborted();
  if (!spawnPty) {
    const detected = await detectAgentCli('claude', { binPath: invocation.display, env: invocation.env });
    if (!supportsClaudeInteractiveVersion(detected.version)) throw new Error('Interactive chat requires Claude Code 2.1.289 or newer. Update Claude Code through Models → CLIs and retry.');
  }
  signal?.throwIfAborted();
  const token = randomBytes(32).toString('hex'), secret = Buffer.from(`Bearer ${token}`);
  onSecret(token);
  const projectFile = path.join(configRoot, 'projects', invocation.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`);
  const reader = createInteractiveTranscript([resumePath, projectFile]);
  const old = await reader.read();
  const committed = new Set(old.messages.keys());
  const handedOff = new Set([...old.messages.values()].flatMap(m => m.content.filter(b => b.type === 'tool_use').map(b => b.id)));
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
  let terminal, closed = false, failure, expectedCommand, acceptedSubmission, currentPromptId, startupTimer, stopPromise;
  let displayText = '', emittedText = '', committedText = '', lastCommitted;
  let output = '', trusted = false, themed = false, noted = false, startupComplete = false;
  bridge.ready.then(ready => { if (ready) startupComplete = true; });
  let inFlight = false;
  let transcriptTimer, transcriptEpoch = 0;
  const reasoningBlocks = new Map();
  const deferredCalls = [];
  let outputPaused = false, pendingBytes = 0;
  const pendingOutput = [];
  const batches = new Map();
  const sockets = new Set();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const emit = event => {
    if (closed) return;
    const line = `${JSON.stringify(event)}\n`;
    if (!outputPaused) { child.stdout.write(line); return; }
    pendingBytes += Buffer.byteLength(line);
    if (pendingBytes > MAX_HOOK) throw new Error('Claude pending output exceeded its size limit.');
    pendingOutput.push(line);
  };
  const status = message => { if (!closed) child.stderr.write(`Claude: ${message}\n`); };
  const fail = error => {
    if (failure || closed) return;
    failure = error;
    status(error.message);
    outputPaused = false;
    emit({ type: 'result', is_error: true, error: error.message });
    void stop();
  };
  function emitText(value) {
    if (value.startsWith(emittedText)) {
      const delta = value.slice(emittedText.length); emittedText = value;
      if (delta) emit({ type: 'interactive_text', text: delta });
    } else if (!emittedText.startsWith(value)) throw new Error('Claude display and native transcript disagree.');
  }
  function emitReasoning(message) {
    if (committed.has(message.id)) return;
    const count = reasoningBlocks.get(message.id) ?? 0;
    const blocks = message.content.filter(b => b.type === 'thinking');
    for (const block of blocks.slice(count)) {
      if (typeof block.thinking === 'string' && block.thinking) emit({ type: 'interactive_reasoning', text: block.thinking });
    }
    reasoningBlocks.set(message.id, blocks.length);
  }
  async function pollTranscript(epoch) {
    try {
      const snapshot = await reader.read();
      if (closed || !inFlight || epoch !== transcriptEpoch) return;
      for (const message of snapshot.messages.values()) emitReasoning(message);
      if (snapshot.stable) commitAvailable(snapshot);
      transcriptTimer = setTimeout(() => pollTranscript(epoch), 100);
    } catch (error) { fail(error); }
  }
  function commit(message) {
    if (committed.has(message.id)) return;
    emitReasoning(message);
    reasoningBlocks.delete(message.id);
    committed.add(message.id); lastCommitted = message;
    committedText += textOf(message.content); emitText(committedText);
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: message.id, model: message.model, usage: message.usage } } });
    emit({ type: 'assistant', uuid: message.rows.join(':'), message: { ...message, content: message.content.filter(b => !['text', 'thinking'].includes(b.type)) } });
    emit({ type: 'stream_event', event: { type: 'message_stop' } });
  }
  function matchesCall(block, call) {
    return block.type === 'tool_use' && !handedOff.has(block.id) && block.name === `mcp__minnow__${call.function.name}`
      && cliHash(block.input) === cliHash(JSON.parse(call.function.arguments));
  }
  function claimCall(messages, call) {
    const message = [...messages.values()].find(m => m.stop_reason && m.content.some(b => matchesCall(b, call)));
    if (message) handedOff.add(message.content.find(b => matchesCall(b, call)).id);
    return message;
  }
  function commitAvailable(snapshot) {
    while (deferredCalls.length && claimCall(snapshot.messages, deferredCalls[0])) deferredCalls.shift();
    for (const message of snapshot.messages.values()) if (message.stop_reason) commit(message);
  }
  async function waitFor(predicate, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (!closed && !failure && Date.now() < deadline) {
      const snapshot = await reader.read();
      const found = [...snapshot.messages.values()].findLast(m => m.stop_reason && predicate(m));
      if (found && snapshot.stable) { commitAvailable(snapshot); return found; }
      await delay(50);
    }
    throw failure ?? new Error(closed ? 'Interactive Claude session closed.' : 'Claude did not commit its completed response. Update Claude Code and retry.');
  }
  let hookChain = Promise.resolve();
  async function processHook(event) {
    if (event.session_id !== nativeId || path.resolve(event.cwd ?? '') !== path.resolve(invocation.cwd)) throw new Error('Interactive Claude hook identity mismatch.');
    if (event.hook_event_name === 'UserPromptSubmit') {
      emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
      return;
    }
    if (event.prompt_id && event.prompt_id !== currentPromptId) return;
    if (event.hook_event_name === 'MessageDisplay') {
      if (typeof event.message_id !== 'string' || !Number.isSafeInteger(event.index) || event.index < 0 || typeof event.delta !== 'string') throw new Error('Invalid Claude display event.');
      const batch = batches.get(event.message_id) ?? { next: 0, pending: new Map() };
      batches.set(event.message_id, batch);
      if (event.index < batch.next) return;
      batch.pending.set(event.index, event.delta);
      while (batch.pending.has(batch.next)) { displayText += batch.pending.get(batch.next); batch.pending.delete(batch.next++); }
      if (displayText.length > MAX_HOOK || batches.size > 4096 || batch.pending.size > 4096) throw new Error('Claude display exceeded its size limit.');
      emitText(displayText);
    } else if (event.hook_event_name === 'Stop') {
      const lastText = (event.last_assistant_message ?? '').trim();
      await waitFor(m => (!committed.has(m.id) || m.id === lastCommitted?.id && m.stop_reason !== 'tool_use')
        && (textOf(m.content).trim() === lastText || m.content.findLast(b => b.type === 'text')?.text?.trim() === lastText));
      if (deferredCalls.length) throw new Error('Claude transcript did not contain the pending tool calls.');
      inFlight = false;
      transcriptEpoch++;
      clearTimeout(transcriptTimer);
      emit({ type: 'result', subtype: 'success' });
    } else if (event.hook_event_name === 'StopFailure') {
      if (event.error === 'rate_limit') emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
      throw new Error(`Claude ${event.error ?? 'request failed'}: ${event.error_details ?? event.last_assistant_message ?? ''}`);
    } else if (event.hook_event_name === 'PreCompact') {
      throw new Error('Context length exceeded: Minnow must compact its recorded context and retry.');
    }
  }
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    if (closed || req.method !== 'POST' || req.url !== '/hook' || req.headers.origin || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) { res.writeHead(403).end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_HOOK) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const event = JSON.parse(Buffer.concat(chunks));
      if (event.hook_event_name === 'UserPromptSubmit') {
        const sameIdentity = event.session_id === nativeId && typeof event.cwd === 'string'
          && path.resolve(event.cwd) === path.resolve(invocation.cwd);
        const retry = sameIdentity && inFlight && typeof event.prompt_id === 'string' && event.prompt_id.length > 0
          && event.prompt_id === acceptedSubmission?.id && event.prompt === acceptedSubmission.command;
        if (retry) { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
        if (!sameIdentity || !expectedCommand || event.prompt !== expectedCommand) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ decision: 'block', reason: 'Minnow did not submit this message.' }));
          const reason = !sameIdentity ? 'hook identity mismatch' : expectedCommand ? 'submitted command did not match' : 'no message was pending';
          fail(new Error(`Interactive Claude attempted an unexpected turn (${reason}).`)); return;
        }
        acceptedSubmission = { id: event.prompt_id, command: expectedCommand };
        currentPromptId = event.prompt_id; expectedCommand = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      hookChain = hookChain.then(() => processHook(event)).catch(fail);
    } catch { if (!res.headersSent) res.writeHead(400).end(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 20;
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const settingsPath = path.join(invocation.cwd, 'claude-interactive-settings.json');
  try {
    const hook = { type: 'http', url: `http://127.0.0.1:${server.address().port}/hook`, headers: { Authorization: `Bearer ${token}` }, timeout: 5 };
    await fs.writeFile(settingsPath, JSON.stringify({ promptSuggestionEnabled: false,
      hooks: Object.fromEntries(['UserPromptSubmit', 'MessageDisplay', 'Stop', 'StopFailure', 'PreCompact'].map(name => [name, [{ hooks: [hook] }]])) }), { mode: 0o600 });
    const pty = spawnPty ?? (await import('@lydell/node-pty')).default.spawn;
    signal?.throwIfAborted();
    terminal = pty(invocation.command, [...invocation.args, '--settings', settingsPath], { cwd: invocation.cwd, env: invocation.env, name: 'xterm-256color', cols: 140, rows: 40 });
    child.pid = terminal.pid; child.kill = signal => { terminal.kill(signal); return true; };
    terminal.onExit(event => {
      if (!closed && (!startupComplete || inFlight)) {
        failure ??= new Error(startupComplete ? 'Claude interactive session exited before completing its response.'
          : 'Claude interactive session exited during startup. Open Terminal and run claude once to check setup or sign-in, then retry.');
        status(failure.message);
        emit({ type: 'result', is_error: true, error: failure.message });
      }
      child.exitCode = event.exitCode; child.signalCode = event.signal || null;
      child.emit('exit', event.exitCode, child.signalCode); child.emit('close', event.exitCode, child.signalCode);
      resolveDone({ code: event.exitCode, signal: child.signalCode, stderr: failure?.message ?? '' });
      void stop();
    });
    terminal.onData(data => {
      onNativeData(data);
      if (startupComplete || closed) return;
      output = (output + data).slice(-32000);
      const flat = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, '');
      // `claude auth login` does not finish the interactive first-run screens.
      // Keep the selected theme and continue the informational security notice
      // through the native UI. Never fabricate onboarding or authentication state.
      if (!themed && flat.includes('Choosethetextstylethatlooksbestwithyourterminal')) {
        themed = true; status('Finishing first-run display setup.');
        void delay(300).then(() => { if (!closed && !startupComplete) terminal.write('\r\n'); });
      } else if (!noted && flat.includes('Securitynotes:') && flat.includes('https://code.claude.com/docs/en/security') && flat.includes('PressEntertocontinue')) {
        noted = true; status('Claude can make mistakes. Review its actions and use trusted code. https://code.claude.com/docs/en/security');
        void delay(300).then(() => { if (!closed && !startupComplete) terminal.write('\r\n'); });
      }
      // This folder is created by Minnow and contains only its private bridge.
      // Never accept login, model, or other workspace permissions by generic Enter.
      if (!trusted && flat.includes(invocation.cwd.replace(/\s+/g, '')) && flat.includes('Yes,Itrustthisfolder') && flat.includes('No,exit')) {
        trusted = true;
        void delay(200).then(async () => {
          if (closed || startupComplete) return;
          terminal.write('\x1b[B');
          await delay(200);
          if (!closed && !startupComplete) terminal.write('\r\n');
        });
      }
    });
  } catch (error) { await stop(); throw error; }
  async function stop() {
    if (stopPromise) return stopPromise;
    closed = true; transcriptEpoch++; clearTimeout(startupTimer); clearTimeout(transcriptTimer);
    pendingOutput.length = 0; pendingBytes = 0;
    stopPromise = (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      if (terminal && child.exitCode == null && child.signalCode == null) {
        killProcessTree(child);
        try { terminal.kill(); } catch { /* Already exited. */ }
        await killProcessTreeAndWait(child, { graceMs: 1500 });
      }
      await fs.rm(settingsPath, { force: true });
    })();
    return stopPromise;
  }
  return { child, done, stop, getStderr: () => failure?.message ?? '',
    get completedText() { return lastCommitted ? textOf(lastCommitted.content) : undefined; },
    pauseOutput() { outputPaused = true; },
    resumeOutput() {
      outputPaused = false;
      const lines = pendingOutput.splice(0); pendingBytes = 0;
      for (const line of lines) if (!closed) child.stdout.write(line);
    },
    async send(content, signal) {
      signal?.throwIfAborted();
      status('Starting interactive session.');
      const available = await Promise.race([bridge.ready, done.then(() => false), new Promise(resolve => { startupTimer = setTimeout(() => resolve(false), 15_000); })]);
      clearTimeout(startupTimer); signal?.throwIfAborted();
      if (!available || closed) {
        const error = failure ?? new Error('Claude interactive startup did not finish. Open Terminal and run claude once to complete any remaining setup or sign-in, then retry.');
        fail(error); throw error;
      }
      await hookChain;
      if (failure || closed) throw failure ?? new Error('Interactive Claude session closed.');
      status('Sending message.');
      displayText = ''; emittedText = ''; committedText = ''; batches.clear(); lastCommitted = null; acceptedSubmission = null;
      expectedCommand = bridge.queuePrompt(content);
      inFlight = true;
      clearTimeout(transcriptTimer);
      const epoch = ++transcriptEpoch;
      transcriptTimer = setTimeout(() => pollTranscript(epoch), 100);
      await delay(200, undefined, { signal });
      terminal.write(`\x1b[200~${expectedCommand}\x1b[201~`);
      await delay(200, undefined, { signal });
      if (closed) throw new Error('Interactive Claude session closed.');
      terminal.write('\r');
    },
    // Native Claude can await an MCP result before persisting its response.
    async beforeHandoff(call) {
      const deadline = Date.now() + HANDOFF_COMMIT_WAIT_MS;
      while (!closed && !failure) {
        const snapshot = await reader.read();
        if (snapshot.stable) {
          commitAvailable(snapshot);
          const message = claimCall(snapshot.messages, call);
          if (message) return message;
        }
        if (Date.now() >= deadline) { deferredCalls.push(call); return null; }
        await delay(50);
      }
      throw failure ?? new Error('Interactive Claude session closed.');
    },
  };
}
