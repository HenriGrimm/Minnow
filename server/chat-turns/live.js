import { readChatModelBinding, readChatWorkspacePath } from '../config/sessions-repo.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { normalizeWorkspacePath } from '../config/validators.js';
import { createHash } from 'node:crypto';

const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const COMMANDS = new Set(['send', 'steer', 'stop', 'push', 'remove', 'configure']);
const MAX_FRAME = 4 * 1024 * 1024;

function fault(status, message) { return Object.assign(new Error(message), { status }); }

/** Host-renderer execution, server-owned delivery and replayable live view state. */
export function createChatLiveBroker({ turns, workspaceForChat = id =>
  readChatModelBinding(id) ? readChatWorkspacePath(id) : null, now = Date.now } = {}) {
  const hosts = new Map();
  const viewers = new Set();
  const snapshots = new Map();
  const commands = new Map();
  let commandBytes = 0;
  let snapshotBytes = 0;
  let sequence = 0;
  const key = value => normalizeWorkspacePath(value || '');
  const prune = () => {
    for (const [id, row] of commands) if (row.finishedAt && now() - row.finishedAt > 10 * 60_000) commands.delete(id);
    if (commands.size >= 512) {
      for (const [id, row] of commands) if (row.result && commands.size >= 512) commands.delete(id);
    }
    for (const [id, row] of snapshots) if (!row.running && now() - row.at > 10 * 60_000) { snapshots.delete(id); snapshotBytes -= row.bytes; }
  };
  const hostFor = (chatId, workspace) => {
    const owner = turns.list().find(turn => turn.chatId === chatId);
    if (owner?.hostId) return hosts.get(owner.hostId);
    return [...hosts.values()].find(host => key(host.workspace) === key(workspace));
  };
  return {
    register(hostId, workspace, send) {
      if (hosts.has(hostId)) throw fault(409, 'This computer view is already connected.');
      const host = { hostId, workspace, send };
      hosts.set(hostId, host);
      for (const [deliveryId, command] of commands) {
        if (!command.result && command.hostId === hostId) send({ kind: 'command', command: { ...command.input, deliveryId } });
      }
      return () => { if (hosts.get(hostId) === host) hosts.delete(hostId); };
    },
    subscribe(workspace, send, deviceId) {
      prune();
      const viewer = { workspace, send, deviceId };
      viewers.add(viewer);
      send({ kind: 'presence', turns: turns.list() });
      for (const snapshot of snapshots.values()) {
        if (key(snapshot.workspace) === key(workspace)) send({ kind: 'frame', frame: snapshot });
      }
      return () => viewers.delete(viewer);
    },
    async submit(input, deviceId) {
      prune();
      if (!input || !ID.test(input.id || '') || !ID.test(input.chatId || '') || !COMMANDS.has(input.action)) {
        throw fault(400, 'Invalid chat command.');
      }
      const commandKey = `${deviceId}:${input.id}`;
      const signature = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = commands.get(commandKey);
      if (previous) {
        if (previous.signature !== signature) throw fault(409, 'Command id was reused.');
        return { id: commandKey, ...previous.result, pending: !previous.result };
      }
      if (commands.size >= 512) throw fault(429, 'Too many chat commands.');
      if (['send', 'steer'].includes(input.action) &&
          (typeof input.text !== 'string' || input.text.length > 100_000 || (!input.text.trim() && !input.attachments?.length))) {
        throw fault(400, 'Add a message or attachment.');
      }
      if (input.attachments && (!Array.isArray(input.attachments) || input.attachments.length > 20)) throw fault(400, 'Invalid attachments.');
      const workspace = await workspaceForChat(input.chatId);
      if (workspace === null) throw fault(404, 'Chat not found.');
      // Another identical HTTP retry may have completed the asynchronous lookup.
      const raced = commands.get(commandKey);
      if (raced) {
        if (raced.signature !== signature) throw fault(409, 'Command id was reused.');
        return { id: commandKey, ...raced.result, pending: !raced.result };
      }
      const host = hostFor(input.chatId, workspace);
      if (!host) throw fault(503, 'Open this workspace in Minnow on the computer to send messages.');
      const bytes = JSON.stringify(input).length * 2;
      if (commandBytes + bytes > 64 * 1024 * 1024) throw fault(429, 'Pending chat attachments exceed the delivery limit.');
      const row = { input, signature, bytes, hostId: host.hostId, deviceId, result: null, finishedAt: 0 };
      commandBytes += bytes;
      commands.set(commandKey, row);
      host.send({ kind: 'command', command: { ...input, deliveryId: commandKey } });
      return { id: commandKey, pending: true };
    },
    result(id, deviceId) {
      const row = commands.get(id);
      if (!row || row.deviceId !== deviceId) throw fault(404, 'Command not found.');
      return { id, ...row.result, pending: !row.result };
    },
    snapshot(chatId, workspace) {
      const frame = snapshots.get(chatId);
      if (!frame || key(frame.workspace) !== key(workspace)) throw fault(404, 'Chat is not live.');
      return frame;
    },
    acknowledge(id, hostId, result) {
      const row = commands.get(id);
      if (!row || row.hostId !== hostId) throw fault(409, 'This view does not own the command.');
      if (!row.result) {
        row.result = { ok: result.ok === true, error: String(result.error || '').slice(0, 1000) };
        row.finishedAt = now();
        commandBytes -= row.bytes;
        row.bytes = 0; row.input = null;
        for (const viewer of viewers) if (viewer.deviceId === row.deviceId) viewer.send({ kind: 'command-result', id, ...row.result });
      }
      return row.result;
    },
    async publish(hostId, patch) {
      const host = hosts.get(hostId);
      if (!host || !patch || !ID.test(patch.chatId || '')) throw fault(409, 'Computer view is disconnected.');
      const workspace = await workspaceForChat(patch.chatId);
      if (workspace === null || hostFor(patch.chatId, workspace)?.hostId !== hostId) throw fault(409, 'Another computer view owns this chat.');
      const prior = snapshots.get(patch.chatId);
      const base = prior?.hostId === hostId && prior?.epoch === patch.epoch ? prior : null;
      let history = base?.history;
      if (patch.history) {
        const { start, messages, length } = patch.history;
        if (!Number.isSafeInteger(start) || start < 0 || !Array.isArray(messages) ||
            length !== start + messages.length) throw fault(400, 'Invalid transcript update.');
        if (!history || start < history.start) history = { start, messages, length };
        else {
          if (start > history.length) throw fault(409, 'Transcript update needs a fresh snapshot.');
          history = { start: history.start, messages: [...history.messages.slice(0, start - history.start), ...messages], length };
        }
      }
      let live = patch.live === undefined ? base?.live : patch.live;
      if (patch.liveAppend) {
        const append = patch.liveAppend;
        if (!live || live.lastDelta.length !== append.textOffset || live.lastThinking.length !== append.thinkingOffset ||
            typeof append.text !== 'string' || typeof append.thinking !== 'string') throw fault(409, 'Live output needs a fresh snapshot.');
        live = { ...live, lastDelta: live.lastDelta + append.text, lastThinking: live.lastThinking + append.thinking };
      }
      const historyChars = patch.history ? JSON.stringify(history).length : base?.historyChars ?? 0;
      const fieldsChars = patch.fields ? JSON.stringify(patch.fields).length : base?.fieldsChars ?? 0;
      const chars = historyChars + fieldsChars + (live ? live.lastDelta.length + live.lastThinking.length : 0) + 1024;
      const frame = { chatId: patch.chatId, hostId, workspace, epoch: patch.epoch, sequence: ++sequence, at: now(),
        historyChars, fieldsChars, bytes: chars * 2,
        fields: patch.fields ?? base?.fields, history, live,
        running: patch.running === true };
      if (chars > MAX_FRAME) throw fault(413, 'Live chat snapshot is too large.');
      let retained = snapshotBytes - (snapshots.get(frame.chatId)?.bytes ?? 0) + frame.bytes;
      for (const [id, row] of snapshots) {
        if (retained <= 32 * 1024 * 1024) break;
        if (id !== frame.chatId && !row.running) { snapshots.delete(id); retained -= row.bytes; snapshotBytes -= row.bytes; }
      }
      if (retained > 32 * 1024 * 1024) throw fault(429, 'Live transcript memory limit reached.');
      if (!snapshots.has(frame.chatId) && snapshots.size >= 64) {
        const idle = [...snapshots].find(([, row]) => !row.running);
        if (!idle) throw fault(429, 'Too many live chats.');
        snapshots.delete(idle[0]); snapshotBytes -= idle[1].bytes;
      }
      snapshotBytes += frame.bytes - (snapshots.get(frame.chatId)?.bytes ?? 0);
      snapshots.set(frame.chatId, frame);
      const delta = { ...patch, hostId, workspace, sequence: frame.sequence };
      for (const viewer of viewers) if (key(viewer.workspace) === key(workspace)) viewer.send({ kind: 'frame', frame: delta });
      return frame.sequence;
    },
  };
}

