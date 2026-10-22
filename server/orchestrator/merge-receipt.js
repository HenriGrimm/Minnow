/** An observed pre-merge baseline reconciles Git success lost before journaling. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { boardDir } from './journal.js';
import { safeSegment } from './journal-store.js';

function receiptPath(boardId, taskId) { return path.join(boardDir(boardId), 'recovery', 'merges', `${safeSegment(taskId)}.json`); }
export async function readMergeReceipt(boardId, taskId) {
  try { return JSON.parse(await fs.readFile(receiptPath(boardId, taskId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeMergeReceipt(boardId, taskId, receipt) {
  const target = receiptPath(boardId, taskId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  const handle = await fs.open(temp, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(receipt)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, target);
}
