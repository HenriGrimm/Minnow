import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
const send = row => process.stdout.write(`${JSON.stringify(row)}\n`);
const event = (method, params) => send({ method, params });
const scripts = JSON.parse(process.env.MINNOW_CODEX_SCRIPTS ?? '[]');
let thread = 0, turn = 0, requestId = 0, total = 0, steps = 0;
const histories = new Map(), active = new Map(), pending = new Map();
const turns = new Map();
const store = path.join(process.cwd(), 'fixture-thread.json');
function save(tid) { fs.writeFileSync(store, JSON.stringify({ id: tid, turns: turns.get(tid), histories: histories.get(tid), turn, total, steps })); }
async function step(tid, turnId) {
  const script = scripts.shift() ?? { text: 'Reply.' };
  steps++;
  if (script.hang) return;
  if (script.crash) { process.exit(1); return; }
  if (script.error) { event('turn/completed', { threadId: tid, turn: { id: turnId, status: 'failed', error: { message: script.error } } }); return; }
  if (script.compact) { event('item/started', { threadId: tid, turnId, item: { id: 'compact', type: 'contextCompaction' } }); return; }
  if (script.reasoning) {
    const itemId = `reasoning-${turnId}-${steps}`;
    event('item/reasoning/summaryTextDelta', { threadId: tid, turnId, itemId, delta: script.reasoning });
    event('item/completed', { threadId: tid, turnId, item: { id: itemId, type: 'reasoning', summary: [script.reasoningSnapshot ?? script.reasoning] } });
  }
  if (script.calls) {
    if (script.text) event('item/agentMessage/delta', { threadId: tid, turnId, itemId: `preface-${turnId}`, delta: script.text });
    for (const call of script.calls) {
      for (let i = 0; i < (call.activityCount ?? 0); i++) {
        await new Promise(resolve => setTimeout(resolve, call.activityIntervalMs ?? 100));
        event('item/started', { threadId: tid, turnId, item: { id: `activity-${call.id}-${i}`, type: 'dynamicToolCall' } });
      }
      if (call.delayMs) await new Promise(resolve => setTimeout(resolve, call.delayMs));
      const id = ++requestId;
      const row = { id, method: 'item/tool/call', params: { threadId: tid, turnId, callId: call.id, tool: call.name, arguments: call.args ?? {} } };
      pending.set(id, { tid, turnId, call }); send(row); if (call.duplicate) send(row);
    }
    return;
  }
  const itemId = `msg-${turnId}`;
  event('item/started', { threadId: tid, turnId, item: { id: itemId, type: 'agentMessage', text: '' } });
  for (const delta of script.deltas ?? [script.text ?? 'Reply.']) {
    event('item/agentMessage/delta', { threadId: tid, turnId, itemId, delta });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  event('item/completed', { threadId: tid, turnId, item: { id: itemId, type: 'agentMessage', text: script.text ?? 'Reply.' } });
  total += 25;
  turns.get(tid).push({ id: turnId, status: 'completed', items: [{ type: 'agentMessage', text: script.text ?? 'Reply.' }] });
  save(tid);
  const tokenUsage = script.tokenUsage ?? { total: {
    inputTokens: total * .8, outputTokens: total * .2, totalTokens: total, cachedInputTokens: total * .16, reasoningOutputTokens: total * .04 },
    last: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 4, reasoningOutputTokens: 1 } };
  event('thread/tokenUsage/updated', { threadId: tid, turnId, tokenUsage });
  if (script.repeatUsage) event('thread/tokenUsage/updated', { threadId: tid, turnId, tokenUsage });
  event('turn/completed', { threadId: tid, turn: { id: turnId, status: 'completed' } });
}
createInterface({ input: process.stdin }).on('line', async line => {
  const row = JSON.parse(line), p = row.params ?? {};
  if (process.env.MINNOW_CODEX_REQUEST_LOG) fs.appendFileSync(process.env.MINNOW_CODEX_REQUEST_LOG, `${line}\n`);
  if (!row.method) {
    const entry = pending.get(row.id); pending.delete(row.id);
    if (entry && ![...pending.values()].some(item => item.turnId === entry.turnId)) await step(entry.tid, entry.turnId);
    return;
  }
  const respond = result => send({ id: row.id, result });
  if (row.method === 'initialize') respond({ userAgent: 'minnow/0.153.4' });
  else if (row.method === 'initialized') return;
  else if (row.method === 'thread/start') { const id = `thread-${++thread}`; histories.set(id, []); turns.set(id, []); save(id); respond({ thread: { id } }); }
  else if (row.method === 'thread/read') {
    const record = JSON.parse(fs.readFileSync(store, 'utf8'));
    respond({ thread: { id: record.id, turns: record.turns,
      ...(process.env.MINNOW_CODEX_ROLLOUT_PATH ? { path: fs.realpathSync(store) } : {}) } });
  } else if (row.method === 'thread/resume') {
    const record = JSON.parse(fs.readFileSync(store, 'utf8'));
    histories.set(record.id, record.histories); turns.set(record.id, record.turns); turn = record.turn; total = record.total;
    steps = record.steps ?? record.turns.length;
    scripts.splice(0, steps); respond({ thread: { id: record.id, turns: record.turns } });
  }
  else if (row.method === 'thread/inject_items') { histories.get(p.threadId).push(...p.items); respond({}); }
  else if (row.method === 'turn/start') {
    const id = `turn-${++turn}`; active.set(p.threadId, id);
    respond({ turn: { id } }); event('turn/started', { threadId: p.threadId, turn: { id } });
    await step(p.threadId, id);
  } else if (row.method === 'turn/interrupt') {
    if (process.env.MINNOW_CODEX_IGNORE_INTERRUPT === '1') return;
    respond({}); event('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } });
  } else respond({});
});
