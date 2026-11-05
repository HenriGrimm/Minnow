import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeHardwareAccelerationPreference, writeShellZoomPercent, writeWindowCloseAction } from '../../electron/dist/desktop-shell-config.js';

test('concurrent Electron IPC preference updates persist together', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-shell-prefs-'));
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  await Promise.all([writeShellZoomPercent(125), writeHardwareAccelerationPreference(false), writeWindowCloseAction('background')]);
  const { desktopShell } = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(desktopShell.zoomPercent, 125);
  assert.equal(desktopShell.hardwareAcceleration, false);
  assert.equal(desktopShell.windowCloseAction, 'background');
});
