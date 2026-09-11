import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadBrowserConfig } from '../cdp/browser-config.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {'chrome' | 'chrome-canary' | 'edge' | 'brave' | 'chromium'} BrowserFamily
 * @typedef {object} BrowserCandidate
 * @property {string} executablePath
 * @property {BrowserFamily} family
 * @typedef {object} BrowserCapabilityAvailable
 * @property {true} available
 * @property {string} executablePath
 * @property {BrowserFamily} family
 * @property {'env' | 'probe'} source
 * @typedef {object} BrowserCapabilityUnavailable
 * @property {false} available
 * @property {'disabled-in-settings' | 'no-chromium-browser' | 'env-path-missing'} reason
 * @property {string} detail
 * @property {string[]} searched
 * @typedef {BrowserCapabilityAvailable | BrowserCapabilityUnavailable} BrowserCapability
 */

export const BROWSER_PATH_ENV = 'MINNOW_BROWSER_PATH';

/**
 * macOS Chromium builds in preference order. Windows always ships Edge, but a
 * Mac often has only Safari plus one of these, so every channel counts.
 * `executable` is the bundle's CFBundleExecutable, which survives renaming the .app.
 * @type {ReadonlyArray<{ bundleId: string, executable: string, family: BrowserFamily }>}
 */
export const MAC_BROWSER_BUNDLES = Object.freeze([
  { bundleId: 'com.google.Chrome', executable: 'Google Chrome', family: 'chrome' },
  { bundleId: 'com.google.Chrome.beta', executable: 'Google Chrome Beta', family: 'chrome' },
  { bundleId: 'com.google.Chrome.dev', executable: 'Google Chrome Dev', family: 'chrome' },
  { bundleId: 'com.google.chrome.for.testing', executable: 'Google Chrome for Testing', family: 'chrome' },
  { bundleId: 'com.google.Chrome.canary', executable: 'Google Chrome Canary', family: 'chrome-canary' },
  { bundleId: 'com.microsoft.edgemac', executable: 'Microsoft Edge', family: 'edge' },
  { bundleId: 'com.microsoft.edgemac.Beta', executable: 'Microsoft Edge Beta', family: 'edge' },
  { bundleId: 'com.microsoft.edgemac.Dev', executable: 'Microsoft Edge Dev', family: 'edge' },
  { bundleId: 'com.microsoft.edgemac.Canary', executable: 'Microsoft Edge Canary', family: 'edge' },
  { bundleId: 'com.brave.Browser', executable: 'Brave Browser', family: 'brave' },
  { bundleId: 'com.brave.Browser.beta', executable: 'Brave Browser Beta', family: 'brave' },
  { bundleId: 'com.brave.Browser.nightly', executable: 'Brave Browser Nightly', family: 'brave' },
  { bundleId: 'org.chromium.Chromium', executable: 'Chromium', family: 'chromium' },
]);

/**
 * Ask Spotlight for Chromium bundles installed outside /Applications and ~/Applications.
 * @returns {Promise<BrowserCandidate[]>}
 */
export async function spotlightBrowserCandidates() {
  const query = MAC_BROWSER_BUNDLES.map((b) => `kMDItemCFBundleIdentifier == "${b.bundleId}"`).join(' || ');
  /** @type {string} */
  let stdout;
  try {
    ({ stdout } = await execFileAsync('mdfind', [query], { timeout: 3_000, maxBuffer: 256 * 1024 }));
  } catch {
    return [];
  }
  const appPaths = stdout.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.app'));
  /** @type {BrowserCandidate[]} */
  const out = [];
  // mdfind returns bundles in no useful order; keep MAC_BROWSER_BUNDLES preference.
  for (const bundle of MAC_BROWSER_BUNDLES) {
    for (const appPath of appPaths) {
      out.push({
        executablePath: path.join(appPath, 'Contents', 'MacOS', bundle.executable),
        family: bundle.family,
      });
    }
  }
  return out;
}

/**
 * @param {string} platform
 * @param {Record<string, string | undefined>} env
 * @returns {BrowserCandidate[]}
 */
