import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createJsonlDecoder } from '../generations/agent-cli/jsonl.js';
import { resolveAgentCliBin, applyAgentCliCaptureEnv } from '../generations/agent-cli/resolve-bin.js';
import { killProcessTreeAndWait } from '../terminal-runner.js';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

export function clearClaudeModelCatalogCache() { cache.clear(); }

/** Initialize the installed CLI's SDK protocol; never submit a user message. */
export async function readClaudeModelCatalog(invocation, timeoutMs = 15_000) {
  const child = spawn(invocation.command, [...invocation.argsPrefix,
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--no-chrome', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--no-session-persistence',
  ], { cwd: invocation.cwd, env: invocation.env, windowsHide: true, shell: false,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const decoder = createJsonlDecoder({ onEvent: row => {
        if (row.type !== 'control_response' || row.response?.request_id !== 'catalog') return;
        const response = row.response;
        if (response.subtype !== 'success' || !Array.isArray(response.response?.models)) {
          reject(new Error('Claude returned an invalid model catalog.'));
        } else if (response.response.models.length > 1000) {
          reject(new Error('Claude model catalog exceeded its size limit.'));
        } else resolve(response.response.models);
      } });
      let bytes = 0;
      child.stdout.on('data', chunk => {
        try {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) throw new Error('Claude catalog output exceeded its size limit.');
          decoder.write(chunk);
        } catch (error) { reject(error); }
      });
      // The handshake also includes account details and skills; neither is retained.
      child.stderr.on('data', () => {});
      child.once('error', () => reject(new Error('Claude model discovery could not start.')));
      child.once('close', () => reject(new Error('Claude exited before returning its model catalog.')));
      child.stdin.on('error', () => reject(new Error('Claude model discovery input closed.')));
      timer = setTimeout(() => reject(new Error('Claude model discovery timed out.')), timeoutMs);
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'catalog',
        request: { subtype: 'initialize', hooks: {} } })}\n`);
    });
  } finally {
    clearTimeout(timer);
    await killProcessTreeAndWait(child, { graceMs: 1500 });
    let closeTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Claude catalog process did not close after termination.')), 2000);
      })]);
    } finally { clearTimeout(closeTimer); }
  }
}

export async function fetchClaudeModelCatalog(options = {}) {
  const env = options.env ?? process.env;
  const bin = await resolveAgentCliBin({ kind: 'claude', ...options });
  const configRoot = env.CLAUDE_CONFIG_DIR || path.join(options.homeDir ?? os.homedir(), '.claude');
  const stamps = await Promise.all([bin.display, path.join(configRoot, '.credentials.json'),
    path.join(configRoot, 'credentials.json')].map(file => fs.stat(file)
    .then(stat => [stat.mtimeMs, stat.size]).catch(() => null)));
  const key = createHash('sha256').update(JSON.stringify([bin.command, bin.argsPrefix,
    options.cliVersion, configRoot, stamps, options.cliToken,
    ...['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL'].map(name => env[name]),
  ])).digest('hex');
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < TTL_MS) return cached.models;
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-claude-catalog-'));
    try {
      const runEnv = applyAgentCliCaptureEnv(env, bin.command);
      runEnv.DISABLE_AUTOUPDATER = '1';
      if (options.cliToken?.trim()) runEnv.CLAUDE_CODE_OAUTH_TOKEN = options.cliToken.trim();
      const models = await readClaudeModelCatalog({ ...bin, cwd, env: runEnv });
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), models });
      return models;
    } finally { await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  })();
  inflight.set(key, work);
  try { return await work; }
  finally { inflight.delete(key); }
}
