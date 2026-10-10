import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const file = path.join(process.env.CURSOR_DATA_DIR || process.cwd(), 'cursor-native.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
let sessionId = 'cursor-session', history = [], pending = null;
const send = row => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...row })}\n`);
const update = row => send({ method: 'session/update', params: { sessionId, update: row } });
const save = () => fs.writeFileSync(file, JSON.stringify(history));
createInterface({ input: process.stdin }).on('line', async line => {
  const row = JSON.parse(line), p = row.params ?? {};
  if (process.env.ACP_CALL_LOG) fs.appendFileSync(process.env.ACP_CALL_LOG, `${row.method ?? 'response'}\n`);
  const respond = result => send({ id: row.id, result });
  if (row.method === 'initialize') {
    if (p.clientCapabilities.fs.readTextFile || p.clientCapabilities.fs.writeTextFile || p.clientCapabilities.terminal) process.exit(2);
    respond({ protocolVersion: 1, agentCapabilities: { loadSession: process.env.ACP_UNAVAILABLE !== '1' } });
  } else if (row.method === 'authenticate') respond({});
  // Like the real CLI: nothing is stored until the first prompt, so an empty
  // session cannot be loaded back.
  else if (row.method === 'session/new') { history = []; fs.rmSync(file, { force: true }); respond({ sessionId, models: { currentModelId: process.env.ACP_WRONG_MODEL ? 'wrong' : 'fixture' }, configOptions: [] }); }
  else if (row.method === 'session/load') {
    if (!fs.existsSync(file)) { send({ id: row.id, error: { code: -32602, message: 'Invalid params', data: { message: `Session "${p.sessionId}" not found` } } }); return; }
    history = JSON.parse(fs.readFileSync(file, 'utf8')); for (const item of history) update(item); respond({ models: { currentModelId: 'fixture' }, configOptions: [] });
  }
  else if (row.method === 'session/cancel') return;
  else if (row.method === 'session/prompt') {
    const text = p.prompt[0].text;
    const user = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
    history.push(user); update(user);
    if (text.includes('NATIVE')) {
      send({ id: 99, method: 'session/request_permission', params: { sessionId,
        toolCall: { title: 'Shell', rawInput: { command: 'touch forbidden' } }, options: [{ kind: 'allow_once', optionId: 'allow-once' }] } });
      pending = row.id; return;
    }
    if (text.includes('BLOCKING')) { send({ id: 98, method: 'cursor/create_plan', params: { sessionId } }); pending = row.id; return; }
    let reply = `Reply ${history.filter(item => item.sessionUpdate === 'user_message_chunk').length}.`;
    if (text.includes('TOOL')) {
      // Real Cursor sequence: an unnamed placeholder, then the named call.
      const placeholder = { sessionUpdate: 'tool_call', toolCallId: 'native-tool', title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} };
      history.push(placeholder); update(placeholder);
      const tool = { sessionUpdate: 'tool_call_update', toolCallId: 'native-tool', title: process.env.ACP_FOREIGN_MCP ? 'other: read_file' : 'minnow: read_file',
        rawInput: { providerIdentifier: process.env.ACP_FOREIGN_MCP ? 'other' : 'minnow', toolName: 'read_file', args: { path: 'src/main.ts' } } };
      history.push(tool); update(tool);
      const res = await fetch(process.env.MINNOW_CLI_BRIDGE_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MINNOW_CLI_BRIDGE_TOKEN}` },
        body: JSON.stringify({ name: 'read_file', arguments: { path: 'src/main.ts' } }) });
      const result = await res.json(); reply = `Used ${result.content[0].text}`;
      const complete = { ...tool, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: result };
      history.push(complete); update(complete);
    }
    const assistant = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } };
    history.push(assistant); update(assistant); save(); respond({ stopReason: 'end_turn' });
  } else if (pending && (row.id === 99 || row.id === 98)) {
    if (!row.error) fs.writeFileSync(path.join(process.cwd(), 'forbidden'), 'unexpected approval');
    send({ id: pending, result: { stopReason: 'cancelled' } });
  }
});
