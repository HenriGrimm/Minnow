// Only currently active device transports are retained. HTTP keep-alive
// connections are shared across requests, so track the response, not its socket.
const active = new Map();

export function trackDeviceTransport(auth, transport) {
  if (auth.kind !== 'device' || typeof transport.once !== 'function') return;
  let connections = active.get(auth.deviceId);
  if (!connections) active.set(auth.deviceId, connections = new Map());
  connections.set(transport, auth.credentialId);
  const release = () => {
    transport.removeListener('close', release);
    transport.removeListener('finish', release);
    connections.delete(transport);
    if (!connections.size && active.get(auth.deviceId) === connections) active.delete(auth.deviceId);
  };
  transport.once('close', release);
  transport.once('finish', release);
}

export function closeDeviceTransports(deviceId, credentialId, exceptTransport) {
  const connections = active.get(deviceId);
  if (!connections) return;
  for (const [transport, id] of connections) {
    if (transport !== exceptTransport && (credentialId === undefined || credentialId === id)) transport.destroy();
  }
}
