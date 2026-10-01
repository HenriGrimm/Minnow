/**
 * P5-A — Launch/teardown cycling, orphan proof (MIN-719).
 *
 * Kept in its own file because 20 real browser launches want the whole per-test
 * timeout budget to themselves, and because a leak here is a different kind of
 * defect from a wrong DOM read: an unattended overnight run that leaks one
 * browser per task ends the night with dozens of them.
 *
 * Skips cleanly when no Chromium-family browser exists.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { resetBrowserConfigCache } from '../../server/cdp/browser-config.js';
import {
  browserProfileRoot,
  discoverBrowser,
  isPidAlive,
  launchBrowser,
  trackedBrowserPids,
} from '../../server/browser-driver/index.js';

const CYCLES = Number(process.env.MINNOW_BROWSER_DRIVER_CYCLES ?? 20);

const previousHome = process.env.MINNOW_HOME;
const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mn-driver-cycles-'));
process.env.MINNOW_HOME = homeDir;
resetMinnowHomeCache();
resetBrowserConfigCache();

const capability = await discoverBrowser();
const skipReason = capability.available
  ? false
  : `no Chromium-family browser on this machine (${capability.reason})`;

after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetBrowserConfigCache();
  await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * Count processes (of any depth — renderers and GPU helpers included) whose
 * command line still references our profile root. `taskkill /T` is supposed to
 * take the whole tree; this is what proves it did.
 *
 * Returns null when the query is unavailable, so the pid assertions stay the
 * floor rather than the ceiling.
 *
 * The image-name filter is not cosmetic: without it the query matches the
 * PowerShell process running it, whose own command line contains the needle.
 *
 * @param {string} needle
 * @param {string} imageName e.g. `chrome.exe`
 * @returns {number | null}
 */
function countProcessesReferencing(needle, imageName) {
  if (process.platform !== 'win32') return null;
  try {
    const escaped = needle.replace(/'/g, "''");
    const escapedName = imageName.replace(/'/g, "''");
    const out = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='${escapedName}'" | ` +
          `Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${escaped}*' }).Count`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    if (out.status !== 0 || !out.stdout) return null;
    const n = Number(out.stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

describe('browser driver — launch/teardown cycles', { skip: skipReason }, () => {
  test(`${CYCLES} launch/teardown cycles leave no orphaned process`, async () => {
    /** @type {number[]} */
    const pids = [];
    for (let i = 0; i < CYCLES; i += 1) {
      const launched = await launchBrowser({
        label: `cycle-${i}`,
        hardTimeoutMs: 60_000,
      });
      assert.equal(launched.ok, true, `cycle ${i} failed to launch: ${launched.ok ? '' : launched.detail}`);
      const session = launched.session;
      pids.push(session.status().pid);

      assert.equal(await session.evaluate('1 + 1'), 2);
      await session.close();
      assert.equal(session.status().alive, false);
    }

    assert.equal(pids.length, CYCLES);
    // Windows recycles PIDs quickly, so a closed cycle's pid can legitimately reappear.
    assert.ok(new Set(pids).size >= CYCLES - 3, `cycles should be separate processes (${new Set(pids).size}/${CYCLES} distinct pids)`);

    const reapDeadline = Date.now() + 30_000;
    /** @type {number[]} */
    let alive = pids.filter((pid) => isPidAlive(pid));
    while (alive.length > 0 && Date.now() < reapDeadline) {
      await new Promise((r) => setTimeout(r, 250));
      alive = alive.filter((pid) => isPidAlive(pid));
    }
    assert.deepEqual(alive, [], `orphaned browser processes: ${alive.join(', ')}`);
    assert.deepEqual(trackedBrowserPids(), [], 'the driver should track no live browsers');

    const stillReferencing = countProcessesReferencing(
      path.join(homeDir, 'browser-profiles'),
      path.basename(capability.available ? capability.executablePath : 'chrome.exe'),
    );
    if (stillReferencing !== null) {
      assert.equal(
        stillReferencing,
        0,
        'no browser process may still reference a driver profile directory',
      );
    }

    const leftovers = await fsp.readdir(browserProfileRoot()).catch(() => []);
    assert.deepEqual(leftovers, [], `profile directories were left behind: ${leftovers.join(', ')}`);
  });

  test('a host that exits without closing leaves no browser behind', async () => {
    const scriptPath = path.join(homeDir, 'orphan-host.mjs');
    const driverIndex = path
      .resolve(import.meta.dirname, '..', '..', 'server', 'browser-driver', 'index.js')
      .replace(/\\/g, '/');
    await fsp.writeFile(
      scriptPath,
      `import { launchBrowser } from 'file:///${driverIndex}';\n` +
        `const launched = await launchBrowser({ label: 'orphan', hardTimeoutMs: 60000 });\n` +
        `if (!launched.ok) { console.log(JSON.stringify({ error: launched.detail })); process.exit(2); }\n` +
        `console.log(JSON.stringify({ pid: launched.session.status().pid }));\n` +
        `process.exit(0);\n`,
      'utf8',
    );

    const out = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, MINNOW_HOME: homeDir },
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(out.status, 0, `host script failed: ${out.stdout}\n${out.stderr}`);
    const { pid } = JSON.parse(String(out.stdout).trim().split('\n').at(-1));
    assert.ok(Number.isInteger(pid) && pid > 0, `expected a pid, got ${out.stdout}`);

    const deadline = Date.now() + 15_000;
    while (isPidAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(isPidAlive(pid), false, `browser ${pid} outlived the host process that launched it`);
  });
});
