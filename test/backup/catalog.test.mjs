/**
 * The backup catalog and the secret scanner.
 *
 * The first suite is a drift guard: every entry the server keeps in the Minnow
 * home must be either backed up or listed as deliberately left out. A new store
 * that is in neither list would silently be missing from every backup.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  BACKUP_CATEGORIES,
  CREDENTIALS_CATEGORY,
  NEVER_BACKED_UP,
  RESTORE_OWN_ENTRIES,
  defaultCategoryIds,
  findRootForPath,
  isCredentialPath,
  isExcludedByRoot,
  isJunkName,
  normalizeCategoryIds,
} from '../../server/backup/catalog.js';
import {
  containsSecretEnvelope,
  redactPlaintextSecrets,
  refillRedactedSecrets,
} from '../../server/backup/secrets-scan.js';
import { SCAFFOLD_DIRS } from '../../server/config/home.js';
import { ALLOWED_CONFIG_FILES } from '../../server/config/paths.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ROOT_PATHS = BACKUP_CATEGORIES.flatMap((category) => category.roots.map((root) => root.path));
const CLASSIFIED = new Set([...ROOT_PATHS, ...NEVER_BACKED_UP, ...RESTORE_OWN_ENTRIES]);

/** Top-level home entries the server source builds paths for. */
function homeEntriesUsedByServer() {
  /** @type {Map<string, string>} name → first file that uses it */
  const found = new Map();
  const pattern = /getMinnowHome\(\)\s*,\s*'([^']+)'/g;
  /** @type {string[]} */
  const stack = [path.join(REPO_ROOT, 'server')];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'python') stack.push(abs);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(abs, 'utf8');
      for (const match of source.matchAll(pattern)) {
        const top = match[1].split('/')[0];
        if (!found.has(top)) found.set(top, path.relative(REPO_ROOT, abs));
      }
    }
  }
  return found;
}

describe('catalog covers the home', () => {
  test('every home entry the server uses is backed up or listed as left out', () => {
    const unclassified = [...homeEntriesUsedByServer()]
      .filter(([name]) => !CLASSIFIED.has(name))
      .map(([name, file]) => `${name} (${file})`);
    assert.deepEqual(
      unclassified,
      [],
      'Add each to a category in server/backup/catalog.js, or to NEVER_BACKED_UP with a reason',
    );
  });

  test('every scaffolded folder and config file is classified', () => {
    const names = new Set([
      ...SCAFFOLD_DIRS.map((dir) => dir.split('/')[0]),
      ...[...ALLOWED_CONFIG_FILES].map((file) => file.split('/')[0]),
    ]);
    assert.deepEqual(
      [...names].filter((name) => !CLASSIFIED.has(name)),
      [],
    );
  });

  test('nothing is both backed up and listed as left out', () => {
    assert.deepEqual(
      ROOT_PATHS.filter((root) => NEVER_BACKED_UP.includes(root) || RESTORE_OWN_ENTRIES.includes(root)),
      [],
    );
  });

  test('roots are unique, top-level, and so never nested in one another', () => {
    assert.equal(new Set(ROOT_PATHS).size, ROOT_PATHS.length);
    assert.deepEqual(ROOT_PATHS.filter((root) => root.includes('/') || root.includes('\\')), []);
  });

  test('category ids are unique and only credentials needs a passphrase', () => {
    const ids = BACKUP_CATEGORIES.map((category) => category.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      BACKUP_CATEGORIES.filter((category) => category.requiresPassphrase).map((category) => category.id),
      [CREDENTIALS_CATEGORY],
    );
    assert.equal(defaultCategoryIds().includes('models'), false, 'models are large and off by default');
  });

  test('the encryption key is a credentials root', () => {
    assert.equal(findRootForPath('.key').category, CREDENTIALS_CATEGORY);
  });
});

describe('path rules', () => {
  test('credential paths are recognised wherever their root lives', () => {
    for (const rel of [
      '.key',
      'providers/openrouter/secrets.json',
      'mcp/secrets.json',
      'mcp/oauth/abc.json',
      'oauth/google.json',
      'auth/devices.json',
      'webhooks.json',
      'plugins/connections/linear.json',
    ]) {
      assert.equal(isCredentialPath(rel), true, rel);
    }
    for (const rel of ['providers/openrouter/profile.json', 'mcp/servers/github.json', 'config.json', 'plugins/registry.json']) {
      assert.equal(isCredentialPath(rel), false, rel);
    }
  });

  test('junk names are skipped: write temporaries, WAL sidecars, quarantined files', () => {
    for (const name of [
      '.gitkeep',
      'config.json.tmp-57600-1788400279160',
      'sessions.db-wal',
      'sessions.db-shm',
      'sessions.db.bak-shrink-2026-08-09',
      'state.corrupt-20260925-091613.bin',
      'minnow-backup.mnbak.partial',
      '.DS_Store',
    ]) {
      assert.equal(isJunkName(name), true, name);
    }
    for (const name of ['sessions.db', 'state.json', 'journal.jsonl', 'SKILL.md']) {
      assert.equal(isJunkName(name), false, name);
    }
  });

  test('excluded and omitted subpaths match by segment, not by prefix text', () => {
    const brain = findRootForPath('brain/pages/a.md').spec;
    assert.equal(isExcludedByRoot(brain, 'brain/code'), true);
    assert.equal(isExcludedByRoot(brain, 'brain/code/index.db'), true);
    assert.equal(isExcludedByRoot(brain, 'brain/.cleanup/x'), true);
    assert.equal(isExcludedByRoot(brain, 'brain/codex-notes.md'), false);
    assert.equal(isExcludedByRoot(brain, 'brain/pages/code/a.md'), false);
    const sessions = findRootForPath('sessions/sessions.db').spec;
    assert.equal(isExcludedByRoot(sessions, 'sessions/snapshots/sessions-1.db'), true);
    assert.equal(isExcludedByRoot(sessions, 'sessions/sessions.db'), false);
  });

  test('category lists are normalised to known ids in catalog order', () => {
    assert.deepEqual(normalizeCategoryIds(['issues', 'nope', 'settings', 'issues']), ['settings', 'issues']);
    assert.deepEqual(normalizeCategoryIds(undefined), defaultCategoryIds());
    assert.deepEqual(normalizeCategoryIds([], ['chats']), []);
  });
});

