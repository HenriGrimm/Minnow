/**
 * Client gates for maintainer / QA settings surfaces.
 */

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
}

/** True when Vite/`MINNOW_DEBUG` is set — maintainer surfaces and P6-A spike. */
export function isMinnowDebugEnabled(): boolean {
  const env =
    typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : undefined;
  return isTruthyFlag(env?.MINNOW_DEBUG);
}
