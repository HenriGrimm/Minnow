// Run: node --import tsx documentation/reviews/2026-10-23/evidence/services-identity-and-tts.mts
// Pure namespace helpers and a fake WebSocket; no network, profile, or audio use.
import assert from 'node:assert/strict';
import { validateMcpServerId } from '../../../../server/mcp/validate.js';
import { toNamespacedName, parseNamespacedName, toOpenAIDefinitions } from '../../../../server/mcp/bridge.js';
import { TtsStreamClient } from '../../../../src/voice/tts-stream-client.ts';
const id = validateMcpServerId('team__docs');
const name = toNamespacedName(id, 'lookup');
const parsed = parseNamespacedName(name)!;
assert.equal(parsed.serverId, 'team');
const collision = toOpenAIDefinitions('docs', [{ name: 'find-record' }, { name: 'find_record' }]);
assert.equal(collision[0].function.name, collision[1].function.name);
Object.assign(globalThis, { window: { location: { protocol: 'http:', host: 'localhost' } } });
class Socket {
  static OPEN = 1; readyState = 1; onclose?: () => void;
  send() {} close() { this.onclose?.(); }
}
Object.assign(globalThis, { WebSocket: Socket });
let settled = false;
const client = new TtsStreamClient();
void client.start('Synthetic speech').then(() => { settled = true; }, () => { settled = true; });
client.cancel();
await Promise.resolve(); await Promise.resolve();
assert.equal(settled, false);
console.log(JSON.stringify({ acceptedServerId: id, emittedName: name, parsedServerId: parsed.serverId,
  collidingFunctionNames: collision.map(tool => tool.function.name), cancelledTtsStartSettled: settled }));
