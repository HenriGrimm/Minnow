import { runGh } from './gh-cli.js';
import { invalidateForgeStatusCache } from './forge-ops.js';

const LOGIN_TIMEOUT = 10 * 60_000;

/** One device flow per server, shared by onboarding and Settings. */
export function createGitHubAuth({ run = runGh, invalidate = invalidateForgeStatusCache, env = process.env } = {}) {
  let session = null;
  let starting = null;

  function loginState() {
    if (!session) return null;
    const { state, code, error } = session;
    return { state, code, error, verificationUrl: 'https://github.com/login/device' };
  }

  async function status(signal) {
    const base = { ok: true, installed: false, authenticated: false, login: '', managed: Boolean(env.GH_TOKEN || env.GITHUB_TOKEN), flow: loginState() };
    try {
      const version = await run(['--version'], { timeout: 10_000, signal });
      if (version.code !== 0) return base;
      base.installed = true;
      const account = await run(['api', '--hostname', 'github.com', 'user', '--jq', '.login'], { timeout: 20_000, signal });
      const login = account.stdout.trim();
      if (account.code === 0 && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)) {
        return { ...base, authenticated: true, login };
      }
      return { ...base, error: 'GitHub could not verify your account. Sign in, or check your connection and try again.' };
    } catch {
      return { ...base, ...(base.installed ? { error: 'Could not reach GitHub. Check your connection and try again.' } : {}) };
    }
  }

  function start() {
    if (starting) return starting;
    if (session?.state === 'pending') return Promise.resolve({ ok: true, flow: loginState() });
    starting = begin().finally(() => { starting = null; });
    return starting;
  }

  async function begin() {
    const current = await status();
    if (!current.installed) return { ok: false, error: 'Install GitHub CLI, then check again.' };
    if (current.managed) return { ok: false, error: 'GitHub authentication is supplied by GH_TOKEN or GITHUB_TOKEN. Manage that environment variable outside Minnow.' };
    const controller = new AbortController();
    const attempt = { state: 'pending', code: '', error: '', controller };
    session = attempt;
    let output = '';
    const capture = (chunk) => {
      output = (output + chunk).slice(-4096);
      const match = /(?:one-time code|code:)\s*:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output);
      if (match) attempt.code = match[1].toUpperCase();
    };
    void run(['auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key'], {
      timeout: LOGIN_TIMEOUT,
      signal: controller.signal,
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' },
      onSpawn: (child) => {
        child.stdin?.on('error', () => {});
        child.stdin?.end();
      },
      onStdout: capture,
      onStderr: capture,
    }).then(async (result) => {
      if (attempt.state !== 'pending') return;
      if (result.code === 0) {
        invalidate();
        const verified = await status(controller.signal);
        if (attempt.state !== 'pending') return;
        attempt.state = verified.authenticated ? 'complete' : 'failed';
        attempt.error = verified.authenticated ? '' : 'Sign-in finished, but the account could not be verified. Check again.';
      } else {
        attempt.state = 'failed';
        attempt.error = result.timedOut ? 'Sign-in expired. Start again for a new code.' : 'Sign-in did not finish. Try again, or run gh auth login in a terminal.';
      }
      attempt.code = '';
      output = '';
    }).catch(() => {
      if (attempt.state === 'pending') {
        attempt.state = 'failed';
        attempt.error = 'Could not complete sign-in. Try again.';
      }
      attempt.code = '';
      output = '';
    });
    return { ok: true, flow: loginState() };
  }

  function cancel() {
    if (session?.state === 'pending') {
      session.state = 'cancelled';
      session.code = '';
      session.controller.abort();
    }
    return { ok: true, flow: loginState() };
  }

  return { status, start, cancel, poll: () => ({ ok: true, flow: loginState() }) };
}

export const githubAuth = createGitHubAuth();
