/**
 * Packaged Electron scheduler lifecycle contract.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('the packaged in-process server owns the scheduler loop lifecycle', () => {
  const host = fs.readFileSync(new URL('../../electron/server-host.ts', import.meta.url), 'utf8');
  assert.match(host, /setSchedulerServerBaseUrl\(schedulerUrl\)/);
  assert.match(host, /startSchedulerTickLoop\(\{ baseUrl: schedulerUrl \}\)/);
  assert.match(host, /stopSchedulerTickLoop\(\)/);
  assert.match(host, /shutdownSchedulerRuns\(\)/);
});

test('Electron wake events request immediate scheduler recovery', () => {
  const main = fs.readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
  assert.match(main, /powerMonitor\.on\('resume', notify\)/);
  assert.match(main, /powerMonitor\.on\('unlock-screen', notify\)/);
  assert.match(main, /api\/scheduler\/wake/);
});
