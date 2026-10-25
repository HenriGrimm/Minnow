import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const file = path.join(process.env.CURSOR_DATA_DIR || process.cwd(), 'cursor-native.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
let sessionId = 'cursor-session', history = [], pending = null;
const send = row => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...row })}\n`);
const update = row => send({ method: 'session/update', params: { sessionId, update: row } });
const save = () => fs.writeFileSync(file, JSON.stringify(history));
function cancelPrompt() {
  if (!pending) return;
  if (pending.toolId) {
    const failed = { sessionUpdate: 'tool_call_update', toolCallId: pending.toolId, status: 'failed' };
    history.push(failed); update(failed);
  }
  if (process.env.ACP_LATE_TEXT) {
    const late = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cancelled draft.' } };
    history.push(late); update(late);
  }
  save();
  send(process.env.ACP_CANCEL_ERROR ? { id: pending.id, error: { code: -32800, message: 'Cancelled' } }
    : { id: pending.id, result: { stopReason: 'cancelled' } });
  pending = null;
}
createInterface({ input: process.stdin }).on('line', async line => {
  const row = JSON.parse(line), p = row.params ?? {};
  if (process.env.ACP_CALL_LOG) fs.appendFileSync(process.env.ACP_CALL_LOG, `${row.method ?? 'response'}\n`);
  const respond = result => send({ id: row.id, result });
  if (['session/new', 'session/load'].includes(row.method) && process.env.ACP_EXPECT_MCP
    && JSON.stringify(p.mcpServers) !== process.env.ACP_EXPECT_MCP) {
    send({ id: row.id, error: { code: -32602, message: 'Missing session MCP configuration' } }); return;
  }
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
  else if (row.method === 'session/cancel') { if (!process.env.ACP_IGNORE_CANCEL) cancelPrompt(); }
  else if (row.method === 'session/prompt') {
    const text = p.prompt[0].text;
    const user = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
    history.push(user); update(user);
    const recovery = text.startsWith('Cursor rejected unexposed native tool');
    if (text.includes('EDIT_NATIVE') || process.env.ACP_REPEAT_NATIVE && recovery) {
      pending = { id: row.id, toolId: `edit-${history.length}` };
      const call = { sessionUpdate: 'tool_call', toolCallId: pending.toolId, title: 'Edit File', kind: 'edit', status: 'pending', rawInput: {} };
      history.push(call); update(call);
      if (process.env.ACP_EDIT_PERMISSION) send({ id: 99, method: 'session/request_permission', params: { sessionId,
        toolCall: { toolCallId: pending.toolId }, options: [{ kind: 'allow_once', optionId: 'allow-once' }] } });
      return;
    }
    if (text.includes('NATIVE')) {
      pending = { id: row.id };
      send({ id: 99, method: 'session/request_permission', params: { sessionId,
        toolCall: { title: 'Shell', rawInput: { command: 'touch forbidden' } }, options: [{ kind: 'allow_once', optionId: 'allow-once' }] } });
      return;
    }
    if (text.includes('BLOCKING')) { pending = { id: row.id }; send({ id: 98, method: 'cursor/create_plan', params: { sessionId } }); return; }
    let reply = `Reply ${history.filter(item => item.sessionUpdate === 'user_message_chunk').length}.`;
    if (text.includes('TOOL') || recovery && process.env.ACP_RECOVERY_TOOL) {
      // Real Cursor sequence: an unnamed placeholder, then the named call.
      const placeholder = { sessionUpdate: 'tool_call', toolCallId: 'native-tool', title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} };
      history.push(placeholder); update(placeholder);
      const foreign = process.env.ACP_FOREIGN_MCP && !recovery;
      const tool = { sessionUpdate: 'tool_call_update', toolCallId: 'native-tool', title: foreign ? 'other: read_file' : 'minnow: read_file',
        rawInput: { providerIdentifier: foreign ? 'other' : 'minnow', toolName: 'read_file', args: { path: 'src/main.ts' } } };
      history.push(tool); update(tool);
      if (foreign) { pending = { id: row.id, toolId: 'native-tool' }; return; }
      const res = await fetch(process.env.MINNOW_CLI_BRIDGE_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MINNOW_CLI_BRIDGE_TOKEN}` },
        body: JSON.stringify({ name: 'read_file', arguments: { path: 'src/main.ts' } }) });
      const result = await res.json(); reply = `Used ${result.content[0].text}`;
      const complete = { ...tool, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: result };
      history.push(complete); update(complete);
    }
    const assistant = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } };
    history.push(assistant); update(assistant); save(); respond({ stopReason: 'end_turn' });
  } else if (row.id === 99 || row.id === 98) {
    if (!row.error && row.result?.outcome?.outcome !== 'cancelled') fs.writeFileSync(path.join(process.env.CURSOR_DATA_DIR || process.cwd(), 'forbidden'), 'unexpected approval');
    cancelPrompt();
  }
});
