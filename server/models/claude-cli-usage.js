import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { normalizeClaudeUsage } from './cli-usage-normalize.js';

export class CliUsageError extends Error {
  constructor(status, message, retryMs) {
    super(message);
    this.status = status;
    this.retryMs = retryMs;
  }
}

export function usageHttpError(response, name) {
  const retry = response.headers.get('retry-after');
  const seconds = Number(retry);
  const retryMs = retry && Number.isFinite(seconds) ? seconds * 1000
    : retry ? Date.parse(retry) - Date.now() : undefined;
  return new CliUsageError('error', response.status === 429
    ? `${name} usage is temporarily rate limited. Try again later.` : `${name} account usage is temporarily unavailable.`, retryMs);
}

/** Bound even an unexpected successful response before parsing it. */
export async function readBoundedUsageJson(response, name) {
  const reader = response.body?.getReader();
  if (!reader) throw new CliUsageError('error', `${name} returned no account usage.`);
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new CliUsageError('error', `${name} account usage exceeded its size limit.`);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CliUsageError('error', `${name} returned unreadable account usage.`); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Read only the native login store. Never refresh OAuth independently of the CLI. */
export async function readClaudeUsageCredentials(options = {}) {
  const env = options.env ?? process.env;
  // Minnow's configured Claude token is passed as ANTHROPIC_API_KEY for inference.
  if (options.cliToken?.trim() || env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()
    || env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1'
    || env.CLAUDE_CODE_USE_FOUNDRY === '1' || env.ANTHROPIC_BASE_URL?.trim()) {
    throw new CliUsageError('unsupported', 'Subscription usage is unavailable for this API configuration.');
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { token: env.CLAUDE_CODE_OAUTH_TOKEN.trim(), plan: null };
  const root = env.CLAUDE_CONFIG_DIR?.trim() || path.join(options.homeDir ?? os.homedir(), '.claude');
  let credentials;
  for (const name of ['.credentials.json', 'credentials.json']) {
    try { credentials = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw new CliUsageError('error', 'Could not read the Claude login. Verify the CLI and retry.');
    }
  }
  if (!credentials && (options.platform ?? process.platform) === 'darwin' && !env.CLAUDE_CONFIG_DIR) {
    const result = await (options.runProcess ?? runProcess)('/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, signal: options.signal });
    if (result.code === 0) {
      try { credentials = JSON.parse(result.stdout); } catch { /* unavailable native login */ }
    }
  }
  const oauth = credentials?.claudeAiOauth;
  if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') {
    throw new CliUsageError('signed-out', 'Sign in to Claude Code to see account usage.');
  }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= (options.now ?? Date.now)()) {
    throw new CliUsageError('signed-out', 'Claude login has expired. Verify or sign in to the CLI, then refresh.');
  }
  return { token: oauth.accessToken, plan: oauth.subscriptionType ?? null };
}

/** Private vendor endpoint: isolate its contract and never expose its raw body. */
export async function readClaudeAccountUsage(credentials, options = {}) {
  const response = await (options.fetch ?? fetch)('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${credentials.token}`, 'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new CliUsageError('signed-out', 'Claude account usage needs a current subscription login. Verify or sign in to the CLI.');
  }
  if (!response.ok) throw usageHttpError(response, 'Claude');
  const normalized = normalizeClaudeUsage(await readBoundedUsageJson(response, 'Claude'), credentials.plan);
  if (!normalized.windows.length) throw new CliUsageError('unavailable', 'Claude did not report subscription limits for this account.');
  return normalized;
}
