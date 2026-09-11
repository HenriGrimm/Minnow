import path from 'node:path';
import { getMinnowHome } from './home.js';

export const ALLOWED_CONFIG_FILES = new Set([
  'config.json',
  'tools.json',
  'search.json',
  'servers.json',
  'research.json',
  'skills.json',
  'system-prompt.json',
  'rules.json',
  'sub-agents.json',
  'bugs/state.json',
  'issues/state.json',
  'issues/taxonomy.json',
  'reviews/state.json',
  'onboarding.json',
  'appearance.json',
  'default-model.json',
]);

/**
 * @param {string} resource
 * @returns {string | null}
 */
export function resourceToRelativeKey(resource) {
  switch (resource) {
    case 'meta':
      return 'config.json';
    case 'sessions':
      return 'sessions/state.json';
    case 'tools':
      return 'tools.json';
    case 'search':
      return 'search.json';
    case 'servers':
      return 'servers.json';
    case 'research':
      return 'research.json';
    case 'skills':
      return 'skills.json';
    case 'system-prompt':
      return 'system-prompt.json';
    case 'rules':
      return 'rules.json';
    case 'sub-agents':
      return 'sub-agents.json';
    case 'bugs':
      return 'bugs/state.json';
    case 'issues':
      return 'issues/state.json';
    case 'issues-taxonomy':
      return 'issues/taxonomy.json';
    case 'reviews':
      return 'reviews/state.json';
    case 'appearance':
      return 'appearance.json';
    default:
      return null;
  }
}

export const ISSUES_BACKUP_DIRNAME = 'issues/backups';

/**
 * @param {number} fromVersion
 * @param {number} stamp
 * @returns {string}
 */
export function issuesBackupPath(fromVersion, stamp) {
  const version = Number.isFinite(fromVersion) ? Math.trunc(Math.abs(fromVersion)) : 0;
  const at = Number.isFinite(stamp) ? Math.trunc(Math.abs(stamp)) : 0;
  const home = path.resolve(getMinnowHome());
  const full = path.resolve(home, ISSUES_BACKUP_DIRNAME, `state.v${version}.${at}.json`);
  const homeWithSep = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (!full.startsWith(homeWithSep)) {
    throw new Error('Invalid config path');
  }
  return full;
}

export function issuesBackupDir() {
  return path.resolve(path.resolve(getMinnowHome()), ISSUES_BACKUP_DIRNAME);
}

export const ISSUES_ATTACHMENTS_DIRNAME = 'issues/attachments';

/**
 * @param {unknown} raw
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeAttachmentSegment(raw, fallback = 'file') {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 96);
  return cleaned || fallback;
}

/**
 * @param {string} issueId
 * @param {string} fileName
 * @returns {string}
 */
export function issuesAttachmentPath(issueId, fileName) {
  const issueSegment = sanitizeAttachmentSegment(issueId, 'issue');
  const nameSegment = sanitizeAttachmentSegment(fileName, 'file');
  const home = path.resolve(getMinnowHome());
  const full = path.resolve(home, ISSUES_ATTACHMENTS_DIRNAME, issueSegment, nameSegment);
  const homeWithSep = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  if (!full.startsWith(homeWithSep)) {
    throw new Error('Invalid attachment path');
  }
  return full;
}

/**
 * @param {string} relativeKey
 * @returns {string}
 */
export function resolveIssueAttachmentPath(relativeKey) {
  if (typeof relativeKey !== 'string' || !relativeKey.trim()) {
    throw new Error('Invalid attachment path');
  }
  const parts = relativeKey.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('Invalid attachment path');
  return issuesAttachmentPath(parts[0], parts[1]);
}

/**
 * @param {string} relativeKey
 * @returns {string}
 */
export function resolveConfigPath(relativeKey) {
  if (!relativeKey || typeof relativeKey !== 'string') {
    throw new Error('Invalid config path');
  }

  if (relativeKey.includes('\0')) {
    throw new Error('Invalid config path');
  }

  if (path.isAbsolute(relativeKey)) {
    throw new Error('Invalid config path');
  }

  const normalized = relativeKey.replace(/\\/g, '/').replace(/^\/+/, '');

  if (!normalized || normalized.includes('..')) {
    throw new Error('Invalid config path');
  }

  if (!ALLOWED_CONFIG_FILES.has(normalized)) {
    throw new Error('Invalid config path');
  }

  const home = path.resolve(getMinnowHome());
  const full = path.resolve(home, normalized);
  const homeWithSep = home.endsWith(path.sep) ? home : `${home}${path.sep}`;

  if (full !== home && !full.startsWith(homeWithSep)) {
    throw new Error('Invalid config path');
  }

  return full;
}
