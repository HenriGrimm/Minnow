/** Super Plan run journal binding onto namespace `superplan`, plus the chat summary write-back. */

import { derive } from './derive.js';
import { validateEvent } from './events.js';
import { projectChatSummary } from './projection.js';
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

/**
 * Chat summaries waiting to be written, per run. A burst of appends becomes
 * one fold and one row update.
 * @type {Map<string, { running: boolean, again: boolean }>}
 */
const summaryWrites = new Map();

/** Tests and the dev harness can turn the SQLite write-back off. */
let summaryWriteBack = true;

/** @param {boolean} enabled */
export function setChatSummaryWriteBack(enabled) {
  summaryWriteBack = enabled;
}

/**
 * Store the run's summary on its chat row, so the sidebar and plan library
 * show current progress even when no window is watching the run. The session
 * importer keeps a newer summary (by seq) when an older renderer saves.
 * @param {string} runId
 */
async function writeChatSummary(runId) {
  const state = /** @type {import('./types').RunState} */ (await runs.loadState(runId));
  if (!state.chatId) return;
  const { getSessionsDb } = await import('../config/sessions-db.js');
  const db = getSessionsDb();
  const row = db.prepare('SELECT meta_json FROM chats WHERE id = ?').get(state.chatId);
  if (!row) return;
  const meta = JSON.parse(row.meta_json || '{}');
  meta.superPlanRunId = runId;
  meta.superPlanView = projectChatSummary(state, { seq: state.lastSeq });
  db.prepare('UPDATE chats SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), state.chatId);
}

/**
 * @param {string} runId
 */
function scheduleChatSummary(runId) {
  if (!summaryWriteBack) return Promise.resolve();
  const slot = summaryWrites.get(runId);
  if (slot?.running) {
    slot.again = true;
    return Promise.resolve();
  }
  const next = { running: true, again: false };
  summaryWrites.set(runId, next);
  return (async () => {
    try {
      do {
        next.again = false;
        await writeChatSummary(runId);
      } while (next.again);
    } catch (error) {
      console.warn('[super-plan] chat summary refresh failed:', error instanceof Error ? error.message : error);
    } finally {
      summaryWrites.delete(runId);
    }
  })();
}

export const readEvents = runs.readEvents;
export const readHighestSeq = runs.readHighestSeq;

/**
 * @param {string} runId
 * @param {Record<string, unknown>} event
 * @param {{ now?: () => number }} [opts]
 */
export async function appendEvent(runId, event, opts) {
  const result = await runs.appendEvent(runId, event, opts);
  void scheduleChatSummary(runId);
  return result;
}

/**
 * @param {string} runId
 * @param {Record<string, unknown>[]} events
 * @param {{ now?: () => number }} [opts]
 */
export async function appendEvents(runId, events, opts) {
  const result = await runs.appendEvents(runId, events, opts);
  void scheduleChatSummary(runId);
  return result;
}

export const loadState = runs.loadState;
export const createEntry = runs.createEntry;
export const entryExists = runs.entryExists;
export const deleteEntry = runs.deleteEntry;
export const listEntries = runs.listEntries;
export const resetJournalCache = runs.resetCache;
