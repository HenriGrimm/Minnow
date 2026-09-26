import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let activeSession = null;
let pendingPromptId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

for await (const line of rl) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: process.argv.includes('--bad-version') ? 99 : 1,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: {},
        },
        agentInfo: { name: 'Fixture ACP', version: '1.0.0' },
        authMethods: [],
      },
    });
    continue;
  }
  if (message.method === 'session/new') {
    activeSession = 'fixture-session';
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: activeSession } });
    continue;
  }
  if (message.method === 'session/prompt') {
    pendingPromptId = message.id;
    const text = message.params?.prompt?.[0]?.text ?? '';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSession,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: process.argv.includes('--echo-secret')
              ? `Secret: ${process.env.ACP_FIXTURE_TOKEN ?? ''}`
              : process.argv.includes('--oversized-update')
                ? 'x'.repeat(100_000)
                : `Echo: ${text}`,
          },
        },
      },
    });
    if (!process.argv.includes('--wait-for-cancel')) {
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'end_turn' } });
      pendingPromptId = null;
    }
    continue;
  }
  if (message.method === 'session/cancel' && pendingPromptId != null) {
    send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } });
    pendingPromptId = null;
  }
}
