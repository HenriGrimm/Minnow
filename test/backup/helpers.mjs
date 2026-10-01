/**
 * Shared fixtures for backup/restore tests: temp Minnow homes seeded through the
 * real stores, so a restored home is checked the way the app would read it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { readWholeSessionState, writeWholeSessionState } from '../../server/config/sessions-repo.js';
import {
  readEncryptedJsonFile,
  resetSecretBoxCacheForTests,
  writeEncryptedJsonFile,
} from '../../server/security/secret-box.js';
import { createJob, listJobs } from '../../server/scheduler/store.js';
import { readArchive } from '../../server/backup/format.js';

export const PASSPHRASE = 'correct horse battery staple';
/** Cheap scrypt cost so the suite stays fast; production defaults are covered once. */
export const FAST_KDF = { N: 1 << 14, r: 8, p: 1 };

export const PROVIDER_SECRET = 'sk-PROVIDER-SECRET-7f3a9c';
export const SEARCH_SECRET = 'BRAVE-PLAINTEXT-SECRET-55aa';
export const MCP_ENV_SECRET = 'ghp_MCP-ENV-SECRET-91bd';
export const JOB_PROMPT = 'Summarise the SCHEDULED-JOB-PROMPT-4412 report';

export const CHAT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CHAT_MESSAGE = 'What does the tide table say for Thursday?';

/** @type {string[]} */
const tempDirs = [];

/** @param {string} prefix */
export async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `minnow-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Point every store at `home` and drop anything cached for the previous one. */
export function useHome(home) {
  closeSessionsDb();
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
}

export async function cleanupTempDirs() {
  closeSessionsDb();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} home
 * @param {string} rel
 * @param {string | Buffer} content
 */
export async function writeHomeFile(home, rel, content) {
  const abs = path.join(home, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

/**
 * @param {string} home
 * @param {string} rel
 */
export async function readHomeFile(home, rel) {
  return fs.readFile(path.join(home, ...rel.split('/')), 'utf8');
}

/**
 * @param {string} home
 * @param {string} rel
 */
export async function homeHas(home, rel) {
  try {
    await fs.lstat(path.join(home, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string[]} messages
 */
export function makeChat(id, name, messages) {
  return {
    id,
    name,
    workspacePath: '',
    modelId: '',
    modeId: 'build',
    history: messages.flatMap((content) => [
      { role: 'user', content },
      { role: 'assistant', content: `Reply to: ${content}` },
    ]),
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
  };
}

/** @param {ReturnType<typeof makeChat>[]} chats */
export function makeState(chats) {
  return {
    version: 6,
    activeId: chats[0]?.id ?? '',
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    groups: [],
    chats,
  };
}

/**
 * A home with a little of everything: chats, Brain, issues, an encrypted
 * provider key, plaintext search keys, a scheduled job, and plenty that a
 * backup must leave behind.
 * @param {string} home
 */
export async function seedHome(home) {
  useHome(home);
  await ensureMinnowLayout();

  await writeHomeFile(
    home,
    'search.json',
    JSON.stringify({ provider: 'brave', keys: { braveApiKey: SEARCH_SECRET, tavilyApiKey: '' } }, null, 2),
  );
  await writeHomeFile(
    home,
    'mcp.json',
    JSON.stringify(
      { servers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: MCP_ENV_SECRET }, enabled: true } } },
      null,
      2,
    ),
  );
  await writeHomeFile(
    home,
    'providers/openrouter/profile.json',
    JSON.stringify({ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api' }, null, 2),
  );
  await writeEncryptedJsonFile(path.join(home, 'providers', 'openrouter', 'secrets.json'), {
    apiKey: PROVIDER_SECRET,
  });

  writeWholeSessionState(makeState([makeChat(CHAT_ID, 'Tide tables', [CHAT_MESSAGE])]));
  closeSessionsDb();

  await writeHomeFile(home, 'brain/pages/facts/harbour.md', '# Harbour\n\nThe ferry leaves at nine.\n');
  await writeHomeFile(home, 'brain/code/index.db', 'regenerable code index');
  await writeHomeFile(home, 'memory/notes.json', JSON.stringify({ entries: ['remember the ferry'] }));
  await writeHomeFile(
    home,
    'issues/state.json',
    JSON.stringify({ version: 3, issues: [{ id: 'MIN-1', title: 'Back up the harbour log' }] }, null, 2),
  );
  await writeHomeFile(home, 'boards/harbour/journal.jsonl', '{"type":"run.started"}\n');
  await writeHomeFile(home, 'skills/tides/SKILL.md', '# Tides\n');
  await writeHomeFile(home, 'workspace/notes.txt', 'sandbox file');
  await writeHomeFile(home, 'workspace/node_modules/pkg/index.js', 'module.exports = 1;');

  await createJob({
    label: 'Morning report',
    schedule: { kind: 'interval', value: '6h' },
    prompt: JOB_PROMPT,
    modeId: 'build',
    channels: ['in_app'],
  });

  // Things a backup never carries.
  await writeHomeFile(home, 'logs/diagnostics.jsonl', '{"noise":true}\n');
  await writeHomeFile(home, 'browser-profiles/tab-1/Cookies', 'cookie jar');
  await writeHomeFile(home, 'screenshots/shot.png', 'not really a png');
  await writeHomeFile(home, 'worktrees/board/file.txt', 'worktree');
  await writeHomeFile(home, 'sessions/snapshots/sessions-2026-01-01.db', 'old snapshot');
  await writeHomeFile(home, 'session-token', 'per-boot token');
  return home;
}

/** Chat names and message texts as the app reads them from `home`. */
export function readChats(home) {
  useHome(home);
  const state = readWholeSessionState();
  closeSessionsDb();
  return state.chats.map((chat) => ({
    id: chat.id,
    name: chat.name,
    messages: chat.history.map((message) => message.content),
  }));
}

/** The provider secret as the app decrypts it in `home`. */
export async function readProviderSecret(home) {
  useHome(home);
  const secrets = await readEncryptedJsonFile(path.join(home, 'providers', 'openrouter', 'secrets.json'));
  return secrets.apiKey;
}

/** Scheduler jobs as the app decrypts them in `home`. */
export async function readJobs(home) {
  useHome(home);
  return listJobs();
}

/**
 * Every entry of an archive with its content, for assertions on what was written.
 * @param {string} archivePath
 * @param {string} [passphrase]
 */
export async function readAllEntries(archivePath, passphrase) {
  /** @type {Map<string, { meta: Record<string, unknown>, content: Buffer }>} */
  const entries = new Map();
  const { header } = await readArchive({
    archivePath,
    passphrase,
    onEntry: async ({ meta, chunks }) => {
      const parts = [];
      for await (const chunk of chunks) parts.push(chunk);
      entries.set(meta.p, { meta, content: Buffer.concat(parts) });
    },
  });
  return { header, entries };
}
