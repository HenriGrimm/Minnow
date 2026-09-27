/** Bounded, in-memory capture of the actual stdout/stderr of chat-owned CLI processes. */

const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_PENDING_CHARS = 1024 * 1024;
const MAX_CHATS = 64;
const captures = new Map();
let nextVersion = 0;

function redact(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) result = result.replaceAll(secret, '[redacted]');
  }
  return result;
}

function append(capture, text) {
  capture.output = `${capture.output}${text}`.slice(-MAX_OUTPUT_CHARS);
  capture.version = ++nextVersion;
}

export function beginAgentCliOutput(chatId, providerId, modelId, secrets = []) {
  if (!chatId) return null;
  const capture = { chatId, providerId, modelId, output: '', pending: '',
    secrets, status: 'running', version: ++nextVersion, startedAt: Date.now() };
  captures.delete(chatId);
  captures.set(chatId, capture);
  while (captures.size > MAX_CHATS) {
    const oldestExited = [...captures].find(([, row]) => row.status === 'exited')?.[0];
    captures.delete(oldestExited ?? captures.keys().next().value);
  }
  return capture;
}

export function appendAgentCliOutput(capture, chunk, stream = 'stdout') {
  if (!capture || capture.status !== 'running') return;
  const key = stream === 'stderr' ? 'pendingError' : 'pending';
  capture[key] = `${capture[key] ?? ''}${chunk.toString('utf8')}`;
  let newline;
  while ((newline = capture[key].indexOf('\n')) >= 0) {
    const line = capture[key].slice(0, newline + 1);
    capture[key] = capture[key].slice(newline + 1);
    append(capture, redact(line, capture.secrets));
  }
  if (capture[key].length > MAX_PENDING_CHARS) {
    capture[key] = '';
    append(capture, `[${stream} line omitted: too large]\n`);
  }
}

export function endAgentCliOutput(capture, exitCode) {
  if (!capture || capture.status !== 'running') return;
  for (const key of ['pending', 'pendingError']) {
    if (capture[key]) append(capture, redact(capture[key], capture.secrets));
    capture[key] = '';
  }
  capture.status = 'exited';
  capture.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  capture.secrets = [];
  capture.version = ++nextVersion;
}

export function getAgentCliOutput(chatId) {
  const capture = captures.get(chatId);
  if (!capture) return null;
  const { providerId, modelId, output, status, version, startedAt, exitCode } = capture;
  return { providerId, modelId, output, status, version, startedAt,
    ...(status === 'exited' ? { exitCode } : {}) };
}
