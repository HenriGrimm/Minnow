import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { appRoot, safePath, serialize, atomicJson } from './store.js';
export const reefEvents = new EventEmitter();
reefEvents.setMaxListeners(100);
export async function readEvents(id) {
  try { return JSON.parse(await fs.readFile(await safePath(appRoot(id), 'events.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function recordEvent(id, data) {
  return serialize(`events:${id}`, async () => {
    const events = await readEvents(id);
    const event = { id: (events.at(-1)?.id ?? 0) + 1, time: Date.now(), ...data };
    events.push(event);
    await atomicJson(await safePath(appRoot(id), 'events.json'), events.slice(-500));
    reefEvents.emit(id, event);
    return event;
  });
}
