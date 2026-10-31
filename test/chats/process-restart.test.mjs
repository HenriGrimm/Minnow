import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHAT_MIN_CLIENT_VERSION } from '../../server/chats/contracts.js';

const hostScript = fileURLToPath(new URL('./process-restart-host.mjs', import.meta.url));
const tool = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function until(read, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Process restart did not reach ${label}${last ? ': ' + last : ''}`);
}
async function killOwned(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;
}
async function launch(root, upstream) {
  const child = fork(hostScript, [root, upstream], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
    env: { ...process.env, MINNOW_HOME: path.join(root, 'home'), MINNOW_AGENT_CONVERSATIONS: '1', NODE_ENV: 'test' } });
  let errors = '';
  child.stdout.resume(); child.stderr.on('data', chunk => { if (errors.length < 8000) errors += chunk; });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture startup timed out: ' + errors)), 25000);
      child.on('message', message => { if (message?.kind === 'ready') { clearTimeout(timeout); resolve(message); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Fixture exited ' + code + ': ' + errors)); });
    });
    const base = 'http://127.0.0.1:' + ready.port;
    return { child, async request(route, body) {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': String(CHAT_MIN_CLIENT_VERSION) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
    } };
  } catch (error) { await killOwned(child); throw error; }
}

test('an actual server crash resumes the original child question and attempt, replays no completed tools, and wakes its parent once', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-process-restart-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'evidence.txt'), 'Durable evidence from the real read_file tool.');
  let host; const calls = [];
  const upstream = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'parent-model' }, { id: 'child-model' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); calls.push(body);
    const tools = body.messages.filter(row => row.role === 'tool'), lastUser = String(body.messages.filter(row => row.role === 'user').at(-1)?.content ?? '');
    let result;
    if (body.model === 'child-model') {
      if (!tools.some(row => row.tool_call_id === 'child-read')) result = [tool('read_file', { path: 'evidence.txt' }, 'child-read')];
      else if (!tools.some(row => row.tool_call_id === 'child-question')) result = [tool('ask_question', { questions: [{ id: 'version', prompt: 'Which version should I inspect?',
        options: [{ id: 'one', label: 'Version one' }, { id: 'two', label: 'Version two' }] }] }, 'child-question')];
      else result = [tool('report_outcome', { outcome: 'pass', summary: 'Recovered child inspected Version two.', evidence: ['Canonical read result and saved human answer.'] }, 'child-report')];
    } else if (lastUser.includes('[Sub-agent finished]')) result = 'Parent incorporated the recovered child result.';
    else if (!tools.length) result = [tool('spawn_sub_agent', { type: 'reviewer', task: 'Restart child assignment', wait: false,
      target: { providerId: 'process-fixture', modelId: 'child-model', options: {} }, client_request_id: 'restart-child' }, 'parent-spawn')];
    else result = 'Parent is waiting for its delegated review.';
    const delta = Array.isArray(result) ? { tool_calls: result.map((call, index) => ({ ...call, index })) } : { content: result };
    response.setHeader('Content-Type', 'text/event-stream'); response.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: Array.isArray(result) ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  t.after(async () => {
    await killOwned(host?.child); upstream.closeAllConnections(); if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    const absolute = path.resolve(root); assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('minnow-process-restart-')); await fs.rm(absolute, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  const address = 'http://127.0.0.1:' + upstream.address().port;
  host = await launch(root, address);
  await host.request('/api/chats/restart-parent/commands', { action: 'send', text: 'Start restart workflow by delegating one reviewer.', clientRequestId: 'start-workflow' });
  const before = await until(async () => {
    const state = await host.request('/__fixture/state'), child = state.chats.find(chat => chat.relation?.parentChatId === 'restart-parent');
    const parent = state.chats.find(chat => chat.id === 'restart-parent');
    return child?.execution?.status === 'waiting_for_input' && child.requests.some(row => row.state === 'pending') && parent?.execution?.status === 'completed' ? { state, child } : null;
  }, 'durably saved child question');
  assert.equal(before.state.sqlite.journal, 'wal'); assert.equal(before.state.sqlite.synchronous, 2);
  const request = before.child.requests.find(row => row.state === 'pending'), execution = before.child.execution;
  const run = before.state.runs.find(row => row.childChatId === before.child.id), attempt = run.attempts[0];
  assert.equal(before.child.history.filter(row => row.role === 'tool' && row.tool_call_id === 'child-read').length, 1);
  assert.match(before.child.history.find(row => row.role === 'tool' && row.tool_call_id === 'child-read').content, /Durable evidence from the real read_file tool/);
  assert.deepEqual(before.state.reads, [{ executionId: execution.executionId, toolCallId: 'child-read' }]);
  assert.equal(before.state.events.filter(row => row.type === 'attempt.started').length, 1);
  const preCrashCalls = calls.length, firstPid = host.child.pid;
  await killOwned(host.child);
  host = await launch(root, address); assert.notEqual(host.child.pid, firstPid);
  const resumed = await until(async () => {
    const state = await host.request('/__fixture/state'), child = state.chats.find(chat => chat.id === before.child.id);
    return child?.questionWaiters.includes(request.requestId) ? { state, child } : null;
  }, 'same pending request attached to restarted server');
  assert.equal(calls.length, preCrashCalls, 'no inference or completed tool replay before the saved answer');
  assert.equal(resumed.child.execution.executionId, execution.executionId);
  assert.equal(resumed.child.execution.attemptId, attempt.attemptId);
  assert.ok(resumed.child.lease.epoch > before.child.lease.epoch, 'the restarted owner renews its fence without replacing the execution');
  assert.equal(resumed.child.requests.find(row => row.requestId === request.requestId).state, 'pending');
  await host.request(`/api/chats/${before.child.id}/requests/${request.requestId}/respond`, { clientRequestId: 'saved-answer', answer: 'Version two' });
  const after = await until(async () => {
    const state = await host.request('/__fixture/state'), child = state.chats.find(chat => chat.id === before.child.id), parent = state.chats.find(chat => chat.id === 'restart-parent');
    const wake = parent?.commands.filter(row => row.effectiveCommand.provenance.kind === 'delegation_result');
    return child?.commands.some(row => row.state === 'settled') && wake?.length === 1 && wake[0].state === 'settled' ? { state, child, parent, wake } : null;
  }, 'one settled original child and one parent wake');
  const finalRun = after.state.runs.find(row => row.runId === run.runId);
  assert.equal(finalRun.attempts.length, 1); assert.equal(finalRun.attempts[0].attemptId, attempt.attemptId);
  assert.equal(finalRun.attempts[0].executionId, execution.executionId); assert.equal(finalRun.phase, 'passed');
  assert.equal(after.child.execution.executionId, execution.executionId);
  for (const id of ['child-read', 'child-question']) assert.equal(after.child.history.filter(row => row.role === 'tool' && row.tool_call_id === id).length, 1);
  assert.equal(after.child.history.filter(row => row.role === 'user' && row.commandId === execution.commandId).length, 1);
  assert.equal(after.parent.history.filter(row => row.provenance?.kind === 'delegation_result').length, 1);
  assert.equal(after.state.events.filter(row => row.type === 'attempt.started').length, 1);
  assert.deepEqual(after.state.reads, before.state.reads, 'the real read dispatcher never executes a completed canonical call again');
  assert.equal(await fs.readFile(path.join(workspace, 'evidence.txt'), 'utf8'), 'Durable evidence from the real read_file tool.');
  assert.equal(calls.filter(body => body.model === 'child-model').length, 3);
});
