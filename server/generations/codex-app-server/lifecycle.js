// Lightweight hooks keep persistence/provider modules independent of subprocess code.
let dispose = async () => {};
export function registerCodexDisposal(callback) { dispose = callback; }
export function disposeCodexSessions(filter) { return dispose(filter); }
