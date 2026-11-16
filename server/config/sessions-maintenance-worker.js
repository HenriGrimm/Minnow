import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { closeSessionsDb, openSessionsDbForRead, prepareSessionsDb } from './sessions-db.js';
import { verifySessionsSnapshot } from './sessions-snapshot.js';

try {
  let value;
  if (workerData.operation === 'initialize') {
    await prepareSessionsDb();
  } else if (workerData.operation === 'verify-snapshot') {
    value = verifySessionsSnapshot(workerData.filePath);
  } else if (workerData.operation === 'snapshot') {
    const source = new Database(workerData.sourcePath, { fileMustExist: true });
    try {
      await source.backup(workerData.filePath);
    } finally {
      source.close();
    }
    value = verifySessionsSnapshot(workerData.filePath);
  } else if (workerData.operation === 'read-summaries') {
    const { readSessionSummariesState } = await import('./sessions-repo.js');
    const db = openSessionsDbForRead();
    try {
      value = db.transaction(() => JSON.stringify(readSessionSummariesState(workerData.filter)))();
    } finally {
      closeSessionsDb();
    }
  } else {
    throw new Error('Unknown sessions maintenance operation');
  }
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message, code: error.code });
}
