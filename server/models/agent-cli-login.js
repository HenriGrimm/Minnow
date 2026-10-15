import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveAgentCliBin, applyAgentCliCaptureEnv, stripAnsiFromCliText } from '../generations/agent-cli/resolve-bin.js';
import { killProcessTreeAndWait } from '../terminal-runner.js';

const LOGIN_ARGS = {
  claude: ['auth', 'login'],
  codex: ['-c', 'cli_auth_credentials_store=file', 'login'],
  cursor: ['login'],
};
const LOGIN_HOSTS = {
  claude: ['claude.ai', 'platform.claude.com', 'console.anthropic.com'],
  codex: ['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'],
  cursor: ['cursor.com', 'www.cursor.com', 'authenticator.cursor.sh', 'accounts.cursor.com', 'accounts.x.ai', 'accounts.spacex.ai'],
};

export function agentCliLoginUrl(kind, value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && LOGIN_HOSTS[kind]?.includes(url.hostname)) return url.href;
  } catch { /* Ignore partial URLs and terminal diagnostics. */ }
  return null;
}

/** The CLI owns OAuth and its native credential store; only normalized state leaves this service. */
export function createAgentCliLoginService({ resolveBin = resolveAgentCliBin, spawnProcess = spawn,
  stop = killProcessTreeAndWait, verify, onSignedIn = async () => {}, env = process.env,
  timeoutMs = 10 * 60_000 } = {}) {
  const sessions = new Map();
  const starting = new Map();
  let shuttingDown = false;
  const snapshot = (session) => session ? {
    id: session.id, state: session.state, verificationUrl: session.verificationUrl,
    code: session.code, acceptsCode: session.kind === 'claude' && session.state === 'waiting',
    error: session.error,
  } : null;
  const current = (kind, id) => {
    const session = sessions.get(kind);
    if (!session || session.id !== id) throw new Error('This sign-in attempt is no longer available. Start again.');
    return session;
  };
  const pending = (session) => ['starting', 'waiting', 'verifying'].includes(session?.state);

  async function begin(kind, options) {
    if (shuttingDown) throw new Error('Minnow is shutting down.');
    if (!Object.hasOwn(LOGIN_ARGS, kind)) throw new Error('Invalid agent CLI kind');
    const previous = sessions.get(kind);
    if (pending(previous)) return snapshot(previous);
    await previous?.stopped;
    const bin = await resolveBin({ kind: kind === 'cursor' ? 'cursor-agent' : kind, binPath: options.binPath });
    if (shuttingDown) throw new Error('Minnow is shutting down.');
    const session = { id: randomUUID(), kind, state: 'starting', verificationUrl: null, code: null, error: null };
    sessions.set(kind, session);
    const runEnv = applyAgentCliCaptureEnv(env, bin.command);
    if (kind === 'cursor') runEnv.NO_OPEN_BROWSER = '1';
    let child;
    try {
      child = spawnProcess(bin.command, [...bin.argsPrefix, ...LOGIN_ARGS[kind]], {
        cwd: options.cwd, env: runEnv, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      session.state = 'failed';
      session.error = 'Could not start sign-in. Check that the CLI is installed and try again.';
      return snapshot(session);
    }
    session.child = child;
    let output = '';
    const clear = () => { output = ''; session.verificationUrl = null; session.code = null; clearTimeout(session.timer); };
    session.clear = clear;
    const fail = (message) => {
      if (!pending(session)) return;
      session.state = 'failed';
      session.error = message;
      clear();
      session.stopped = Promise.resolve(stop(child, { graceMs: 1500 })).catch(() => {});
    };
    const capture = (chunk) => {
      if (!pending(session)) return;
      output = (output + stripAnsiFromCliText(chunk.toString())).slice(-32_768);
      for (const match of output.matchAll(/https:\/\/[^\s<>"\u001b]+/g)) {
        const url = agentCliLoginUrl(kind, match[0]);
        if (url) { session.verificationUrl = url; session.state = 'waiting'; }
      }
      const code = output.match(/(?:code[:\s]+)[`'"\s]*([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9])/i)?.[1];
      if (code && kind !== 'claude') session.code = code;
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.stdin.on('error', () => fail('Sign-in input closed. Start again.'));
    child.once('error', () => fail('Could not start sign-in. Check that the CLI is installed and try again.'));
    child.once('close', async (code) => {
      if (!pending(session)) return;
      if (code !== 0) { fail('Sign-in did not finish. Try again and complete approval in your browser.'); return; }
      session.state = 'verifying';
      clear();
      try {
        const status = await verify(kind);
        if (session.state !== 'verifying') return;
        if (status.authStatus !== 'signed-in' && status.authStatus !== 'token') {
          fail('The CLI could not confirm your login. Try again.'); return;
        }
        await onSignedIn(kind);
        if (session.state === 'verifying') session.state = 'signed-in';
      } catch { fail('Could not verify sign-in. Check your connection and try again.'); }
    });
    session.timer = setTimeout(() => fail('Sign-in timed out. Start again when you are ready.'), timeoutMs);
    session.timer.unref?.();
    return snapshot(session);
  }

  const service = {
    start(kind, options = {}) {
      if (starting.has(kind)) return starting.get(kind);
      const work = begin(kind, options).finally(() => starting.delete(kind));
      starting.set(kind, work);
      return work;
    },
    poll(kind, id) { return snapshot(current(kind, id)); },
    submit(kind, id, code) {
      const session = current(kind, id);
      if (kind !== 'claude' || session.state !== 'waiting') throw new Error('This sign-in is not waiting for a code.');
      if (typeof code !== 'string' || !code.trim() || code.length > 2048 || /[\r\n\0]/.test(code)) {
        throw new Error('Paste the sign-in code from your browser.');
      }
      session.child.stdin.write(`${code.trim()}\n`);
      return snapshot(session);
    },
    async cancel(kind, id) {
      const session = current(kind, id);
      if (pending(session)) {
        session.state = 'cancelled';
        session.clear?.();
        session.stopped = Promise.resolve(stop(session.child, { graceMs: 1500 })).catch(() => {});
        await session.stopped;
      }
      return snapshot(session);
    },
    async shutdown() {
      shuttingDown = true;
      const stops = [...sessions.values()].map(session => service.cancel(session.kind, session.id));
      await Promise.allSettled([...stops, ...starting.values()]);
    },
  };
  return service;
}
