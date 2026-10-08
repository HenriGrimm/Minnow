const adapters = new Map();

export function registerImageAdapter(adapter) {
  if (!adapter?.id || typeof adapter.capabilities !== 'function' || typeof adapter.generate !== 'function') throw new Error('Invalid image adapter');
  if (adapters.has(adapter.id)) throw new Error(`Image adapter already registered: ${adapter.id}`);
  adapters.set(adapter.id, adapter);
}

export function getImageAdapter(id) {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error('Image adapter unavailable');
  return adapter;
}
