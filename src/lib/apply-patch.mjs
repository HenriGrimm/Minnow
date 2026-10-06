// Compatibility entry point for browser and server consumers. The shared
// runner owns this pure implementation so its runtime closure stays standalone.
export { parsePatch, patchText } from '../../server/runner/apply-patch.js';
