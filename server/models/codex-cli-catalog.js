import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../generations/agent-cli/resolve-bin.js';
import { codexSourceHome, prepareCodexAuth } from '../generations/agent-cli/codex-auth.js';
import { createCodexRpc } from '../generations/codex-app-server/rpc.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

/** Discovery only: initialize and model/list, with no thread or inference. */
export async function readCodexModelCatalog(invocation, timeoutMs = 15_000) {
  const rpc = createCodexRpc(invocation, { maxTotalBytes: 4 * 1024 * 1024 });
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Codex model discovery timed out. Check the CLI in Models → CLIs.');
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
  const auth = await fs.readFile(authPath).catch(error => {
    if (error.code === 'ENOENT' && !options.codexAuthPath) return Buffer.alloc(0);
    throw error;
  });
  const bin = await resolveAgentCliBin({ kind: 'codex', ...options });
  const key = createHash('sha256').update(JSON.stringify([
    bin.command, bin.argsPrefix, options.cliVersion, sourceHome, authPath,
    options.cliToken, env.OPENAI_API_KEY, env.CODEX_API_KEY,
  ])).update(auth).digest('hex');
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.models;
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-codex-catalog-'));
    let syncAuth;
    try {
      syncAuth = await prepareCodexAuth(home, { ...options, env });
      await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      const runEnv = applyAgentCliCaptureEnv(env, bin.command);
      runEnv.CODEX_HOME = home;
      if (options.cliToken?.trim()) runEnv.OPENAI_API_KEY = options.cliToken.trim();
      const listed = await readCodexModelCatalog({ ...bin, cwd: home, env: runEnv });
      // Context windows are absent from model/list on older CLIs. Use only the
      // metadata this very process wrote, restricted to its returned model IDs.
      const metadata = JSON.parse(await fs.readFile(path.join(home, 'models_cache.json'), 'utf8').catch(() => '{}'));
      const models = listed.filter(row => row.hidden !== true).map(row => ({
        ...(metadata.models?.find(model => model.slug === row.model) ?? {}),
        slug: row.model || row.id, display_name: row.displayName,
        visibility: 'list', default_reasoning_level: row.defaultReasoningEffort,
        supported_reasoning_levels: row.supportedReasoningEfforts?.map(level => ({ effort: level.reasoningEffort })),
      }));
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), models });
      return models;
    } finally {
      try { await syncAuth?.(); }
      finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  })();
  inflight.set(key, work);
  try { return await work; }
  finally { inflight.delete(key); }
}
