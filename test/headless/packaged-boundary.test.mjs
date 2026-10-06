import fs from 'node:fs';
import { test } from 'node:test';

// The compiled host serves the built SPA, so it needs `dist/` as well as `electron/dist/`.
if (fs.existsSync(new URL('../../electron/dist/server-host.js', import.meta.url))
  && fs.existsSync(new URL('../../dist/index.html', import.meta.url))) {
  process.env.BOUNDARY_HOST_MODE = 'packaged';
  await import('./production-boundary.test.mjs');
} else {
  test('compiled in-process host boundary contract (run npm run build and npm run electron:build first)', { skip: 'Compiled Electron host is unavailable' }, () => {});
}
