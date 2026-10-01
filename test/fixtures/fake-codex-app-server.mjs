import { createInterface } from 'node:readline';

const send = row => process.stdout.write(`${JSON.stringify(row)}\n`);
process.stdout.write('startup banner\n');
createInterface({ input: process.stdin }).on('line', line => {
  const row = JSON.parse(line);
  if (!row.method) { send({ method: 'fixture/answered', params: row }); return; }
  if (row.method === 'initialized') return;
  if (row.method === 'initialize') { send({ id: row.id, result: {} }); return; }
  if (row.method === 'hang') return;
  if (row.method === 'exit') { process.exit(1); return; }
  if (row.method === 'large') { process.stdout.write('x'.repeat(5000)); return; }
  if (row.method === 'conflict') {
    send({ id: 'conflict', method: 'item/tool/call', params: { callId: 'one' } });
    send({ id: 'conflict', method: 'item/tool/call', params: { callId: 'two' } });
    return;
  }
  if (row.method === 'server-flood') {
    for (let i = 0; i < 20; i++) send({ id: `flood-${i}`, method: 'item/tool/call', params: { data: 'x'.repeat(300) } });
    return;
  }
  if (row.method === 'call') {
    send({ id: 'native-1', method: 'item/tool/call', params: { callId: 'call-1' } });
    send({ id: 'native-1', method: 'item/tool/call', params: { callId: 'call-1' } });
  }
  if (row.method === 'split') {
    const data = Buffer.from(`${JSON.stringify({ id: row.id, result: 'hé🐟' })}\n`);
    for (let i = 0; i < data.length; i++) process.stdout.write(data.subarray(i, i + 1));
    return;
  }
  setTimeout(() => send({ id: row.id, result: row.params }), row.params?.delay ?? 0);
});
