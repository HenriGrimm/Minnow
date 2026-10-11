/**
 * Validators for Models download/serve inputs.
 */

const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVE_ID_RE = JOB_ID_RE;
import { ENGINE_IDS } from '../../src/models/engine-ids.mjs';
const RUNTIME_RE = new RegExp(`^(${ENGINE_IDS.join('|')})$`);

/**
 * @param {string} repoId
 */
export function validateRepoId(repoId) {
  if (!repoId || !REPO_ID_RE.test(repoId)) {
    throw new Error('Invalid repoId — expected org/name with safe characters');
  }
  return repoId;
}

/**
 * @param {string} filename
 */
export function validateGgufFilename(filename) {
  if (!filename || !FILENAME_RE.test(filename)) {
    throw new Error('Invalid filename — expected a .gguf file name');
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename path');
  }
  return filename;
}

/**
 * @param {string} id
 */
export function validateJobId(id) {
  if (!id || !JOB_ID_RE.test(id)) {
    throw new Error('Invalid job id');
  }
  return id;
}

/**
 * @param {string} id
 */
export function validateServeId(id) {
  if (!id || !SERVE_ID_RE.test(id)) {
    throw new Error('Invalid serve id');
  }
  return id;
}

/**
 * @param {string} runtime
 */
export function validateRuntime(runtime) {
  if (!runtime || !RUNTIME_RE.test(runtime)) {
    throw new Error(`Invalid runtime — expected ${ENGINE_IDS.join(', ')}`);
  }
  return runtime;
}

/**
 * @param {number} port
 */
export function validatePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error('Invalid port — expected 1024–65535');
  }
  return n;
}
