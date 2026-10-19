/**
 * Which listener accepted a request. Remote traffic arrives on dedicated
 * listeners (home network, tailnet), so "is this the host?" is answered by the
 * accepting listener — never by the peer address. The tailnet sidecar proxies
 * from 127.0.0.1, so a peer-address test would mistake the internet for the host.
 */

import http from 'node:http';
import net from 'node:net';

/** @typedef {'loopback' | 'lan' | 'tailnet' | 'funnel'} IngressKind */

export const INGRESS_KINDS = /** @type {const} */ (['loopback', 'lan', 'tailnet', 'funnel']);

/** @type {WeakMap<import('node:net').Socket, IngressKind>} */
const socketIngress = new WeakMap();
/** @type {WeakMap<object, IngressKind>} */
const requestIngress = new WeakMap();

/**
 * Tag every socket a server accepts with its ingress kind.
 * @param {import('node:http').Server | import('node:net').Server} server
 * @param {IngressKind} kind
 */
export function tagServerIngress(server, kind) {
  server.on('connection', (socket) => {
    socketIngress.set(socket, kind);
  });
  return server;
}

/**
 * Override the socket's ingress for one request (the trusted tailnet listener
 * learns `funnel` vs `tailnet` from its authenticated sidecar header).
 * @param {object} req
 * @param {IngressKind} kind
 */
export function setRequestIngress(req, kind) {
  requestIngress.set(req, kind);
}

function isLoopbackPeer(address) {
  if (net.isIP(address) === 4) return address === '127.0.0.1';
  if (net.isIP(address) !== 6) return false;
  return address === '::1' || address.toLowerCase() === '::ffff:127.0.0.1';
}

/**
 * Resolve a request's ingress. Untagged sockets (unit-test doubles, a listener
 * created outside this module) fall back to the legacy peer-address reading so
 * they are never more privileged than before: loopback peers are `loopback`,
 * everything else is `lan`.
 * @param {{ socket?: { remoteAddress?: string } } & object} req
 * @returns {IngressKind}
 */
export function getRequestIngress(req) {
  const fromRequest = requestIngress.get(req);
  if (fromRequest) return fromRequest;
  const socket = /** @type {import('node:net').Socket | undefined} */ (req.socket);
  const fromSocket = socket ? socketIngress.get(socket) : undefined;
  if (fromSocket) return fromSocket;
  // Socket-less doubles in unit tests stand in for the desktop listener.
  if (!socket?.remoteAddress) return 'loopback';
  return isLoopbackPeer(socket.remoteAddress) ? 'loopback' : 'lan';
}

/** @type {WeakMap<object, Record<string, string>>} */
const relayHeaders = new WeakMap();

/**
 * Headers a server-side loop back into the same listener must carry (the
 * tailnet listener's shared secret). Set by the trusted listener only.
 * @param {object} req
 * @param {Record<string, string>} headers
 */
export function setRequestRelayHeaders(req, headers) {
  relayHeaders.set(req, headers);
}

/** @param {object} req */
export function getRequestRelayHeaders(req) {
  return relayHeaders.get(req) ?? {};
}

/** @type {WeakMap<object, string>} */
const clientAddresses = new WeakMap();

/**
 * Record the real client address of a proxied request (from the sidecar's
 * X-Forwarded-For, trusted only after its secret is verified).
 * @param {object} req
 * @param {string} address
 */
export function setRequestClientAddress(req, address) {
  clientAddresses.set(req, address);
}

/**
 * The address to throttle by: the proxied client when known, else the peer.
 * @param {{ socket?: { remoteAddress?: string } } & object} req
 */
export function getRequestClientAddress(req) {
  return clientAddresses.get(req) ?? req.socket?.remoteAddress ?? 'unknown';
}

/** @param {IngressKind} kind */
export function isRemoteIngress(kind) {
  return kind !== 'loopback';
}

/** Scheme the browser used to reach this ingress (tailnet traffic is TLS-terminated by the sidecar). */
export function ingressScheme(kind) {
  return kind === 'tailnet' || kind === 'funnel' ? 'https' : 'http';
}

/**
 * @param {IngressKind} kind
 * @param {import('node:http').RequestListener} [handler]
 */
export function createIngressServer(kind, handler) {
  const server = http.createServer(handler);
  tagServerIngress(server, kind);
  return server;
}
