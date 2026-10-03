import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const resume = process.argv[3] === 'resume';
const source = process.argv[2];
let entries = resume ? fs.readFileSync(source, 'utf8').trim().split('\n').map(JSON.parse) : [];
const sessionId = resume ? entries[0].sessionId : source;
const directory = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, `${sessionId}.jsonl`);
const send = row => process.stdout.write(`${JSON.stringify(row)}\n`);
let cost = 0;
const save = () => fs.writeFileSync(file, entries.map(row => JSON.stringify(row)).join('\n') + '\n');
createInterface({ input: process.stdin }).on('line', async line => {
  const input = JSON.parse(line);
  entries.push({ type: 'user', sessionId, message: input.message }); save();
  const inputText = typeof input.message.content === 'string' ? input.message.content : input.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (inputText.includes('HANG')) return;
  if (inputText.includes('CRASH')) { process.exit(1); return; }
  let toolResult;
  if (inputText.includes('TOOL') && !inputText.includes('"role":"tool"')) {
    const toolId = randomUUID(), messageId = randomUUID();
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId, usage: { input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 1 } } } });
    entries.push({ type: 'assistant', sessionId, message: { id: messageId, content: [{ type: 'tool_use', id: toolId, name: 'mcp__minnow__read_file', input: { path: 'src/main.ts' } }] } }); save(); cost += .01;
    if (process.env.FAKE_CLAUDE_TOOL_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_TOOL_LOG, 'read_file\n');
    const response = await fetch(process.env.MINNOW_CLI_BRIDGE_URL, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MINNOW_CLI_BRIDGE_TOKEN}` },
      body: JSON.stringify({ name: 'read_file', arguments: { path: 'src/main.ts' } }) });
    const result = await response.json(); toolResult = result.content[0].text;
    entries.push({ type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: toolResult }] } }); save();
  }
  const humanTurns = entries.filter(row => row.type === 'user' && (typeof row.message.content === 'string' || row.message.content.some(part => part.type === 'text'))).length;
  const id = randomUUID(), text = toolResult ? `Used ${toolResult}` : `Reply ${humanTurns}.`;
  send({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 1 } } } });
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  send({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 3 } } });
  entries.push({ type: 'assistant', sessionId, message: { id, content: [{ type: 'text', text }] } }); save(); cost += .01;
  send({ type: 'assistant', uuid: id, message: { id, content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 3 } } });
  send({ type: 'result', uuid: randomUUID(), subtype: 'success', result: text, total_cost_usd: cost,
    usage: { input_tokens: 99999, output_tokens: 99999 } });
});
