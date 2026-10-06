import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';
import { HeadlessGenerationError } from '../../src/headless/generation-terminal.ts';
import { streamHeadlessTurn } from '../../src/headless/runner.ts';
import { installHeadlessFetch } from '../../src/headless/server-context.ts';
import type { GenerationEndEvent } from '../../src/api/generations.ts';

let server: Server | undefined;
let restoreFetch: (() => void) | undefined;
let terminal: GenerationEndEvent = { status: 'complete' };
let chunkText = '';

after(async () => {
  restoreFetch?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
});

test('headless generation honors terminal status and keeps partial output', async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/generations' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"generationId":"test-generation"}');
      return;
    }
    if (req.url === '/api/generations/test-generation/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (chunkText) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunkText }, finish_reason: null }] })}\n\n`);
      res.end(`event: end\ndata: ${JSON.stringify(terminal)}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  restoreFetch = installHeadlessFetch(`http://127.0.0.1:${address.port}`);

  const cases: Array<{ event: GenerationEndEvent; text: string; expectedStatus?: string; message?: RegExp }> = [
    { event: { status: 'complete' }, text: 'Done.' },
    { event: { status: 'error', errorMessage: 'Provider rejected request' }, text: '', expectedStatus: 'error', message: /Provider rejected/ },
    { event: { status: 'error', errorMessage: 'Upstream stopped' }, text: 'Partial answer', expectedStatus: 'error', message: /Upstream stopped/ },
    { event: { status: 'error', quotaExceeded: true }, text: '', expectedStatus: 'error', message: /quota exhausted/ },
    { event: { status: 'cancelled' }, text: 'Started', expectedStatus: 'cancelled', message: /cancelled/ },
  ];
  for (const item of cases) {
    terminal = item.event;
    chunkText = item.text;
    if (!item.expectedStatus) {
      assert.equal((await streamHeadlessTurn('test-provider', {}, new AbortController().signal)).fullText, item.text);
      continue;
    }
    await assert.rejects(
      streamHeadlessTurn('test-provider', {}, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof HeadlessGenerationError);
        assert.equal(error.status, item.expectedStatus);
        assert.equal(error.partialText, item.text);
        assert.match(error.message, item.message!);
        return true;
      },
    );
  }
});
