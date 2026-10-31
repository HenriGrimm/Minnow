import { listGenerationStates } from '../generations/store.js';
import { validateModelSelection } from '../chats/contracts.js';

const LEASE_MS = 30_000;
const ID_RE = /^[a-zA-Z0-9_-]{1,160}$/;

/** One renderer owns the entire tool loop, including the gaps between generations. */
export function createChatTurnRegistry({ now = Date.now, generations = listGenerationStates,
  isServerOwned = () => false, extraTurns = () => [], canClaim = () => true, captureCancellationEpoch = () => undefined, onRenew, onRelease } = {}) {
  const turns = new Map();
  const liveGeneration = (chatId) => generations().some(state => state.chatId === chatId &&
    (state.status === 'pending' || state.status === 'streaming'));
  const get = (chatId) => {
    const turn = turns.get(chatId);
    // An expired renderer must not be replaced while its native CLI is still busy.
    if (turn && turn.expiresAt <= now() && !liveGeneration(chatId)) {
      turns.delete(chatId);
      onRelease?.(chatId, turn.ownerId);
    }
    return turns.get(chatId);
  };
  const listLegacy = () => {
      return [...turns.keys()].flatMap(chatId => {
        const turn = get(chatId);
        return turn ? [{ chatId, ownerId: turn.ownerId, ...(turn.hostId ? { hostId: turn.hostId } : {}) }] : [];
      });
  };
  return {
    listLegacy,
    list() { const legacy = listLegacy(); return [...legacy, ...extraTurns().filter(row => !legacy.some(item => item.chatId === row.chatId))]; },
    getModelSelection(chatId, ownerId) { const current = get(chatId); return current?.ownerId === ownerId && current.modelSelection ? structuredClone(current.modelSelection) : undefined; },
    getCancellationEpoch(chatId, ownerId) { const current = get(chatId); return current?.ownerId === ownerId ? current.cancellationEpoch : undefined; },
    claim(chatId, ownerId, hostId, modelSelection) {
      if (isServerOwned(chatId) || !canClaim(chatId, ownerId)) return false;
      const current = get(chatId);
      if (current && current.ownerId !== ownerId) return false;
      // A reload can reuse its tab's owner id after the old reader disconnects.
      // An attached reader (including one from a duplicated tab) still owns it.
      if (generations().some(state => state.chatId === chatId &&
          (state.status === 'pending' || state.status === 'streaming') && state.subscribers.size > 0)) return false;
      const selection = current?.modelSelection ?? modelSelection;
      turns.set(chatId, { ownerId, ...(hostId ? { hostId } : {}), ...(selection ? { modelSelection: structuredClone(selection) } : {}),
        cancellationEpoch: current?.cancellationEpoch ?? captureCancellationEpoch(chatId), expiresAt: now() + LEASE_MS });
      return true;
    },
    renew(chatId, ownerId) {
      const current = get(chatId);
      if (!current || current.ownerId !== ownerId) return false;
      if (onRenew?.(chatId, ownerId) === false) return false;
      current.expiresAt = now() + LEASE_MS;
      return true;
    },
    release(chatId, ownerId) {
      const turn = turns.get(chatId);
      if (turn?.ownerId !== ownerId) return;
      // Cancellation reaches the CLI asynchronously. Keep the fence until that
      // generation settles, even if its renderer has already finished teardown.
      if (liveGeneration(chatId)) { turn.expiresAt = now(); turn.releasing = true; }
      else { onRelease?.(chatId, ownerId); turns.delete(chatId); }
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
      const { action, chatId, ownerId, hostId, modelSelection } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const selected = modelSelection === undefined ? null : validateModelSelection(modelSelection);
      if (selected && !selected.ok) { send(400, { error: selected.error.message }); return; }
      if (typeof chatId !== 'string' || typeof ownerId !== 'string' ||
          !ID_RE.test(chatId) || !ID_RE.test(ownerId) ||
          !['claim', 'renew', 'release'].includes(action)) {
        send(400, { error: 'Invalid chat turn request' }); return;
      }
      if (action === 'release') { registry.release(chatId, ownerId); send(200, { ok: true }); return; }
      const ok = action === 'claim' ? registry.claim(chatId, ownerId, typeof hostId === 'string' && ID_RE.test(hostId) ? hostId : undefined, selected?.value) : registry.renew(chatId, ownerId);
      send(ok ? 200 : 409, { ok, ...(ok ? { leaseMs: LEASE_MS } : {}) });
    } catch {
      send(400, { error: 'Invalid chat turn request' });
    }
  };
}
