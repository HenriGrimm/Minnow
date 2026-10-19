/**
 * Attach every Minnow WebSocket endpoint to a listener. The desktop server, the
 * home-network listener, and the trusted tailnet listener all serve the same
 * sockets; each upgrade is authorized against the ingress that received it.
 */

import { attachPtyWebSocketServer } from '../terminal/pty-ws.js';
import { attachSttWebSocketServer } from '../stt/stt-ws.js';
import { attachTtsWebSocketServer } from '../tts/tts-ws.js';
import { attachAgentsWebSocketServer } from '../sub-agents/ws.js';
import { attachStreamWebSocketServer } from './stream-ws.js';

/**
 * @param {import('node:events').EventEmitter} server An http.Server, or any
 *   emitter that re-emits `upgrade` (and `close`) after its own checks.
 */
export function attachMinnowWebSockets(server) {
  attachPtyWebSocketServer(server);
  attachSttWebSocketServer(server);
  attachTtsWebSocketServer(server);
  attachAgentsWebSocketServer(server);
  attachStreamWebSocketServer(server);
}
