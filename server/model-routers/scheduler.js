export const entryKey = (entry) => JSON.stringify([entry.providerId.trim(), entry.modelId.trim()]);

export function validateRouters(value) {
  if (!value || !Array.isArray(value.routers) || value.routers.length > 100) throw new Error('Invalid routers');
  const ids = new Set();
  const routers = value.routers.map((router) => {
    if (!router || typeof router.id !== 'string' || !/^[\w-]{1,100}$/.test(router.id) || ids.has(router.id)) throw new Error('Invalid or duplicate router id');
    ids.add(router.id);
    if (typeof router.name !== 'string' || !router.name.trim() || router.name.length > 100) throw new Error('Router name is required (100 characters maximum)');
    if (!['priority', 'balance'].includes(router.policy)) throw new Error('Invalid routing policy');
    if (!Array.isArray(router.entries) || router.entries.length > 100) throw new Error('Invalid router entries');
    const entries = new Set();
    const pairs = new Set();
    return { id: router.id, name: router.name.trim(), enabled: router.enabled !== false, policy: router.policy,
      entries: router.entries.map((entry) => {
        if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,100}$/.test(entry.id) || entries.has(entry.id)) throw new Error('Invalid or duplicate entry id');
        if (typeof entry.providerId !== 'string' || !/^[\w-]{1,100}$/.test(entry.providerId) || typeof entry.modelId !== 'string' || !entry.modelId.trim() || entry.modelId.length > 500) throw new Error('Choose a configured provider and model');
        if (!Number.isInteger(entry.concurrencyLimit) || entry.concurrencyLimit < 1 || entry.concurrencyLimit > 100) throw new Error('Concurrency must be an integer from 1 to 100');
        if (pairs.has(entryKey(entry))) throw new Error('Provider/model pairs must be unique within a router');
        pairs.add(entryKey(entry)); entries.add(entry.id);
        return { id: entry.id, providerId: entry.providerId, modelId: entry.modelId.trim(), enabled: entry.enabled !== false, concurrencyLimit: entry.concurrencyLimit };
      }) };
  });
  const defaultRouterId = value.defaultRouterId || null;
  if (defaultRouterId && !routers.some((r) => r.id === defaultRouterId && r.enabled)) throw new Error('The default router must be enabled');
  return { routers, defaultRouterId };
}

export class RouterScheduler {
  constructor({ assignments = {}, onAssignment = () => {} } = {}) {
    this.assignments = assignments;
    this.onAssignment = onAssignment;
    this.active = new Map();
    this.queues = new Map();
    this.weights = new Map();
    this.events = [];
    this.requests = new Map();
    this.telemetry = new Map();
  }

  assignmentKey(routerId, chatId) { return JSON.stringify([routerId, chatId]); }

  emit(router, chatId, entry, status, error) {
    this.events.push({ routerId: router.id, chatId, entryId: entry?.id, status, timestamp: new Date().toISOString(), ...(error ? { error } : {}) });
    if (this.events.length > 500) this.events.shift();
  }

  override(router, chatId, entryId) {
    if (entryId && !router.entries.some((e) => e.id === entryId && e.enabled)) throw new Error('Choose an enabled entry');
    const key = this.assignmentKey(router.id, chatId);
    const previous = this.assignments[key];
    this.assignments[key] = { chatId, routerId: router.id, assignmentMode: entryId ? 'override' : 'router', assignedEntryId: entryId || previous?.assignedEntryId || '', ...(entryId ? { overrideEntryId: entryId } : {}) };
    this.onAssignment(this.assignments);
  }

