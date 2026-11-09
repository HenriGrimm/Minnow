
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildElectronMain } from './build-electron.mjs';
import { isElectronBuildFresh } from './spawn-electron.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ELECTRON_INSTALL_JS = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'install.js');

/**
 * @returns {boolean}
 */
function shouldSkip() {
  return process.env.MINNOW_SKIP_ELECTRON === '1' || process.env.MINNOW_HEADLESS === '1';
}

/**
 * @param {string} message
 */
function warn(message) {
  console.warn(`[ensure-electron] ${message}`);
}

/**
 * @param {string} message
 */
function log(message) {
  console.log(`[ensure-electron] ${message}`);
}

function installerEnv(attempt) {
  if (attempt === 1 || process.env.npm_config_platform || process.env.npm_config_arch) return process.env;
  if (Object.keys(process.env).some(key => /electron_/i.test(key))) return process.env;
  if (attempt === 3) {
    // The mirror only supplies bytes. The installer still checks the package's bundled hashes.
    return { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' };
  }
  // Let Electron detect Rosetta itself when a macOS x64 Node may be translated.
  if (process.platform === 'darwin' && process.arch === 'x64') return process.env;
  const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(ELECTRON_INSTALL_JS), 'package.json'), 'utf8'));
  // Retry through the same release asset with a fresh redirect. The installer
  // still validates the archive against the checksums bundled with the package.
  const asset = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  return { ...process.env, ELECTRON_CUSTOM_FILENAME: `${asset}?minnow-retry=${randomUUID()}` };
}

async function main() {
  if (shouldSkip()) {
    log('Skipping Electron binary download (MINNOW_SKIP_ELECTRON or MINNOW_HEADLESS is set).');
    return;
  }

  if (!fs.existsSync(ELECTRON_INSTALL_JS)) {
    warn(
      'Electron package not found. The default `npm start` desktop shell requires it. Run: npm install',
    );
    return;
  }

  log('Ensuring Electron binary is downloaded…');
  const attempts = process.env.GITHUB_ACTIONS === 'true' ? 3 : 1;
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawnSync(process.execPath, [ELECTRON_INSTALL_JS], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: installerEnv(attempt),
    });
    if (result.status === 0 || attempt === attempts) break;
    warn(`Electron download attempt ${attempt}/${attempts} failed. Retrying…`);
    await delay(attempt * 5_000);
  }

  if (result.status !== 0) {
    warn(`Electron binary download failed (exit ${result.status ?? 'unknown'}).`);
    warn('Retry with: npm install electron');
    process.exit(result.status ?? 1);
  }

  if (process.platform === 'win32') {
    const syncIcon = spawnSync(process.execPath, [path.join(__dirname, 'sync-app-icon.mjs')], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    if (syncIcon.status !== 0) {
      warn('App icon sync failed; Windows taskbar may show the default Electron icon.');
    }

    const brand = spawnSync(process.execPath, [path.join(__dirname, 'brand-electron-win.mjs')], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    if (brand.status !== 0) {
      warn('Electron taskbar branding failed; dev runs may show the default Electron icon.');
    }
  }

  log('Electron binary ready.');

  if (!isElectronBuildFresh()) {
    log('Pre-compiling Electron main process for faster first launch…');
    try {
      buildElectronMain();
      log('Electron main process compiled.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`Electron compile failed (${message}). First launch will compile on demand.`);
    }
  }
}

await main();
