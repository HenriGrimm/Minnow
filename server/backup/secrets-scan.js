/**
 * Recognise and strip secret material in JSON config files.
 *
 * Two kinds of secret live in the Minnow home. Secret-box envelopes are
 * encrypted under `.key`: useless without it, so they travel only with it.
 * A few fields — search API keys, MCP server `env` values and request headers —
 * are stored as plain strings and must be blanked in any backup that leaves the
 * credentials category out.
 *
 * Pure functions only: `restore-apply.js` loads this before the stores exist.
 */

/** Largest JSON file worth parsing to look for secrets. */
export const MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024;

/** Key names whose string values are secrets. */
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|passphrase|credential|authorization)s?$/i;

/** Object keys whose every string value is a secret (MCP `env`, HTTP `headers`). */
const SECRET_BAG_KEYS = new Set(['env', 'headers']);

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Same shape test as `isEncryptedSecretPayload` in `security/secret-box.js`.
 * @param {unknown} value
 */
function isSecretEnvelope(value) {
  return (
    isPlainObject(value) &&
    /** @type {Record<string, unknown>} */ (value).encrypted === true &&
    typeof (/** @type {Record<string, unknown>} */ (value).ciphertext) === 'string'
  );
}

/**
 * True when the value is, or contains anywhere, a secret-box envelope.
 * @param {unknown} value
 * @returns {boolean}
 */
export function containsSecretEnvelope(value) {
  if (Array.isArray(value)) return value.some(containsSecretEnvelope);
  if (!isPlainObject(value)) return false;
  if (isSecretEnvelope(value)) return true;
  return Object.values(/** @type {Record<string, unknown>} */ (value)).some(containsSecretEnvelope);
}

/**
 * Parse JSON text and report whether it carries a secret-box envelope.
 * Unparseable text is treated as carrying none.
 * @param {string} text
 */
export function jsonTextHasSecretEnvelope(text) {
  try {
    return containsSecretEnvelope(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Blank plaintext secrets in place.
 * @param {unknown} value
 * @param {string[]} trail
 * @param {string[][]} hits
 * @param {boolean} inBag
 */
function redactInto(value, trail, hits, inBag) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => redactInto(item, [...trail, String(index)], hits, inBag));
    return;
  }
  if (!isPlainObject(value)) return;
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const [key, child] of Object.entries(record)) {
    const path = [...trail, key];
    const secretKey = inBag || SECRET_KEY_PATTERN.test(key);
    if (typeof child === 'string') {
      if (child && secretKey) {
        record[key] = '';
        hits.push(path);
      }
      continue;
    }
    // `apiKeys: ['a', 'b']` is as secret as `apiKey: 'a'`.
    if (secretKey && Array.isArray(child)) {
      child.forEach((item, index) => {
        if (typeof item === 'string' && item) {
          child[index] = '';
          hits.push([...path, String(index)]);
        }
      });
    }
    redactInto(child, path, hits, inBag || SECRET_BAG_KEYS.has(key));
  }
}

/**
 * Return a copy of `value` with plaintext secrets blanked, plus where they were.
 * Paths are arrays of keys so a key containing a dot stays unambiguous.
 * @param {unknown} value
 * @returns {{ value: unknown, paths: string[][] }}
 */
export function redactPlaintextSecrets(value) {
  const copy = structuredClone(value);
  /** @type {string[][]} */
  const paths = [];
  redactInto(copy, [], paths, false);
  return { value: copy, paths };
}

/**
 * @param {unknown} root
 * @param {string[]} path
 */
function readPath(root, path) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = /** @type {Record<string, unknown>} */ (node)[key];
  }
  return node;
}

/**
 * Fill fields that a backup blanked from the file it is replacing, so restoring
 * a backup without credentials does not erase keys already on this machine.
 * Only blank fields are filled; a value the backup carries always wins.
 * @param {unknown} restored
 * @param {unknown} existing
 * @param {string[][]} paths
 * @returns {{ value: unknown, filled: number }}
 */
export function refillRedactedSecrets(restored, existing, paths) {
  const copy = structuredClone(restored);
  let filled = 0;
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0) continue;
    const previous = readPath(existing, path);
    if (typeof previous !== 'string' || !previous) continue;
    const parent = readPath(copy, path.slice(0, -1));
    if (parent === null || typeof parent !== 'object') continue;
    const key = path[path.length - 1];
    if (/** @type {Record<string, unknown>} */ (parent)[key] !== '') continue;
    /** @type {Record<string, unknown>} */ (parent)[key] = previous;
    filled += 1;
  }
  return { value: copy, filled };
}
