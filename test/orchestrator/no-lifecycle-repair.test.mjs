/**
 * P4-B (MIN-714) — renderer lifecycle-repair is gone.
 *
 * P1-G proved restart = replay. After this phase, nothing under `src/` repairs
 * board state because a window slept, reloaded, or starved. P4-C retired the
 * leftover planner-hub chrome in `src/chat/orchestrate/`. Keepers that used to
 * live there moved to `src/chat/plans/` and `src/orchestrator/`.
 *
 * Runs on the plain `node` runner with no loader flags.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const ORCHESTRATE_DIR = path.join(SRC_DIR, 'chat', 'orchestrate');

/**
 * Presentation modules still allowed under `src/chat/orchestrate/`.
 * Anything else in that directory is engine-shaped leftover and must not return.
 */
const ALLOWED_ORCHESTRATE_FILES = [];

/**
 * Strings that named the V1 repair subsystem. The Phase 4 grep gate is that
 * none of these appear anywhere under `src/` — comments included.
 */
const BANNED_REPAIR_SUBSTRINGS = [
  'display-wake',
  'boot-resume',
  'oom-recovery',
  'reconcileRunningBoards',
];

/**
 * @param {string} dir
 * @returns {{ path: string, rel: string }[]}
 */
function walkSourceFiles(dir) {
  /** @type {{ path: string, rel: string }[]} */
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        out.push({
          path: full,
          rel: path.relative(SRC_DIR, full).split(path.sep).join('/'),
        });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

describe('P4-B no renderer lifecycle-repair (MIN-714)', () => {
  it('src/chat/orchestrate/ is empty or gone (planner-hub chrome retired in P4-C)', () => {
    if (!fs.existsSync(ORCHESTRATE_DIR)) return;
    const names = fs
      .readdirSync(ORCHESTRATE_DIR)
      .filter((n) => n.endsWith('.ts'))
      .sort();
    assert.deepEqual(names, ALLOWED_ORCHESTRATE_FILES);
  });

  it('src/ has no display-wake / boot-resume / oom-recovery / reconcileRunningBoards', () => {
    for (const file of walkSourceFiles(SRC_DIR)) {
      const source = fs.readFileSync(file.path, 'utf8');
      for (const banned of BANNED_REPAIR_SUBSTRINGS) {
        assert.equal(
          source.includes(banned),
          false,
          `${file.rel} still names ${banned}`,
        );
      }
    }
  });

  it('no src/ module subscribes to visibility or power events for board reasons', () => {
    const visOrPower =
      /addEventListener\s*\(\s*['"]visibilitychange['"]|power-state|getBattery/;

    const boardDirs = [
      path.join(SRC_DIR, 'chat', 'orchestrate'),
      path.join(SRC_DIR, 'orchestrator'),
    ];
    for (const dir of boardDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of walkSourceFiles(dir)) {
        const source = fs.readFileSync(file.path, 'utf8');
        assert.equal(
          visOrPower.test(source),
          false,
          `${file.rel} wires visibility/power next to the board view`,
        );
      }
    }

    for (const file of walkSourceFiles(path.join(SRC_DIR, 'boot'))) {
      const source = fs.readFileSync(file.path, 'utf8');
      if (file.rel.endsWith('boot/render-idle.ts')) continue;
      assert.equal(
        visOrPower.test(source),
        false,
        `${file.rel} wires visibility/power at boot for a board`,
      );
    }
  });
});
