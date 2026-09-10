#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signingEnvPath = path.join(repoRoot, '.env.signing');
const csrDir = path.join(repoRoot, 'build', 'macos-signing');

/** @typedef {{ name: string; hash: string }} SigningIdentity */

const DEVELOPER_ID_APPLICATION_PREFIX = /^Developer ID Application:\s*/i;

/**
 * @param {string} name
 */
export function normalizeIdentityForSigning(name) {
  return name.trim().replace(DEVELOPER_ID_APPLICATION_PREFIX, '');
}

/**
 * @param {string} filePath
 */
export function loadSigningEnvFile(filePath = signingEnvPath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** @returns {SigningIdentity[]} */
export function listDeveloperIdIdentities() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
/** @type {SigningIdentity[]} */
  const identities = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]+)\s+"(Developer ID Application:[^"]+)"/i);
    if (match) identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

export function hasDeveloperIdIdentity() {
  return listDeveloperIdIdentities().length > 0;
}

export function hasNotarizationCredentials() {
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  if (!teamId) return false;

  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim();
  const appleId = process.env.APPLE_ID?.trim();
  if (appleId && appPassword) return true;

  const apiKey = process.env.APPLE_API_KEY?.trim();
  const apiKeyId = process.env.APPLE_API_KEY_ID?.trim();
  const apiIssuer = process.env.APPLE_API_KEY_ISSUER?.trim();
  return Boolean(apiKey && apiKeyId && apiIssuer);
}

/**
 * @returns {string[]}
 */
export function electronBuilderSigningArgs() {
  if (process.platform !== 'darwin') return [];

  loadSigningEnvFile();

  if (process.env.MINNOW_SKIP_SIGNING === '1') {
    console.warn('[signing] MINNOW_SKIP_SIGNING=1 — building an unsigned macOS package.');
    return ['--config.mac.identity=null', '--config.mac.notarize=false'];
  }

  const identities = listDeveloperIdIdentities();
  const hasCiCertificate = Boolean(process.env.CSC_LINK?.trim());
  if (identities.length === 0 && !hasCiCertificate) {
    console.warn(
      '[signing] No Developer ID Application certificate in the login keychain.',
    );
    console.warn('[signing] Run: npm run signing:setup');
    console.warn('[signing] Building unsigned (Gatekeeper will block on first open).');
    return ['--config.mac.identity=null', '--config.mac.notarize=false'];
  }

  const rawIdentity = process.env.CSC_NAME?.trim() || identities[0]?.name;
  const args = [];
  if (rawIdentity) {
    const identity = normalizeIdentityForSigning(rawIdentity);
    console.log(`[signing] Using identity: ${identity}`);
    args.push(`--config.mac.identity=${identity}`);
  } else {
    console.log('[signing] Using the Developer ID certificate supplied by CSC_LINK.');
  }

  if (process.env.MINNOW_SKIP_NOTARIZATION === '1') {
    console.warn(
      '[signing] MINNOW_SKIP_NOTARIZATION=1 — signed build without Apple notarization (Gatekeeper may still block).',
    );
    args.push('--config.mac.notarize=false');
  } else if (hasNotarizationCredentials()) {
    const teamId = process.env.APPLE_TEAM_ID?.trim();
    console.log(
      `[signing] Notarization enabled (team ${teamId}) via afterSign hook (retries + direct S3 fallback).`,
    );
    args.push('--config.mac.notarize=false');
  } else {
    console.warn(
      '[signing] Signed build, but notarization credentials missing — app may still be quarantined.',
    );
    console.warn('[signing] Copy .env.signing.example → .env.signing and fill Apple credentials.');
    args.push('--config.mac.notarize=false');
  }

  return args;
}

export { repoRoot, signingEnvPath, csrDir };
