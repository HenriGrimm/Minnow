/** Backfill the new patch tool only for existing editing setups; never override a saved choice. */
export function backfillPatchPermission(config, stored) {
  const permissions = stored?.permissions?.default ?? stored?.permissions;
  if (Object.hasOwn(stored?.enabled ?? {}, 'apply_patch') || Object.hasOwn(permissions ?? {}, 'apply_patch')) return;
  if (['save_file', 'replace_text_in_file'].some(id => ['ask', 'full'].includes(config.permissions.default[id]))) {
    // Multi-file patches can move/delete, so do not inherit unrestricted edit permission.
    config.permissions.default.apply_patch = 'ask';
    config.enabled.apply_patch = true;
  }
}
