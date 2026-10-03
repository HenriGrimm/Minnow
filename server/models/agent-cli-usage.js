import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codexSourceHome } from '../generations/agent-cli/codex-auth.js';
import { getAgentCliProviderConfig } from '../providers/store.js';
import { readCodexAccountUsage } from './codex-cli-usage.js';
import { CliUsageError, readClaudeUsageCredentials, readClaudeAccountUsage } from './claude-cli-usage.js';

const TTL_MS = 60_000;
const MAX_STALE_MS = 60 * 60_000;

function empty(kind, status, message, now) {
  return { kind, status, message, windows: [], plan: null, fetchedAt: null,
    checkedAt: new Date(now).toISOString(), retryAt: null };
}

async function loadCredentials(kind, options) {
  const env = options.env ?? process.env;
  const identity = createHash('sha256').update(JSON.stringify([kind, options.binPath, options.cliToken,
    kind === 'codex' ? env.OPENAI_API_KEY : null, kind === 'codex' ? env.CODEX_API_KEY : null]));
  if (kind === 'claude') {
    const credentials = await readClaudeUsageCredentials(options);
    return { key: identity.update(credentials.token).digest('hex'), credentials };
  }
  const authPath = options.codexAuthPath || path.join(codexSourceHome(options), 'auth.json');
  const auth = await fs.readFile(authPath).catch(error => {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw new CliUsageError('error', 'Could not read the Codex login. Verify the CLI and retry.');
  });
  let accountKey;
  try {
    const parsed = JSON.parse(auth.toString('utf8'));
    if (typeof parsed.tokens?.account_id === 'string') accountKey = parsed.tokens.account_id;
  } catch { /* app-server diagnoses malformed login files */ }
  return { key: identity.update(authPath).update(auth).digest('hex'), credentials: null, accountKey };
}

/** Per-account cache; credentials and vendor errors never leave the adapters. */
export function createAgentCliUsageService(deps = {}) {
  const now = deps.now ?? Date.now;
  const credentials = deps.loadCredentials ?? loadCredentials;
  const read = deps.readUsage ?? ((kind, login, options) => kind === 'codex'
    ? readCodexAccountUsage(options) : readClaudeAccountUsage(login, options));
  const cache = new Map();
  const inflight = new Map();
  return {
    async get(kind, options = {}) {
      if (!['codex', 'claude'].includes(kind)) return empty(kind, 'unsupported', 'Account usage is unavailable for this CLI.', now());
      let login;
      try { login = await credentials(kind, options); }
      catch (error) {
        return empty(kind, error instanceof CliUsageError ? error.status : 'error',
          error instanceof CliUsageError ? error.message : 'Could not read the CLI login. Verify it and retry.', now());
      }
      const key = `${kind}:${login.key}`;
      const cached = cache.get(key);
      const time = now();
      if (cached && (time < cached.retryAfter || (!options.refresh && time < cached.expiresAt))) {
        if (cached.good && time - Date.parse(cached.good.fetchedAt) > MAX_STALE_MS) {
          return { ...cached.result, status: 'error', windows: [], plan: null, credits: undefined, fetchedAt: null };
        }
        return cached.result;
      }
      if (inflight.has(key)) return inflight.get(key);
      const work = (async () => {
        let entry;
        let cacheKey = key;
        try {
          const data = await read(kind, login.credentials, options);
          // A sign-in change during a request must not paint another account's quota.
          const current = await credentials(kind, options);
          if (current.key !== login.key) {
            if (kind !== 'codex' || !login.accountKey || current.accountKey !== login.accountKey) {
              return empty(kind, 'unavailable', 'CLI login changed. Refresh to load the current account.', now());
            }
            // The native CLI refreshed tokens for the same account under the
            // concurrent-sign-in guard. Cache under its new credential fingerprint.
            cacheKey = `${kind}:${current.key}`;
          }
          const at = now();
          const result = { kind, status: 'ready', ...data, fetchedAt: new Date(at).toISOString(),
            checkedAt: new Date(at).toISOString(), retryAt: null, message: null };
          const nextReset = Math.min(...data.windows.map(row => Date.parse(row.resetsAt)).filter(value => value > at));
          entry = { good: result, result, failures: 0, expiresAt: Math.min(at + TTL_MS, nextReset), retryAfter: at + 10_000 };
        } catch (error) {
          // Failed requests can race a login change too; never retain the old
          // account's snapshot when the credential identity cannot be verified.
          let current;
          try { current = await credentials(kind, options); }
          catch { return empty(kind, 'unavailable', 'CLI login changed or is unavailable. Verify it and refresh.', now()); }
          if (current.key !== login.key) {
            return empty(kind, 'unavailable', 'CLI login changed. Refresh to load the current account.', now());
          }
          const at = now();
          const status = error instanceof CliUsageError ? error.status : 'error';
          const message = error instanceof CliUsageError ? error.message : `${kind === 'codex' ? 'Codex' : 'Claude'} account usage could not be refreshed. Verify the CLI or try again later.`;
          const failures = (cached?.failures ?? 0) + 1;
          const delay = Math.min(15 * TTL_MS, Math.max(TTL_MS * 2 ** Math.min(failures - 1, 4),
            error instanceof CliUsageError && Number.isFinite(error.retryMs) ? error.retryMs : 0));
          const good = status === 'error' && cached?.good && at - Date.parse(cached.good.fetchedAt) <= MAX_STALE_MS ? cached.good : null;
          const result = { ...(good ?? empty(kind, status, message, at)), status: good ? 'stale' : status,
            message, checkedAt: new Date(at).toISOString(), retryAt: new Date(at + delay).toISOString() };
          entry = { good, result, failures, expiresAt: at + delay, retryAfter: at + delay };
        }
        if (cache.size >= 32 && !cache.has(cacheKey)) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, entry);
        return entry.result;
      })();
      inflight.set(key, work);
      try { return await work; }
      finally { inflight.delete(key); }
    },
  };
}

const service = createAgentCliUsageService();

export async function getAgentCliAccountUsage(kind, options = {}) {
  const { profile, secrets } = await getAgentCliProviderConfig(kind);
  return service.get(kind, { binPath: profile?.agentCli?.binPath, cliToken: secrets.cliToken, ...options });
}
