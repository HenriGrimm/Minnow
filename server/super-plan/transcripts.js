import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { runDir } from './journal.js';

/** Append-only runner transcript checkpoints survive a tool-server restart. */
export function createStageTranscriptStore(runId, role) {
  const dir = path.join(runDir(runId), 'transcripts');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${role}.jsonl`);
  let record = { messages: [], meta: {} };
  try {
    const contents = readFileSync(file, 'utf8');
    // Separate a torn final record from the next valid append.
    if (contents && !contents.endsWith('\n')) appendFileSync(file, '\n');
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'reset') record = { messages: [], meta: {} };
        if (event.type === 'message') record.messages.push(event.message);
        if (event.type === 'meta') Object.assign(record.meta, event.meta);
      } catch { /* Ignore an interrupted trailing append. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = (event) => appendFileSync(file, `${JSON.stringify(event)}\n`);
  return {
    load: () => ({ messages: [...record.messages], meta: { ...record.meta } }),
    append(_chatId, message) { persist({ type: 'message', message }); record.messages.push(message); },
    setMeta(_chatId, meta) { persist({ type: 'meta', meta }); Object.assign(record.meta, meta); },
    reset() { persist({ type: 'reset' }); record = { messages: [], meta: {} }; },
  };
}
