/**
 * Stale ~/.minnow/lsp.json gains missing built-in stubs on load (feature-02).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  invalidateLspConfigCache,
  loadMergedLspConfig,
  migrateLspJsonMissingBuiltins,
} from '../../server/lsp/config-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const STALE_FIXTURE = path.join(__dirname, '../fixtures/lsp-stale-home');

async function readDefaults() {
  const raw = await fs.readFile(
    path.join(PROJECT_ROOT, 'src/lsp/defaults.json'),
    'utf8',
  );
  return JSON.parse(raw);
}

describe('migrateLspJsonMissingBuiltins', () => {
  test('adds stubs for missing builtins except fake', async () => {
    const defaults = await readDefaults();
    const stale = JSON.parse(
      await fs.readFile(path.join(STALE_FIXTURE, 'lsp.json'), 'utf8'),
    );
    const { payload, mutated } = migrateLspJsonMissingBuiltins(defaults, stale);
    assert.equal(mutated, true);
    assert.equal(payload.lsp.typescript.disabled, false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.lsp, 'fake'), false);

    const builtinIds = Object.keys(defaults.lsp).filter((id) => id !== 'fake');
    for (const id of builtinIds) {
      assert.ok(payload.lsp[id], `missing stub for ${id}`);
      if (id !== 'typescript') {
        const def = defaults.lsp[id];
        const expectedDisabled = def?.defaultEnabled === true ? false : true;
        assert.equal(payload.lsp[id].disabled, expectedDisabled, id);
      }
    }
  });

  test('removes pruned built-in stubs without a custom command', async () => {
    const defaults = await readDefaults();
    const stale = JSON.parse(
      await fs.readFile(path.join(STALE_FIXTURE, 'lsp.json'), 'utf8'),
    );
    stale.lsp.eslint = { disabled: true };
    stale.lsp.oxlint = {
      disabled: false,
      command: ['oxlint', '--lsp'],
      extensions: ['.ts'],
    };
    const { payload, mutated } = migrateLspJsonMissingBuiltins(defaults, stale);
    assert.equal(mutated, true);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.lsp, 'eslint'), false);
    assert.ok(payload.lsp.oxlint);
    assert.deepEqual(payload.lsp.oxlint.command, ['oxlint', '--lsp']);
  });

  test('second migration is idempotent', async () => {
    const defaults = await readDefaults();
    const stale = JSON.parse(
      await fs.readFile(path.join(STALE_FIXTURE, 'lsp.json'), 'utf8'),
    );
    const first = migrateLspJsonMissingBuiltins(defaults, stale);
    const second = migrateLspJsonMissingBuiltins(defaults, first.payload);
    assert.equal(second.mutated, false);
  });
});

describe('loadMergedLspConfig migration on disk', () => {
  let homeDir;

  before(async () => {
    homeDir = path.join(__dirname, '../fixtures/lsp-migrate-run-home');
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.copyFile(
      path.join(STALE_FIXTURE, 'lsp.json'),
      path.join(homeDir, 'lsp.json'),
    );
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  test('persists missing builtin stubs after first load', async () => {
    invalidateLspConfigCache();
    await loadMergedLspConfig();
    const onDisk = JSON.parse(
      await fs.readFile(path.join(homeDir, 'lsp.json'), 'utf8'),
    );
    const defaults = await readDefaults();
    const builtinIds = Object.keys(defaults.lsp).filter((id) => id !== 'fake');
    assert.equal(builtinIds.length, 15);
    for (const id of builtinIds) {
      assert.ok(onDisk.lsp[id], `disk missing ${id}`);
    }
    assert.equal(onDisk.lsp.typescript.disabled, false);

    invalidateLspConfigCache();
    const mtimeBefore = (await fs.stat(path.join(homeDir, 'lsp.json'))).mtimeMs;
    await loadMergedLspConfig();
    const mtimeAfter = (await fs.stat(path.join(homeDir, 'lsp.json'))).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  });
});