function openStream(req, res, attach) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  const send = value => {
    if (res.destroyed || res.writableEnded) return;
    // Disconnect a slow consumer; reconnect replays the coalesced snapshot or
    // unacknowledged commands, without retaining an unbounded token queue.
    if (res.writableLength > MAX_FRAME) { res.destroy(); return; }
    res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  let detach;
  try { detach = attach(send); } catch { res.destroy(); return; }
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 15_000);
  heartbeat.unref?.();
  res.once('close', () => { clearInterval(heartbeat); detach(); });
}

export function createChatLiveMiddleware(turns, options) {
  const broker = createChatLiveBroker({ turns, ...options });
  return async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/chat-sync/')) return next();
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
    const hostOnly = () => { if (req.minnowAuth?.kind !== 'host') throw fault(403, 'Only the computer may run chats.'); };
    const deviceId = req.minnowAuth?.kind === 'device' ? req.minnowAuth.deviceId : 'host';
    try {
      if (req.method === 'GET' && url.pathname === '/api/chat-sync/events') {
        openStream(req, res, write => broker.subscribe(getEffectiveWorkspaceRoot(), write, deviceId)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/chat-sync/host') {
        hostOnly();
        const hostId = url.searchParams.get('hostId');
        if (!ID.test(hostId || '')) throw fault(400, 'Invalid computer view.');
        openStream(req, res, write => broker.register(hostId, getEffectiveWorkspaceRoot(), write)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/chat-sync/result') {
        send(200, broker.result(url.searchParams.get('id'), deviceId)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/chat-sync/snapshot') {
        send(200, broker.snapshot(url.searchParams.get('chatId'), getEffectiveWorkspaceRoot())); return;
      }
      if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw fault(413, 'Chat command is too large.');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/api/chat-sync/commands') { send(202, await broker.submit(body, deviceId)); return; }
      hostOnly();
      if (url.pathname === '/api/chat-sync/ack') { send(200, broker.acknowledge(body.id, body.hostId, body)); return; }
      if (url.pathname === '/api/chat-sync/publish') { send(200, { sequence: await broker.publish(body.hostId, body.frame) }); return; }
      send(404, { error: 'Not found' });
    } catch (error) { send(error.status || 400, { error: error.message || 'Chat connection failed.' }); }
  };
}