describe('secret scanning', () => {
  const envelope = { version: 1, encrypted: true, keySource: 'file', algorithm: 'aes-256-gcm', iv: 'a', tag: 'b', ciphertext: 'c' };

  test('finds a secret-box envelope at any depth', () => {
    assert.equal(containsSecretEnvelope(envelope), true);
    assert.equal(containsSecretEnvelope({ jobs: [{ label: 'x', promptEnc: envelope }] }), true);
    assert.equal(containsSecretEnvelope({ jobs: [{ label: 'x', encrypted: true }] }), false);
    assert.equal(containsSecretEnvelope('{"encrypted":true}'), false);
    assert.equal(containsSecretEnvelope(null), false);
  });

  test('blanks plaintext secrets and leaves everything else alone', () => {
    const source = {
      provider: 'brave',
      keys: { braveApiKey: 'BRAVE', tavilyApiKey: '' },
      sampler: { maxTokens: 4096 },
      servers: {
        github: {
          command: 'gh-mcp',
          args: ['--token-file', 'x'],
          env: { GITHUB_TOKEN: 'ghp_x', DATABASE_URL: 'postgres://u:p@h/db', DEBUG: '' },
          headers: { Authorization: 'Bearer y', 'X-Title': 'Minnow' },
        },
      },
      webhook: { client_secret: 's3', password: 'p4', label: 'not secret' },
      apiKeys: ['first', 'second'],
      recentModels: ['kept: a plain list under an ordinary key'],
    };
    const { value, paths } = redactPlaintextSecrets(source);

    assert.equal(source.keys.braveApiKey, 'BRAVE', 'the input is not mutated');
    assert.deepEqual(value.keys, { braveApiKey: '', tavilyApiKey: '' });
    assert.deepEqual(value.servers.github.env, { GITHUB_TOKEN: '', DATABASE_URL: '', DEBUG: '' });
    assert.deepEqual(value.servers.github.headers, { Authorization: '', 'X-Title': '' });
    assert.deepEqual(value.webhook, { client_secret: '', password: '', label: 'not secret' });
    assert.equal(value.sampler.maxTokens, 4096);
    assert.equal(value.servers.github.command, 'gh-mcp');
    assert.deepEqual(value.servers.github.args, ['--token-file', 'x']);
    assert.deepEqual(value.apiKeys, ['', '']);
    assert.deepEqual(value.recentModels, ['kept: a plain list under an ordinary key']);
    assert.equal(paths.length, 9, 'empty values are not reported as redacted');
    assert.ok(paths.some((p) => p.join('.') === 'keys.braveApiKey'));
  });

  test('refills only blanked fields, and only from a non-empty previous value', () => {
    const paths = [
      ['keys', 'braveApiKey'],
      ['keys', 'tavilyApiKey'],
      ['servers', 'gone', 'env', 'TOKEN'],
    ];
    const restored = { keys: { braveApiKey: '', tavilyApiKey: 'FROM-BACKUP' }, servers: {} };
    const existing = { keys: { braveApiKey: 'LOCAL', tavilyApiKey: 'LOCAL-2' }, servers: { gone: { env: { TOKEN: 't' } } } };
    const { value, filled } = refillRedactedSecrets(restored, existing, paths);
    assert.equal(filled, 1);
    assert.deepEqual(value, { keys: { braveApiKey: 'LOCAL', tavilyApiKey: 'FROM-BACKUP' }, servers: {} });
    assert.equal(restored.keys.braveApiKey, '', 'the input is not mutated');
  });

  test('a key with a dot in its name is one path segment', () => {
    const { value, paths } = redactPlaintextSecrets({ env: { 'my.api.token': 'x' } });
    assert.deepEqual(paths, [['env', 'my.api.token']]);
    assert.deepEqual(refillRedactedSecrets(value, { env: { 'my.api.token': 'local' } }, paths).value, {
      env: { 'my.api.token': 'local' },
    });
  });
});
