/** Boards journal binding onto namespace boards. */

import { derive } from './core/derive.js';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { queryAbandonments } from './core/evidence.js';
import { validateEvent } from './core/events.js';
import {
  deriveFrom,
  isSnapshotUsable,
  makeSnapshot,
  SNAPSHOT_INTERVAL,
  shouldSnapshot,
} from './core/snapshot.js';
import { BOARDS_NAMESPACE, createJournalStore } from './journal-store.js';

const boards = createJournalStore({
  namespace: BOARDS_NAMESPACE,
  idKind: 'board',
  fold: derive,
  foldFrom: deriveFrom,
  isSnapshotUsable,
  makeSnapshot,
  shouldSnapshot,
  validate: validateEvent,
  queryAbandonments,
});

/** @param {string} boardId */
export function boardDir(boardId) {
  return boards.entryDir(boardId);
}

/** @param {string} boardId */
export function journalPath(boardId) {
  return boards.journalPath(boardId);
}

/** @param {string} boardId */
export function snapshotPath(boardId) {
  return boards.snapshotPath(boardId);
}

export const readEvents = boards.readEvents;
export const readHighestSeq = boards.readHighestSeq;
export const appendEvent = boards.appendEvent;
export const appendEvents = boards.appendEvents;
export const writeSnapshot = boards.writeSnapshot;
export const readSnapshot = boards.readSnapshot;
export const refreshSnapshot = boards.refreshSnapshot;
export const loadState = boards.loadState;
export const loadAbandonments = boards.loadAbandonments;
export const createBoard = boards.createEntry;
export const boardExists = boards.entryExists;
export const deleteBoard = boards.deleteEntry;
export const listBoards = boards.listEntries;
export const resetJournalCache = boards.resetCache;

/** Read ownership without replaying later events or trusting a broken snapshot. */
export async function readBoardIdentity(boardId) {
  const stream = createReadStream(journalPath(boardId), { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type !== 'board.created' || event.boardId !== boardId) {
        throw new Error('board ownership could not be read from its creation event');
      }
      return {
        boardId,
        name: typeof event.name === 'string' ? event.name : boardId,
        planPath: typeof event.planPath === 'string' ? event.planPath : '',
        workspacePath: typeof event.workspacePath === 'string' ? event.workspacePath : null,
        tasks: new Map(),
      };
    }
    throw new Error('board has no creation event');
  } finally {
    lines.close();
    stream.destroy();
  }
}

export { SNAPSHOT_INTERVAL };
