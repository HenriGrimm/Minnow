#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasNotarizationCredentials,
  loadSigningEnvFile,
} from './macos-signing-env.mjs';

export const TRANSIENT_NOTARIZE_UPLOAD_RE =
  /abortedUpload|deadlineExceeded|connection reset|connectionReset|timed out|Connection refused|networkConnectionLost/i;

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_WAIT_TIMEOUT = '3h';

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * @returns {string[]}
 */
export function notarytoolAuthorizationArgs() {
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const appleId = process.env.APPLE_ID?.trim();
  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim();
  if (appleId && appPassword) {
    if (!teamId) {
      throw new Error('APPLE_TEAM_ID is required when using APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD');
    }
    return ['--apple-id', appleId, '--password', appPassword, '--team-id', teamId];
  }

  const apiKey = process.env.APPLE_API_KEY?.trim();
  const apiKeyId = process.env.APPLE_API_KEY_ID?.trim();
  const apiIssuer = process.env.APPLE_API_KEY_ISSUER?.trim();
  if (apiKey && apiKeyId && apiIssuer) {
    return ['--key', apiKey, '--key-id', apiKeyId, '--issuer', apiIssuer];
  }

  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (keychainProfile) {
    const keychain = process.env.APPLE_KEYCHAIN?.trim();
    if (keychain) {
      return ['--keychain', keychain, '--keychain-profile', keychainProfile];
    }
    return ['--keychain-profile', keychainProfile];
  }

  throw new Error(
    'Notarization credentials missing. Set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or API key env vars, in .env.signing',
  );
}

/**
 * @param {string} output
 */
export function isTransientNotarizeUploadError(output) {
  return TRANSIENT_NOTARIZE_UPLOAD_RE.test(output);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ code: number; output: string }>}
 */
function runStreaming(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { code: result.status ?? 1, output };
}

// ── Zip app ──────────────────────────────────────────────────────────────────

/**
 * @param {string} appPath Absolute path to Foo.app
 * @returns {string} Path to zip inside a temp directory (caller should delete parent when done)
 */
