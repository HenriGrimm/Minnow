import { AGENTS_NAMESPACE, derive } from './derive.js';
import { validateEvent } from './events.js';
import { createJournalStore } from '../orchestrator/journal-store.js';

const agents = createJournalStore({
  namespace: AGENTS_NAMESPACE,
  idKind: 'parentChat',
  fold: derive,
  validate: validateEvent,
});

export { AGENTS_NAMESPACE };

/** @param {string} parentChatId */
export function agentsDir(parentChatId) {
  return agents.entryDir(parentChatId);
}

/** @param {string} parentChatId */
export function journalPath(parentChatId) {
  return agents.journalPath(parentChatId);
}

export const readEvents = agents.readEvents;
export const readHighestSeq = agents.readHighestSeq;
export const appendEvent = agents.appendEvent;
export const appendEvents = agents.appendEvents;
export const loadState = agents.loadState;
export const createEntry = agents.createEntry;
export const entryExists = agents.entryExists;
export const deleteEntry = agents.deleteEntry;
export const listEntries = agents.listEntries;
export const resetJournalCache = agents.resetCache;
export const restoreEvents = agents.restoreEvents;
