import { projectSuperPlan } from './projection.js';
/** Super Plan run journal binding onto namespace `superplan`. */

import { derive } from './derive.js';
import { validateEvent } from './events.js';
import { createJournalStore } from '../orchestrator/journal-store.js';

/**
 * Production Super Plan journals. Do not rename — runs live at
 * `~/.minnow/superplan/<runId>/journal.jsonl`.
 */
export const SUPERPLAN_NAMESPACE = 'superplan';

const runs = createJournalStore({
  namespace: SUPERPLAN_NAMESPACE,
  idKind: 'run',
  fold: derive,
  validate: validateEvent,
});

/** @param {string} runId */
export function runDir(runId) {
  return runs.entryDir(runId);
}

/** @param {string} runId */
export function journalPath(runId) {
  return runs.journalPath(runId);
}

export const readEvents = runs.readEvents;
export const readHighestSeq = runs.readHighestSeq;
async function project(runId) {
  try {
    const state = await runs.loadState(runId);
    if (!state.chatId) return;
    const { getSessionsDb } = await import('../config/sessions-db.js');
    const db = getSessionsDb();
    const row = db.prepare('SELECT meta_json FROM chats WHERE id = ?').get(state.chatId);
    if (!row) return;
    const meta = JSON.parse(row.meta_json || '{}');
    meta.superPlanRunId = runId;
    meta.superPlanView = { ...projectSuperPlan(state, Date.now()), seq: await runs.readHighestSeq(runId) };
    db.prepare('UPDATE chats SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), state.chatId);
  } catch (error) { console.warn('[super-plan] projection refresh failed:', error.message); }
}
export async function appendEvent(runId, event) {
  const result = await runs.appendEvent(runId, event);
  await project(runId);
  return result;
}
export async function appendEvents(runId, events) {
  const result = await runs.appendEvents(runId, events);
  await project(runId);
  return result;
}
export const loadState = runs.loadState;
export const createEntry = runs.createEntry;
export const entryExists = runs.entryExists;
export const deleteEntry = runs.deleteEntry;
export const listEntries = runs.listEntries;
export const resetJournalCache = runs.resetCache;