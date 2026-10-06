/**
 * Which script a scheduled run spawns for its headless turn, and from where.
 *
 * A checkout runs `bin/minnow.mjs`, which loads the TypeScript entry through
 * tsx. An installed build has neither tsx nor the `.ts` sources, so it runs the
 * single-file bundle `scripts/build-headless-runner.mjs` wrote at package time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMinnowHome } from '../config/home.js';
import { HEADLESS_RUNNER_BUNDLE } from '../constants/headless-runner.js';
import { getAppRoot, isAppRootPackaged } from '../workspace/root.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @returns {{ script: string, cwd: string, bundled: boolean }}
 * @throws when an installed build was packaged without the bundle
 */
export function resolveHeadlessRunEntry() {
  if (!isAppRootPackaged()) {
    return { script: path.join(PROJECT_ROOT, 'bin/minnow.mjs'), cwd: getAppRoot(), bundled: false };
  }

  const script = path.join(getAppRoot(), HEADLESS_RUNNER_BUNDLE);
  if (!fs.existsSync(script)) {
    throw new Error(
      `This Minnow build is missing its headless runner (${HEADLESS_RUNNER_BUNDLE}), so scheduled jobs cannot run. Reinstall Minnow.`,
    );
  }
  // The packaged app root is app.asar — a file, which spawn() rejects as a cwd.
  // The run only uses absolute paths, so any directory that exists will do.
  return { script, cwd: getMinnowHome(), bundled: true };
}
