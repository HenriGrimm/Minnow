import http from 'node:http';

/** Real CLI fixture: all model traffic stays on loopback, with no login. */
export async function createFakeCodexResponses() {
  const requests = [];
  const scripts = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url !== '/v1/responses') {
      res.writeHead(404); res.end(); return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const script = scripts.shift() ?? { text: 'Fixture reply.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const id = `resp_${requests.length}`;
    const output = [];
    const emit = (type, extra = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
    emit('response.created', { response: { id, status: 'in_progress', output: [] } });
    if (script.hang) return;
    for (const call of script.calls ?? []) {
      const item = { type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args ?? {}) };
      const output_index = output.length;
      emit('response.output_item.added', { output_index, item: { ...item, arguments: '' } });
      emit('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
      emit('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
      emit('response.output_item.done', { output_index, item });
      output.push(item);
    }
    if (script.text) {
      const item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: script.text, annotations: [] }] };
      const output_index = output.length;
      emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } });
      emit('response.content_part.added', { item_id: item.id, output_index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
      for (const delta of script.deltas ?? [script.text]) {
        emit('response.output_text.delta', { item_id: item.id, output_index, content_index: 0, delta });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      emit('response.output_text.done', { item_id: item.id, output_index, content_index: 0, text: script.text });
      emit('response.output_item.done', { output_index, item });
      output.push(item);
    }
    emit('response.completed', { response: { id, status: 'completed', output,
      usage: script.usage ?? { input_tokens: 20, output_tokens: 5, total_tokens: 25,
        input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } } } });
    res.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, scripts,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
