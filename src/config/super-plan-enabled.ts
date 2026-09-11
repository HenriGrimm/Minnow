/**
 * Super Plan kill switch.
 *
 * The surface is disabled for release: it is broken, and all planning happens
 * in Plan mode instead. The implementation is kept here (and on the
 * `super-plan` branch) rather than deleted, so flipping this back to `true`
 * plus restoring the `super-plan` Code section and its view-bar button is all
 * that is needed to bring it back.
 *
 * The other half of the switch is `normalizeModeId`, which collapses the
 * `super-plan` mode id to `plan` (src/chat/modes/types.ts).
 */
export const SUPER_PLAN_ENABLED = false;
