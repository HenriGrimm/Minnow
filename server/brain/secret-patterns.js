/**
 * Credential-shaped text that must never be written to Brain pages or memories.
 */

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{10,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/i,
  /\bapi[_-]?key\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bghp_[a-zA-Z0-9]{20,}\b/,
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecretPatterns(text) {
  const value = String(text ?? '');
  return SECRET_PATTERNS.some((re) => re.test(value));
}
