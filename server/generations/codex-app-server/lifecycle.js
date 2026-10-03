// Lightweight hooks keep persistence/provider modules independent of subprocess code.
import { registerCliDisposal, disposeCliSessions } from '../agent-cli/lifecycle.js';
export function registerCodexDisposal(callback) { registerCliDisposal('codex', callback); }
// Compatibility export; existing storage hooks now release every CLI adapter.
export const disposeCodexSessions = disposeCliSessions;
