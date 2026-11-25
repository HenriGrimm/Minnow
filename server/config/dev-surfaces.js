/**
 * Gates for maintainer / QA surfaces that should not ship in default user sessions.
 */

function isTruthyEnv(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
}
