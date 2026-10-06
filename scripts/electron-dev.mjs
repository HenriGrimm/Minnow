#!/usr/bin/env node

import { ensureElectronBuild, spawnElectronShell } from './spawn-electron.mjs';
import { waitForMinnowDev } from './wait-for-minnow-dev.mjs';
import { resolveMinnowPort } from '../server/constants/minnow-port.js';

async function main() {
  const preferredPort = resolveMinnowPort();
  console.log(`[electron:dev] Waiting for Minnow dev server near port ${preferredPort}…`);

  const buildPromise = ensureElectronBuild();

  const { origin, port } = await waitForMinnowDev({
    preferredPort,
    logLabel: '[electron:dev]',
  });
  await buildPromise;

  const devUrl = `${origin}/`;
  console.log(`[electron:dev] Minnow dev server ready at ${devUrl}`);
  console.log('[electron:dev] Launching Electron…');
  const child = await spawnElectronShell({
    port,
    devUrl,
    dev: true,
    foreground: true,
  });
  if (!child) {
    throw new Error('Electron did not start');
  }
  await new Promise((resolve, reject) => {
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Electron exited with ${code} (signal ${signal ?? 'none'})`));
    });
  });
}

main().catch((err) => {
  console.error('[electron:dev]', err.message || err);
  process.exit(1);
});