export function browserCandidates(platform, env = {}) {
  /** @type {BrowserCandidate[]} */
  const out = [];
  /**
   * @param {string | undefined} base
   * @param {string[]} parts
   * @param {BrowserFamily} family
   */
  const push = (base, parts, family) => {
    if (!base) return;
    out.push({ executablePath: path.join(base, ...parts), family });
  };

  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES ?? env.ProgramFiles;
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'];
    const localAppData = env.LOCALAPPDATA;
    for (const base of [programFiles, programFilesX86, localAppData]) {
      push(base, ['Google', 'Chrome', 'Application', 'chrome.exe'], 'chrome');
    }
    push(localAppData, ['Google', 'Chrome SxS', 'Application', 'chrome.exe'], 'chrome-canary');
    for (const base of [programFilesX86, programFiles, localAppData]) {
      push(base, ['Microsoft', 'Edge', 'Application', 'msedge.exe'], 'edge');
    }
    for (const base of [programFiles, programFilesX86, localAppData]) {
      push(base, ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'], 'brave');
    }
    for (const base of [programFiles, programFilesX86, localAppData]) {
      push(base, ['Chromium', 'Application', 'chrome.exe'], 'chromium');
    }
    return out;
  }

  if (platform === 'darwin') {
    const apps = '/Applications';
    const userApps = env.HOME ? path.join(env.HOME, 'Applications') : undefined;
    for (const { executable, family } of MAC_BROWSER_BUNDLES) {
      for (const base of [apps, userApps]) {
        push(base, [`${executable}.app`, 'Contents', 'MacOS', executable], family);
      }
    }
    return out;
  }

  const linux = /** @type {[string, BrowserFamily][]} */ ([
    ['/usr/bin/google-chrome', 'chrome'],
    ['/usr/bin/google-chrome-stable', 'chrome'],
    ['/opt/google/chrome/chrome', 'chrome'],
    ['/usr/bin/microsoft-edge', 'edge'],
    ['/usr/bin/microsoft-edge-stable', 'edge'],
    ['/usr/bin/brave-browser', 'brave'],
    ['/usr/bin/chromium', 'chromium'],
    ['/usr/bin/chromium-browser', 'chromium'],
    ['/snap/bin/chromium', 'chromium'],
  ]);
  for (const [executablePath, family] of linux) out.push({ executablePath, family });
  return out;
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isExecutableFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} executablePath
 * @returns {BrowserFamily}
 */
export function familyFromPath(executablePath) {
  const base = path.basename(executablePath).toLowerCase();
  const full = executablePath.toLowerCase();
  if (base.includes('msedge') || full.includes('edge')) return 'edge';
  if (base.includes('brave') || full.includes('brave')) return 'brave';
  if (full.includes('canary') || full.includes('chrome sxs')) return 'chrome-canary';
  if (full.includes('chromium')) return 'chromium';
  return 'chrome';
}

/**
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.executablePath]
 * @param {() => Promise<BrowserCandidate[]>} [opts.spotlight] macOS Spotlight lookup (tests inject one)
 * @returns {Promise<BrowserCapability>}
 */
export async function discoverBrowser(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  const explicit = String(opts.executablePath ?? env[BROWSER_PATH_ENV] ?? '').trim();
  if (explicit) {
    if (await isExecutableFile(explicit)) {
      return {
        available: true,
        executablePath: explicit,
        family: familyFromPath(explicit),
        source: 'env',
      };
    }
    return {
      available: false,
      reason: 'env-path-missing',
      detail: `${opts.executablePath ? 'executablePath' : BROWSER_PATH_ENV} points at "${explicit}", which is not a file`,
      searched: [explicit],
    };
  }

  /** @type {string[]} */
  const searched = [];
  /** @param {BrowserCandidate[]} candidates */
  const firstExisting = async (candidates) => {
    for (const candidate of candidates) {
      searched.push(candidate.executablePath);
      if (await isExecutableFile(candidate.executablePath)) {
        return /** @type {BrowserCapabilityAvailable} */ ({
          available: true,
          executablePath: candidate.executablePath,
          family: candidate.family,
          source: 'probe',
        });
      }
    }
    return null;
  };

  const found = await firstExisting(browserCandidates(platform, env));
  if (found) return found;

  const spotlight = opts.spotlight ?? (platform === 'darwin' && process.platform === 'darwin' ? spotlightBrowserCandidates : null);
  if (spotlight) {
    const located = await firstExisting(await spotlight());
    if (located) return located;
  }

  return {
    available: false,
    reason: 'no-chromium-browser',
    detail:
      'No Chrome, Edge, Brave, or Chromium executable was found. ' +
      `Install one, or set ${BROWSER_PATH_ENV} to an executable.`,
    searched,
  };
}

/**
 * @param {object} [opts]
 * @returns {Promise<BrowserCapability>}
 */
export async function probeBrowserCapability(opts = {}) {
  let enabled = true;
  try {
    const cfg = await loadBrowserConfig();
    enabled = cfg.enabled !== false;
  } catch {
    enabled = true;
  }
  if (!enabled) {
    return {
      available: false,
      reason: 'disabled-in-settings',
      detail: 'browser automation is disabled in settings (browser.enabled = false)',
      searched: [],
    };
  }
  return discoverBrowser(opts);
}
