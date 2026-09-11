/**
 * P5-A — Server-side browser driver (MIN-719).
 *
 * The public surface. P5-B wraps these as tools; P5-C calls
 * `probeBrowserCapability()` to decide whether the browser rung of the Final
 * Tester ladder can run at all.
 *
 * Typical use:
 *
 *   const launched = await launchBrowser({ label: boardId, hardTimeoutMs: 120_000 });
 *   if (!launched.ok) return skipBrowserRung(launched.reason, launched.detail);
 *   try {
 *     const nav = await launched.session.navigate('http://localhost:5173/');
 *     const text = await launched.session.text();
 *     const errors = launched.session.consoleMessages().filter((m) => m.level === 'error');
 *   } finally {
 *     await launched.session.close();
 *   }
 *
 * The `finally` is belt-and-braces: `hardTimeoutMs` kills the browser anyway,
 * and a host exit drains whatever is still registered.
 */

export {
  BROWSER_PATH_ENV,
  MAC_BROWSER_BUNDLES,
  browserCandidates,
  discoverBrowser,
  familyFromPath,
  probeBrowserCapability,
  spotlightBrowserCandidates,
} from './discover.js';

export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_LAUNCH_TIMEOUT_MS,
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  MAX_CONSOLE_ENTRIES,
  buildLaunchArgs,
  capText,
  normalizeLaunchOptions,
} from './launch-options.js';

export {
  browserProfileRoot,
  createProfileDir,
  removeProfileDir,
  sweepStaleProfiles,
} from './profile.js';

export {
  checkBrowserHealth,
  isPidAlive,
  killBrowserProcess,
  launchBrowserProcess,
  listTargets,
  trackedBrowserPids,
} from './process.js';

export { CdpClient, CdpError, connectTarget } from './cdp-client.js';

export { buildSnapshot, renderTree, resolveUid, takeSnapshot } from './snapshot.js';

export { BrowserDriverError, BrowserSession, launchBrowser } from './session.js';
