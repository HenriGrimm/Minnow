import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../generations/agent-cli/resolve-bin.js';
import { prepareCodexAuth } from '../generations/agent-cli/codex-auth.js';
import { createCliRpc } from '../generations/agent-cli/rpc.js';
import { normalizeCodexUsage } from './cli-usage-normalize.js';
import { CliUsageError } from './claude-cli-usage.js';

export async function readCodexAccountUsage(options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-usage-'));
  let rpc;
  let syncAuth;
  try {
    syncAuth = await prepareCodexAuth(home, options);
    await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    const bin = await (options.resolveBin ?? resolveAgentCliBin)({ kind: 'codex', ...options });
    const env = applyAgentCliCaptureEnv(options.env ?? process.env, bin.command);
    env.CODEX_HOME = home;
    if (options.cliToken?.trim()) env.OPENAI_API_KEY = options.cliToken.trim();
    rpc = (options.createRpc ?? createCliRpc)({ ...bin, cwd: home, env }, { maxTotalBytes: 1024 * 1024 });
    const deadline = Date.now() + 15_000;
    const remaining = () => ({ timeoutMs: Math.max(1, deadline - Date.now()) });
    await rpc.initialize(remaining());
    const { account } = await rpc.request('account/read', { refreshToken: false }, remaining());
    if (!account) throw new CliUsageError('signed-out', 'Sign in to Codex CLI to see account usage.');
    if (account.type !== 'chatgpt' && account.type !== 'chatgptAuthTokens') {
      throw new CliUsageError('unsupported', 'Subscription usage requires a ChatGPT login in Codex CLI.');
    }
    const data = await rpc.request('account/rateLimits/read', {}, remaining());
    const normalized = normalizeCodexUsage(data, account);
    if (!normalized.windows.length) throw new CliUsageError('unavailable', 'Codex did not report subscription limits for this account.');
    return normalized;
  } finally {
    try { await rpc?.close(); await syncAuth?.(); }
    finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
}
