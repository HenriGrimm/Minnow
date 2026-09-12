/**
 * Packaging contract: the Electron asar must include every src/ module the
 * Node server imports. Missing src/models/*.mjs is what made v0.0.5 Windows
 * fail to start ("Cannot find module .../memory-model.mjs").
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('packaged runtime files', () => {
  it('lists src/models/** in electron-builder files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(
      pkg.build.files.includes('src/models/**'),
      'server llama.cpp paths import src/models/*.mjs at runtime',
    );
  });

  it('lists src/agents/defaults/sub-agents.json in electron-builder files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(
      pkg.build.files.includes('src/agents/defaults/sub-agents.json'),
      'server/sub-agents/config.js reads shipped defaults via new URL(..., import.meta.url)',
    );
  });

  it('asar-resident impeccable registry does not import extraResources JSON', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src/skills/impeccable/harness-registry.mjs'),
      'utf8',
    );
    assert.doesNotMatch(
      src,
      /harness-commands\.json/,
      'JSON lives in extraResources; packaged Node cannot import it from app.asar',
    );
    assert.match(src, /harness-commands\.mjs/);
  });

  it('passes validate-packaged-runtime-files', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-packaged-runtime-files.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OK/);
  });
});
