/**
 * Index for strict-mode shims of shared .mjs and server .js modules imported from TypeScript under src.
 *
 * With moduleResolution bundler, TypeScript pairs each .mjs import with a co-located .d.mts file
 * (it strips .mjs and loads name.d.mts, not name.d.ts). Ambient declare module paths do not attach
 * to those resolved JavaScript modules; use the companion files listed in the repo next to each .mjs.
 *
 * Companion files:
 * - src/lib/untrusted.d.mts
 * - src/attachments/document-extensions.d.mts
 * - src/state/session-schema.d.mts
 * - src/skills/library/registry.d.mts
 * - src/skills/impeccable/harness-registry.d.mts
 * - src/lib/resolve-model-api.d.mts
 * - src/lib/derive-messages-path.d.mts
 * - src/lib/anthropic-thinking-style.d.mts
 * - src/lib/fetch-web-content.d.mts
 * - src/product-wiki/nav-order.d.mts
 */

export type * from '../lib/untrusted.d.mts';
export type * from '../attachments/document-extensions.d.mts';
export type * from '../state/session-schema.d.mts';
export type * from '../skills/library/registry.d.mts';
export type * from '../skills/impeccable/harness-registry.d.mts';
export type * from '../lib/resolve-model-api.d.mts';
export type * from '../lib/derive-messages-path.d.mts';
export type * from '../lib/anthropic-thinking-style.d.mts';
export type * from '../lib/fetch-web-content.d.mts';
export type * from '../product-wiki/nav-order.d.mts';
