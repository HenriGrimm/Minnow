import { listGenerationStates } from '../generations/store.js';

const LEASE_MS = 30_000;
const ID_RE = /^[a-zA-Z0-9_-]{1,160}$/;

/** One renderer owns the entire tool loop, including the gaps between generations. */
export function createChatTurnRegistry({ now = Date.now, generations = listGenerationStates } = {}) {
  const turns = new Map();
  const liveGeneration = (chatId) => generations().some(state => state.chatId === chatId &&
    (state.status === 'pending' || state.status === 'streaming'));
  const get = (chatId) => {
    const turn = turns.get(chatId);
    // An expired renderer must not be replaced while its native CLI is still busy.
    if (turn && turn.expiresAt <= now() && !liveGeneration(chatId)) turns.delete(chatId);
    return turns.get(chatId);
  };
  return {
    list() {
      return [...turns.keys()].flatMap(chatId => {
        const turn = get(chatId);
        return turn ? [{ chatId, ownerId: turn.ownerId, ...(turn.hostId ? { hostId: turn.hostId } : {}) }] : [];
      });
    },
    claim(chatId, ownerId, hostId) {
      const current = get(chatId);
      if (current && current.ownerId !== ownerId) return false;
      // A reload can reuse its tab's owner id after the old reader disconnects.
      // An attached reader (including one from a duplicated tab) still owns it.
      if (generations().some(state => state.chatId === chatId &&
          (state.status === 'pending' || state.status === 'streaming') && state.subscribers.size > 0)) return false;
      turns.set(chatId, { ownerId, ...(hostId ? { hostId } : {}), expiresAt: now() + LEASE_MS });
      return true;
    },
    renew(chatId, ownerId) {
      const current = get(chatId);
      if (!current || current.ownerId !== ownerId) return false;
      current.expiresAt = now() + LEASE_MS;
      return true;
    },
    release(chatId, ownerId) {
      const turn = turns.get(chatId);
      if (turn?.ownerId !== ownerId) return;
      // Cancellation reaches the CLI asynchronously. Keep the fence until that
      // generation settles, even if its renderer has already finished teardown.
      if (liveGeneration(chatId)) turn.expiresAt = now();
      else turns.delete(chatId);
    },
  };
}

export function createChatTurnsMiddleware(registry = createChatTurnRegistry()) {
  return async (req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/chat-turns') return next();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (req.method === 'GET') { send(200, { turns: registry.list() }); return; }
    if (req.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }
    if (req.minnowAuth?.kind === 'device') { send(403, { error: 'Only the computer may run chats.' }); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { send(413, { error: 'Body too large' }); return; }
        chunks.push(chunk);
      }
      const { action, chatId, ownerId, hostId } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof chatId !== 'string' || typeof ownerId !== 'string' ||
          !ID_RE.test(chatId) || !ID_RE.test(ownerId) ||
          !['claim', 'renew', 'release'].includes(action)) {
        send(400, { error: 'Invalid chat turn request' }); return;
      }
      if (action === 'release') { registry.release(chatId, ownerId); send(200, { ok: true }); return; }
      const ok = action === 'claim' ? registry.claim(chatId, ownerId, typeof hostId === 'string' && ID_RE.test(hostId) ? hostId : undefined) : registry.renew(chatId, ownerId);
      send(ok ? 200 : 409, { ok });
    } catch {
      send(400, { error: 'Invalid chat turn request' });
    }
  };
}
