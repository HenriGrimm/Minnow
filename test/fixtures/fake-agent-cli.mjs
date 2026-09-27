import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLAUDE_OK_EVENTS = [
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 8, cache_read_input_tokens: 4 } } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Consider it.' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello 🌊' } } },
  { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello 🌊' }, { type: 'thinking', thinking: 'Consider it.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Hello 🌊', usage: { input_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.001 },
];
export const CLAUDE_AUTH_FAIL_EVENTS = [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in. Authentication required.' }];
export const CODEX_OK_EVENTS = [
  { type: 'thread.started', thread_id: 'thread_1' },
  { type: 'item.started', item: { id: 'i0', type: 'reasoning', text: '' } },
  { type: 'item.updated', item: { id: 'i0', type: 'reasoning', text: 'Consider ' } },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Consider it.' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Hello 🌊' } },
  { type: 'turn.completed', usage: { input_tokens: 14, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 2 } },
];
export const CURSOR_OK_EVENTS = [
  { type: 'assistant', model_call_id: 'call_1', message: { content: [{ type: 'text', text: 'Hello 🌊' }] } },
  { type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'Hello ' }] } },
  { type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: '🌊' }] } },
  { type: 'assistant', timestamp_ms: 3, model_call_id: 'call_1', message: { content: [{ type: 'text', text: 'Hello 🌊' }] } },
  { type: 'result', subtype: 'success', result: 'Hello 🌊', usage: { input_tokens: 14, output_tokens: 3 } },
];
export const CURSOR_CURRENT_EVENTS = [
  { type: 'system', subtype: 'init', model: 'fixture' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '🌊' }] } },
  { type: 'result', subtype: 'success', result: 'Hello 🌊', usage: { input_tokens: 14, output_tokens: 3 } },
];

async function run() {
  const scenario = process.env.FAKE_AGENT_CLI_SCENARIO || 'claude';
  if (process.env.FAKE_AGENT_CLI_ARGV_OUT) await writeFile(process.env.FAKE_AGENT_CLI_ARGV_OUT, JSON.stringify(process.argv));
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  if (process.env.FAKE_AGENT_CLI_STDIN_OUT) await writeFile(process.env.FAKE_AGENT_CLI_STDIN_OUT, stdin);
  if (scenario === 'hang' || scenario === 'stderr-hang') {
    setInterval(() => { if (scenario === 'stderr-hang') process.stderr.write('working\n'); }, 20);
    return;
  }
  if (scenario === 'tool' || scenario === 'tool-batch' || scenario === 'tool-continue') {
    const kind = process.env.FAKE_AGENT_CLI_KIND || 'claude';
    const shim = fileURLToPath(new URL('../../server/generations/agent-cli/mcp-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shim], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const tools = JSON.parse(await readFile(process.env.MINNOW_CLI_TOOLS_FILE, 'utf8'));
    if (process.env.FAKE_AGENT_CLI_PID_OUT) await writeFile(process.env.FAKE_AGENT_CLI_PID_OUT, JSON.stringify({ parent: process.pid, shim: child.pid }));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const event = JSON.parse(line);
      if (event.id === 1) {
        if (scenario === 'tool-continue' && kind === 'claude') process.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'before_tool', usage: { input_tokens: 10, cache_read_input_tokens: 4 } } } })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: process.env.FAKE_AGENT_CLI_TOOL || tools[0].name, arguments: JSON.parse(process.env.FAKE_AGENT_CLI_TOOL_ARGS || '{"path":"src/main.ts"}') } })}\n`);
        if (scenario === 'tool-batch') child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tools[0].name, arguments: { path: 'src/other.ts' } } })}\n`);
      } else if (event.id === 2 && scenario === 'tool-continue') {
        const text = event.result?.content?.[0]?.text ?? 'MISSING_RESULT';
        if (kind === 'claude') {
          process.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'after_tool', usage: { input_tokens: 2, cache_read_input_tokens: 12 } } } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `Used ${text}` } } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Used ${text}`, usage: { input_tokens: 100, output_tokens: 9 } })}\n`);
        } else if (kind === 'codex') {
          process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: `Used ${text}` } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 14, cached_input_tokens: 4, output_tokens: 3 } })}\n`);
        } else {
          process.stdout.write(`${JSON.stringify({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: `Used ${text}` }] } })}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: `Used ${text}`, usage: { input_tokens: 14, output_tokens: 3 } })}\n`);
        }
        child.stdin.end();
        child.kill();
        process.exit(0);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'oversized') { process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1)); return; }
  if (scenario === 'banner-only') { process.stdout.write('Welcome to a CLI\n'); return; }
  const events = scenario === 'auth' ? CLAUDE_AUTH_FAIL_EVENTS : scenario === 'codex' ? CODEX_OK_EVENTS : scenario === 'cursor' ? CURSOR_OK_EVENTS : scenario === 'cursor-current' ? CURSOR_CURRENT_EVENTS : scenario === 'rate-limit' ? [{ type: 'result', is_error: true, result: '429 rate limit exceeded' }] : CLAUDE_OK_EVENTS;
  process.stdout.write('\uFEFFStartup banner\r\n');
  for (const event of events) {
    const bytes = Buffer.from(`${JSON.stringify(event)}\r\n`);
    for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
