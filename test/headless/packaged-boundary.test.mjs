import fs from 'node:fs';
import { test } from 'node:test';

if (fs.existsSync(new URL('../../electron/dist/server-host.js', import.meta.url))) {
  process.env.BOUNDARY_HOST_MODE = 'packaged';
  await import('./production-boundary.test.mjs');
} else {
  test('compiled in-process host boundary contract (run npm run electron:build first)', { skip: 'Compiled Electron host is unavailable' }, () => {});
}