export function zipAppForNotarization(appPath) {
  const appDir = path.dirname(appPath);
  const appBase = path.basename(appPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-notarize-'));
  const zipPath = path.join(tmpDir, `${path.parse(appBase).name}.zip`);

  const zipResult = run(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', appBase, zipPath],
    { cwd: appDir },
  );
  if (zipResult.code !== 0) {
    throw new Error(`Failed to zip application for notarization:\n${zipResult.output}`);
  }
  return zipPath;
}

/**
 * @param {string} appPath
 */
function verifySignedApp(appPath) {
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (verify.code !== 0) {
    throw new Error(`App is not signed correctly; refusing to notarize:\n${verify.output}`);
  }
}

/**
 * @param {string} appPath
 */
function stapleApp(appPath) {
  const appDir = path.dirname(appPath);
  const appBase = path.basename(appPath);
  const staple = run('xcrun', ['stapler', 'staple', '-v', appBase], { cwd: appDir });
  if (staple.code !== 0) {
    throw new Error(`Failed to staple notarization ticket:\n${staple.output}`);
  }
}

// ── Submit ───────────────────────────────────────────────────────────────────

/**
 * @param {string} zipPath
 * @param {{ useS3Acceleration: boolean; waitTimeout: string; verbose: boolean }} options
 * @returns {Promise<{ ok: boolean; output: string; parsed: null }>}
 */
export async function submitNotarizationZip(zipPath, options) {
  const authArgs = notarytoolAuthorizationArgs();
  const submitArgs = [
    'notarytool',
    'submit',
    zipPath,
    ...authArgs,
    '--wait',
    '--timeout',
    options.waitTimeout,
  ];
  if (!options.useS3Acceleration) {
    submitArgs.push('--no-s3-acceleration');
  }
  if (options.verbose) {
    submitArgs.push('--verbose');
  }

  const result = await runStreaming('xcrun', submitArgs);
  const accepted =
    result.code === 0 ||
    /status:\s*Accepted/i.test(result.output) ||
    /Accepted/i.test(result.output);
  return { ok: accepted, output: result.output, parsed: null };
}

// ── Notarize ─────────────────────────────────────────────────────────────────

/**
 * @param {string} appPath Absolute path to the .app bundle
 * @param {{ maxAttempts?: number; waitTimeout?: string }} [opts]
 */
export async function notarizeMacApp(appPath, opts = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS notarization must run on darwin');
  }
  if (!fs.existsSync(appPath)) {
    throw new Error(`App not found: ${appPath}`);
  }

  loadSigningEnvFile();
  if (!hasNotarizationCredentials()) {
    throw new Error('Notarization credentials are not configured');
  }

  verifySignedApp(appPath);

  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const waitTimeout =
    opts.waitTimeout ??
    (process.env.MINNOW_NOTARIZE_WAIT_TIMEOUT?.trim() || DEFAULT_WAIT_TIMEOUT);
  const verbose = process.env.MINNOW_NOTARIZE_VERBOSE !== '0';

  const existingZip = process.env.MINNOW_NOTARIZE_ZIP?.trim();
  let zipPath;
  let zipDir;
  let removeZipDir = false;

  if (existingZip) {
    zipPath = path.resolve(existingZip);
    if (!fs.existsSync(zipPath)) {
      throw new Error(`MINNOW_NOTARIZE_ZIP not found: ${zipPath}`);
    }
    zipDir = path.dirname(zipPath);
    console.log(`[notarize] Using existing archive: ${zipPath}`);
  } else {
    console.log('[notarize] Zipping .app for upload (ditto — may take a few minutes for a ~1 GB bundle)…');
    zipPath = zipAppForNotarization(appPath);
    zipDir = path.dirname(zipPath);
    removeZipDir = true;
  }

  const zipStat = fs.statSync(zipPath);
  const zipMb = (zipStat.size / (1024 * 1024)).toFixed(1);
  const zipBytes = zipStat.size;
  const etaMinSlow = Math.ceil((zipBytes * 8) / (2 * 1_000_000) / 60);
  const etaMinFast = Math.ceil((zipBytes * 8) / (20 * 1_000_000) / 60);
  console.log(
    `[notarize] Upload size: ${zipMb} MB (expect ~${etaMinFast}–${etaMinSlow} min upload at 20–2 Mbps uplink, then Apple processing)`,
  );
  console.log('[notarize] You should see a notarytool progress bar below during upload.\n');

  try {
    let useS3Acceleration = process.env.MINNOW_NOTARIZE_S3_ACCELERATION === '1';
    let lastOutput = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1 && isTransientNotarizeUploadError(lastOutput)) {
        useS3Acceleration = false;
      }

      console.log(
        `[notarize] Submitting to Apple (attempt ${attempt}/${maxAttempts}${useS3Acceleration ? '' : ', direct S3 upload'})…`,
      );

      const result = await submitNotarizationZip(zipPath, {
        useS3Acceleration,
        waitTimeout,
        verbose,
      });
      lastOutput = result.output;

      if (result.ok) {
        console.log('[notarize] Accepted by Apple notary service');
        stapleApp(appPath);
        console.log('[notarize] Stapled ticket to app');
        return;
      }

      if (attempt < maxAttempts && isTransientNotarizeUploadError(lastOutput)) {
        const backoffSec = attempt * 15;
        console.warn(
          `[notarize] Upload/processing failed (transient). Retrying in ${backoffSec}s…`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffSec * 1000));
        continue;
      }

      throw new Error(`Notarization failed:\n\n${lastOutput}`);
    }
  } finally {
    if (removeZipDir) {
      fs.rmSync(zipDir, { recursive: true, force: true });
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('Usage: node scripts/macos-notarize-app.mjs <path-to-Your.app>');
    process.exit(1);
  }
  const resolved = path.resolve(appPath);
  await notarizeMacApp(resolved);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
