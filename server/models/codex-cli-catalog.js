import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../generations/agent-cli/resolve-bin.js';
import { codexSourceHome, prepareCodexAuth } from '../generations/agent-cli/codex-auth.js';
import { createCodexRpc } from '../generations/codex-app-server/rpc.js';
import { tryAdmitAgentCliProbe, waitForAgentCliProbe } from '../generations/agent-cli/admission.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
// Last successful catalog per binary/account, kept across TTL expiry and cache
// clears. Used only when a fresh probe cannot run (Codex busy) or fails.
const lastKnown = new Map();

export function clearCodexModelCatalogCache() { cache.clear(); }
export function resetCodexModelCatalogForTests() { cache.clear(); lastKnown.clear(); }

function readAuthFile(file, optional) {
  return fs.readFile(file).catch(error => {
    if (optional && error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
}

/** Codex rewrites auth.json on every token refresh; key on the account, not the token bytes. */
function authIdentity(auth) {
  try {
    const parsed = JSON.parse(auth.toString('utf8'));
    const accountId = parsed?.tokens?.account_id;
    const apiKey = parsed?.OPENAI_API_KEY;
    if ((typeof accountId === 'string' && accountId) || (typeof apiKey === 'string' && apiKey)) {
      let subject;
      try {
        subject = JSON.parse(Buffer.from(parsed.tokens?.id_token?.split('.')[1] ?? '', 'base64url')).sub;
      } catch { /* Older login files may have no ID token. */ }
      return createHash('sha256').update(JSON.stringify([parsed.auth_mode, accountId, subject, apiKey])).digest('hex');
    }
  } catch { /* Unrecognized auth files are keyed by their bytes. */ }
  return createHash('sha256').update(auth).digest('hex');
}

async function readCatalogSnapshot(file, identity) {
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved?.identity === identity && Array.isArray(saved.models)) return saved.models;
  } catch { /* An absent or unreadable snapshot is a cache miss. */ }
}

async function writeCatalogSnapshot(file, identity, models) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, JSON.stringify({ identity, models }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Discovery only: initialize and model/list, with no thread or inference. */
export async function readCodexModelCatalog(invocation, timeoutMs = 15_000) {
  const rpc = createCodexRpc(invocation, { maxTotalBytes: 4 * 1024 * 1024 });
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Codex model discovery timed out. Check the CLI in Models → Subscriptions.');
    return { timeoutMs };
  };
  try {
    await rpc.initialize(remaining());
    const models = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await rpc.request('model/list', { limit: 100, includeHidden: false,
        ...(cursor ? { cursor } : {}) }, remaining());
      if (!Array.isArray(result?.data)) throw new Error('Codex returned an invalid model catalog.');
      models.push(...result.data);
      if (models.length > 1000) throw new Error('Codex model catalog exceeded its size limit.');
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated model catalog cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  } finally {
    await rpc.close();
  }
}

/** The desktop cache can belong to another binary/account; query the actual CLI in a fresh home. */
export async function fetchCodexModelCatalog(options = {}) {
  const env = options.env ?? process.env;
  const sourceHome = codexSourceHome(options);
  const authPath = options.codexAuthPath || path.join(sourceHome, 'auth.json');
  const readSourceAuth = () => readAuthFile(authPath, !options.codexAuthPath);
  const login = authIdentity(await readSourceAuth());
  const bin = await resolveAgentCliBin({ kind: 'codex', ...options });
  const identity = [bin.command, bin.argsPrefix, sourceHome, authPath,
    options.cliToken, env.OPENAI_API_KEY, env.CODEX_API_KEY, login];
  const key = createHash('sha256').update(JSON.stringify([...identity, options.cliVersion])).digest('hex');
  const stableKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < TTL_MS) return cached.models;
  if (inflight.has(key)) return inflight.get(key);
  const snapshotFile = path.join(getMinnowHome(), 'models-runtime', 'codex-catalog-v1.json');
  const loadLastKnown = async () => {
    const models = lastKnown.get(stableKey)?.models ?? await readCatalogSnapshot(snapshotFile, stableKey);
    if (models && authIdentity(await readSourceAuth()) === login) return models;
  };
  const work = (async () => {
    let release = tryAdmitAgentCliProbe('codex-cli');
    if (!release) {
      const known = await loadLastKnown();
      if (known) return known;
      // At startup the usage meter can win the probe slot. Don't publish the
      // static fallback just because that short-lived probe started first.
      await waitForAgentCliProbe('codex-cli', 15_000);
      const discovered = await loadLastKnown();
      if (discovered) return discovered;
      release = tryAdmitAgentCliProbe('codex-cli');
      if (!release) {
        throw Object.assign(new Error('The Codex model list can refresh when Codex is idle.'), { code: 'CODEX_CATALOG_BUSY' });
      }
    }
    let home;
    let syncAuth;
    try {
      home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-catalog-'));
      syncAuth = await prepareCodexAuth(home, { ...options, env });
      const copiedAuth = await readAuthFile(path.join(home, 'auth.json'), true);
      const loginChanged = () => new Error('The Codex login changed during model discovery. Refresh to try again.');
      if (authIdentity(copiedAuth) !== login) throw loginChanged();
      await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      const runEnv = applyAgentCliCaptureEnv(env, bin.command);
      runEnv.CODEX_HOME = home;
      if (options.cliToken?.trim()) runEnv.OPENAI_API_KEY = options.cliToken.trim();
      const listed = await readCodexModelCatalog({ ...bin, cwd: home, env: runEnv });
      if (authIdentity(await readSourceAuth()) !== login) throw loginChanged();
      // Context windows are absent from model/list on older CLIs. Use only the
      // metadata this very process wrote, restricted to its returned model IDs.
      const metadata = await fs.readFile(path.join(home, 'models_cache.json'), 'utf8').then(JSON.parse).catch(() => null);
      const modelMetadata = Array.isArray(metadata?.models) ? metadata.models : [];
      const models = listed.filter(row => row.hidden !== true).map(row => {
        const cachedModel = modelMetadata.find(model => model?.slug === row.model);
        return {
          context_window: cachedModel?.context_window,
          priority: cachedModel?.priority,
          slug: row.model || row.id, display_name: row.displayName,
          visibility: 'list', default_reasoning_level: row.defaultReasoningEffort,
          service_tiers: row.serviceTiers ?? cachedModel?.service_tiers,
          additional_speed_tiers: row.additionalSpeedTiers ?? cachedModel?.additional_speed_tiers,
          input_modalities: row.inputModalities ?? cachedModel?.input_modalities,
          supported_reasoning_levels: row.supportedReasoningEfforts?.map(level => ({ effort: level.reasoningEffort })),
        };
      });
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), models });
      if (lastKnown.size >= 16 && !lastKnown.has(stableKey)) lastKnown.delete(lastKnown.keys().next().value);
      lastKnown.set(stableKey, { at: Date.now(), models });
      await writeCatalogSnapshot(snapshotFile, stableKey, models).catch(() => {});
      return models;
    } catch (error) {
      // A transient probe failure must not make an already-known catalog unavailable.
      const known = await loadLastKnown();
      if (known) return known;
      throw error;
    } finally {
      try { await syncAuth?.(); }
      finally {
        release();
        if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  })();
  inflight.set(key, work);
  try { return await work; }
  finally { inflight.delete(key); }
}