  select(router, chatId, eligible, attempted = new Set(), { preferAvailable = false } = {}) {
    const candidates = router.enabled ? router.entries.filter((e) => e.enabled && eligible(e) && !attempted.has(entryKey(e))) : [];
    if (!candidates.length) throw new Error(`No eligible models in ${router.name}. Enable an entry and check its provider, credentials, model availability, and request capabilities in Models.`);
    const key = this.assignmentKey(router.id, chatId);
    const assignment = this.assignments[key];
    const sticky = assignment?.assignedEntryId;
    let chosen = candidates.find((e) => e.id === sticky);
    const free = candidates.filter((e) => (this.active.get(entryKey(e)) || 0) < e.concurrencyLimit && !(this.queues.get(entryKey(e)) || []).length);
    // Workers may move between rounds when their previous model is occupied.
    // Explicit overrides retain their queueing semantics.
    if (preferAvailable && assignment?.assignmentMode !== 'override' && free.length && !free.includes(chosen)) chosen = undefined;
    if (!chosen) {
      const pool = free.length ? free : candidates;
      if (router.policy === 'balance') {
        let total = 0;
        let best = -Infinity;
        for (const entry of pool) {
          const weight = router.entries.length - router.entries.indexOf(entry);
          const weightKey = `${router.id}:${entry.id}`;
          const score = (this.weights.get(weightKey) || 0) + weight;
          this.weights.set(weightKey, score); total += weight;
          if (score > best) { chosen = entry; best = score; }
        }
        const weightKey = `${router.id}:${chosen.id}`;
        this.weights.set(weightKey, this.weights.get(weightKey) - total);
      } else chosen = pool[0];
    }
    this.assignments[key] = { chatId, routerId: router.id, assignmentMode: assignment?.assignmentMode || 'router', assignedEntryId: chosen.id, ...(assignment?.overrideEntryId ? { overrideEntryId: assignment.overrideEntryId } : {}) };
    this.onAssignment(this.assignments);
    return chosen;
  }

  acquire(router, chatId, entry, signal, requestId = crypto.randomUUID()) {
    const key = entryKey(entry);
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(key) || [];
      this.queues.set(key, queue);
      const request = { router, chatId, entry, requestId, signal, resolve, reject, status: 'queued' };
      request.abort = () => {
        const index = queue.indexOf(request);
        if (index >= 0) queue.splice(index, 1);
        this.requests.delete(requestId);
        signal?.removeEventListener('abort', request.abort);
        reject(new DOMException('Aborted', 'AbortError'));
        this.drain(key);
      };
      if (signal?.aborted) { request.abort(); return; }
      signal?.addEventListener('abort', request.abort, { once: true });
      queue.push(request); this.requests.set(requestId, request);
      this.emit(router, chatId, entry, 'queued');
      this.drain(key);
    });
  }

  drain(key) {
    const queue = this.queues.get(key) || [];
    while (queue.length && (this.active.get(key) || 0) < queue[0].entry.concurrencyLimit) {
      const request = queue.shift();
      request.signal?.removeEventListener('abort', request.abort);
      this.active.set(key, (this.active.get(key) || 0) + 1);
      request.status = 'active';
      this.emit(request.router, request.chatId, request.entry, 'assigned');
      const started = Date.now();
      let released = false;
      request.resolve((error, usage) => {
        if (released) return;
        released = true;
        this.active.set(key, Math.max(0, (this.active.get(key) || 1) - 1));
        this.requests.delete(request.requestId);
        const stats = this.telemetry.get(key) || { completed: 0, errors: 0, latencyMs: 0, tokens: 0, promptTokens: 0, completionTokens: 0, usageSamples: 0 };
        stats.completed++; stats.errors += error ? 1 : 0; stats.latencyMs += Date.now() - started;
        stats.tokens += Number(usage?.total_tokens) || 0;
        stats.promptTokens += Number(usage?.prompt_tokens) || 0;
        stats.completionTokens += Number(usage?.completion_tokens) || 0;
        if (usage) stats.usageSamples++;
        this.telemetry.set(key, stats);
        this.emit(request.router, request.chatId, request.entry, error ? 'failed' : 'completed', error);
        this.drain(key);
      });
    }
  }

  rejectQueued(requestId, reason) {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'queued') return;
    const key = entryKey(request.entry);
    const queue = this.queues.get(key) || [];
    const index = queue.indexOf(request);
    if (index >= 0) queue.splice(index, 1);
    request.signal?.removeEventListener('abort', request.abort);
    this.requests.delete(requestId);
    request.reject(new Error(reason));
    this.drain(key);
  }

  activity(router) {
    return { assignments: Object.values(this.assignments).filter((a) => a.routerId === router.id),
      requests: [...this.requests.values()].filter((r) => r.router.id === router.id).map((r) => ({ chatId: r.chatId, entryId: r.entry.id, status: r.status, requestId: r.requestId })),
      entries: router.entries.map((entry) => ({ entryId: entry.id, active: this.active.get(entryKey(entry)) || 0, queued: (this.queues.get(entryKey(entry)) || []).length, telemetry: this.telemetry.get(entryKey(entry)) || null })),
      events: this.events.filter((e) => e.routerId === router.id) };
  }
}
