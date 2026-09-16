import readline from 'node:readline';
import { evaluate } from './runner.mjs';

// JSONL RPC: model requests stay on the host; every tool executes in the task sandbox.
const pending = new Map();
let seq = 0;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
function request(kind, payload, signal) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const abort = () => { pending.delete(id); reject(new Error('Benchmark request aborted')); };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, value => {
      signal?.removeEventListener('abort', abort);
      if (value.error) reject(new Error(value.error)); else resolve(value.result);
    });
    send({ id, kind, payload });
  });
}
let started = false;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.kind === 'start' && !started) {
      started = true;
      evaluate(message.config, {
        complete: async (_provider, body, signal) => {
          const result = await request('completion', body, signal);
          return new Response(result.text, { status: result.status,
            headers: { 'Content-Type': result.contentType ?? 'text/event-stream' } });
        },
        execute: (name, args, ctx) => request('tool', { name, args, ...ctx }),
        event: event => send({ kind: 'event', event }),
      }).then(result => { send({ kind: 'result', result }); input.close(); })
        .catch(error => { send({ kind: 'fatal', error: error.message }); process.exitCode = 1; input.close(); });
    } else {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve?.(message);
    }
  } catch (error) { send({ kind: 'fatal', error: error.message }); process.exitCode = 1; input.close(); }
});
