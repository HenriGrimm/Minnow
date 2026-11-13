import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AGENT_CLI_DEFINITIONS, clearAgentCliModelCatalogCache } from './agent-cli-catalog.js';
import { detectAgentCli } from './agent-cli-detect.js';
import { getAgentCliProviderConfig } from '../providers/store.js';
import { applyAgentCliCaptureEnv, cursorAgentVersionSortKey, resolveAgentCliBin } from '../generations/agent-cli/resolve-bin.js';
import { beginAgentCliMaintenance } from '../generations/agent-cli/admission.js';
import { cliSessionIsIdle, disposeCliSessions } from '../generations/agent-cli/lifecycle.js';
import { runProcess } from '../process-runner.js';

const VERSION = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?=\s|$)/i;
const CURSOR_VERSION = /\b(\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]{6,40})\b/i;
const FEEDS = {
  claude: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest',
  codex: 'https://registry.npmjs.org/@openai%2fcodex/latest',
  cursor: process.platform === 'win32' ? 'https://cursor.com/install?win32=true' : 'https://cursor.com/install',
};

export function parseCliVersion(kind, text) {
  return String(text ?? '').match(kind === 'cursor' ? CURSOR_VERSION : VERSION)?.[1] ?? null;
}

export function compareCliVersions(kind, installed, latest) {
  if (installed === latest) return 'current';
  if (kind === 'cursor') {
    const a = cursorAgentVersionSortKey(installed);
    const b = cursorAgentVersionSortKey(latest);
    // Different hashes from the same date have no reliable order.
    return a === b ? 'unavailable' : a < b ? 'available' : 'current';
  }
  const a = installed.split(/[.-]/, 3).map(Number);
  const b = latest.split(/[.-]/, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? 'available' : 'current';
  }
  return installed.includes('-') && !latest.includes('-') ? 'available' : 'current';
}

async function detect(kind, fresh) {
  const { profile, secrets } = await getAgentCliProviderConfig(kind);
  return detectAgentCli(kind, { binPath: profile?.agentCli?.binPath, cliToken: secrets.cliToken, fresh });
}

async function readLatestVersion(kind, request) {
  const response = await request(FEEDS[kind], { signal: AbortSignal.timeout(8_000) });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.length > 128 * 1024) return null;
    }
    raw += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  if (kind === 'cursor') {
    // Read the artifact version from the platform's official installer as text.
    return parseCliVersion(kind, raw.match(/https:\/\/downloads\.cursor\.com\/lab\/([^/]+)\//)?.[1]);
  }
  const version = parseCliVersion(kind, JSON.parse(raw).version);
  return version?.includes('-') ? null : version;
}

export function createAgentCliUpdates(deps = {}) {
  const detectCli = deps.detect ?? detect;
  const request = deps.fetch ?? globalThis.fetch;
  const run = deps.run ?? runProcess;
  const feeds = new Map();
  const running = new Map();
  let checking;
  let lastCheck = 0;
  let lastResult;

  async function scan(force) {
    if (checking) return checking;
    const now = Date.now();
    if (lastResult && now - lastCheck < (force ? 5_000 : 60_000)) return lastResult;
    checking = Promise.all(Object.values(AGENT_CLI_DEFINITIONS).map(async ({ kind, label }) => {
      if (running.has(kind)) return lastResult?.items.find(item => item.kind === kind) ?? null;
      const detection = await detectCli(kind, force);
      if (!detection.installed) return null;
      const installedVersion = parseCliVersion(kind, detection.version);
      let feed = feeds.get(kind);
      if (installedVersion && (!feed || now >= feed.expiresAt || (force && now - feed.at >= 60_000))) {
        const version = await readLatestVersion(kind, request).catch(() => null);
        feed = { version, at: now, expiresAt: now + (version ? 4 * 60 * 60_000 : 5 * 60_000) };
        feeds.set(kind, feed);
      }
      const latestVersion = feed?.version ?? null;
      return { kind, label, installedVersion, latestVersion,
        state: installedVersion && latestVersion ? compareCliVersions(kind, installedVersion, latestVersion) : 'unavailable' };
    })).then(rows => {
      lastCheck = Date.now();
      return lastResult = { items: rows.filter(Boolean), checkedAt: lastCheck };
    }).finally(() => { checking = undefined; });
    return checking;
  }

  function update(kind) {
    if (running.has(kind)) return running.get(kind);
    const { providerId, label } = AGENT_CLI_DEFINITIONS[kind];
    const release = beginAgentCliMaintenance(providerId);
    if (!release) throw new Error(`Finish or stop active ${label} work before updating.`);
    const work = (async () => {
      await disposeCliSessions(session => session.providerId === providerId && cliSessionIsIdle(session));
      const before = await detectCli(kind, true);
      if (!before.resolvedCommand) throw new Error(`${label} is not installed.`);
      const bin = process.platform === 'win32' && kind === 'codex' && before.resolvedBinPath?.toLowerCase().endsWith('.cmd')
        ? await resolveAgentCliBin({ kind, binPath: before.resolvedBinPath, forUpdate: true })
        : { command: before.resolvedCommand, argsPrefix: before.resolvedArgsPrefix };
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cli-update-'));
      let result;
      try {
        result = await run(bin.command, [...bin.argsPrefix, 'update'], {
          cwd,
          env: applyAgentCliCaptureEnv(process.env, bin.command),
          ignoreStdin: true,
          timeout: 185_000,
          // Installation belongs to the host even if the renderer navigates away.
          signal: AbortSignal.timeout(180_000),
        }).catch(() => null);
      } finally { await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}); }
      clearAgentCliModelCatalogCache(kind);
      const after = await detectCli(kind, true);
      const installedVersion = parseCliVersion(kind, after.version);
      if (result?.code !== 0 || !installedVersion) {
        throw new Error(`Could not update ${label}. Retry or use your original package manager.`);
      }
      return { installedVersion };
    })().finally(() => {
      running.delete(kind);
      release();
      // A check that started before the update must not repopulate stale versions.
      const invalidate = () => { lastResult = undefined; };
      invalidate();
      void checking?.then(invalidate, invalidate);
    });
    running.set(kind, work);
    return work;
  }
  async function check(force = false) {
    return { ...await scan(force), installing: [...running.keys()] };
  }
  return { check, update };
}
