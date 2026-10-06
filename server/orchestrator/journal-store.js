/**
 * Generic append-only JSONL store, namespaced under `getMinnowHome()`.
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { getMinnowHome, ensureMinnowLayout } from '../config/home.js';

/** Production board journals. Do not rename — every run to date lives here. */
export const BOARDS_NAMESPACE = 'boards';

/**
 * Ids (and namespace segments) reach here from HTTP, so they are never interpolated into a path unchecked.
 * @param {string} value
 * @param {string} [kind]
 * @returns {string}
 */
export function safeSegment(value, kind = 'entry') {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new Error(`invalid ${kind} id: ${JSON.stringify(value)}`);
  }
  return id;
}

/**
 * Directory for one journaled entry: `~/.minnow/<namespace>/<id>/`.
 *
 * @param {string} namespace
 * @param {string} id
 * @param {string} [idKind]  error-message noun; boards pass `'board'`
 * @returns {string}
 */
export function entryDir(namespace, id, idKind = 'entry') {
  return path.join(getMinnowHome(), safeSegment(namespace, 'namespace'), safeSegment(id, idKind));
}

/**
 * @param {string} namespace
 * @param {string} id
 * @param {string} [idKind]
 * @returns {string}
 */
export function journalFile(namespace, id, idKind = 'entry') {
  return path.join(entryDir(namespace, id, idKind), 'journal.jsonl');
}

/**
 * @param {string} namespace
 * @param {string} id
 * @param {string} [idKind]
 * @returns {string}
 */
export function snapshotFile(namespace, id, idKind = 'entry') {
  return path.join(entryDir(namespace, id, idKind), 'snapshot.json');
}

/**
 * One namespaced journal.
 * @param {{
 *   namespace: string,
 *   idKind?: string,
 *   fold: (events: Record<string, unknown>[]) => unknown,
 *   foldFrom?: (snapshot: unknown, events: Record<string, unknown>[]) => unknown,
 *   isSnapshotUsable?: (snapshot: unknown, events: Record<string, unknown>[]) => boolean,
 *   makeSnapshot?: (id: string, state: unknown, through: number) => unknown,
 *   shouldSnapshot?: (seq: number) => boolean,
 *   validate?: (event: unknown) => { ok: true } | { ok: false, error: string },
 *   queryAbandonments?: (events: Record<string, unknown>[]) => unknown[],
 * }} options
 */
export function createJournalStore(options) {
  const namespace = safeSegment(options.namespace, 'namespace');
  const idKind = options.idKind ?? 'entry';
  const fold = options.fold;
  const foldFrom = options.foldFrom;
  const isSnapshotUsable = options.isSnapshotUsable;
  const makeSnapshot = options.makeSnapshot;
  const shouldSnapshot = options.shouldSnapshot;
  const validate = options.validate;
  const queryAbandonments = options.queryAbandonments;

  /** @type {Map<string, Promise<unknown>>} */
  const appendChains = new Map();

  /** @type {Map<string, { seq: number, size: number }>} */
  const highestSeq = new Map();

  let snapshotWrites = 0;

  /**
   * @param {string} id
   * @returns {string}
   */
  function dirOf(id) {
    return entryDir(namespace, id, idKind);
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  function journalOf(id) {
    return journalFile(namespace, id, idKind);
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  function snapshotOf(id) {
    return snapshotFile(namespace, id, idKind);
  }

  /**
   * Run `task` after every append already queued for this entry.
   *
   * @template T
   * @param {string} id
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serialise(id, task) {
    const previous = appendChains.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    appendChains.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * @param {string} text
   * @returns {boolean}
   */
  function isJson(text) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} file
   * @returns {Promise<boolean>}
   */
  async function endsWithNewline(file) {
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const { size } = await handle.stat();
      if (size === 0) return false;
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0] === 0x0a;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }

  /**
   * Give the journal a terminating newline, returning the size it now has.
   * @param {string} id
   * @returns {Promise<number>}
   */
  async function repairTornTail(id) {
    const file = journalOf(id);
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle;
    try {
      handle = await fs.open(file, 'r+');
      const { size } = await handle.stat();
      if (size === 0) return 0;

      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail[0] === 0x0a) return size;

      const CHUNK = 64 * 1024;
      let end = size;
      let start = 0;
      while (end > 0) {
        const from = Math.max(0, end - CHUNK);
        const buffer = Buffer.alloc(end - from);
        await handle.read(buffer, 0, buffer.length, from);
        const index = buffer.lastIndexOf(0x0a);
        if (index !== -1) {
          start = from + index + 1;
          break;
        }
        end = from;
      }

      const line = Buffer.alloc(size - start);
      await handle.read(line, 0, line.length, start);
      const text = line.toString('utf8');

      if (text.trim().length > 0 && isJson(text)) {
        await handle.write('\n', size, 'utf8');
        return size + 1;
      }

      await handle.truncate(start);
      return start;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 0;
      throw err;
    } finally {
      await handle?.close();
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<number>}
   */
  async function journalSize(id) {
    try {
      return (await fs.stat(journalOf(id))).size;
    } catch {
      return 0;
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<number>}
   */
  async function nextSeq(id) {
    const size = await journalSize(id);
    const cached = highestSeq.get(id);
    if (cached && cached.size === size) return cached.seq;
    const repaired = await repairTornTail(id);
    const seq = await readHighestSeq(id);
    highestSeq.set(id, { seq, size: repaired });
    return seq;
  }

  /**
   * @param {string} id
   * @param {number} seq
   * @returns {Promise<void>}
   */
  async function recordTail(id, seq) {
    highestSeq.set(id, { seq, size: await journalSize(id) });
  }

  /**
   * @param {unknown} event
   * @returns {void}
   */
  function assertValid(event) {
    if (!validate) return;
    const checked = validate(event);
    if (!checked.ok) {
      throw new Error(`refusing to journal an invalid event: ${checked.error}`);
    }
  }

  /**
   * Read one journal.
   * @param {string} id
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async function readEvents(id) {
    const file = journalOf(id);
    /** @type {Record<string, unknown>[]} */
    const events = [];

    /** @type {string | null} */
    let pendingBadLine = null;
    /** @type {number} */
    let pendingBadLineNumber = 0;
    let lineNumber = 0;

    let stream;
    try {
      stream = createReadStream(file, { encoding: 'utf8' });
      await new Promise((resolve, reject) => {
        stream.once('open', resolve);
        stream.once('error', reject);
      });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
      throw err;
    }

    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (pendingBadLine !== null) {
          throw new Error(
            `journal ${file} is corrupt at line ${pendingBadLineNumber}: ` +
              'unparseable line followed by further content',
          );
        }
        if (line.trim().length === 0) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          pendingBadLine = line;
          pendingBadLineNumber = lineNumber;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }

    if (pendingBadLine !== null && (await endsWithNewline(file))) {
      throw new Error(
        `journal ${file} is corrupt at line ${pendingBadLineNumber}: ` +
          'unparseable line was written in full',
      );
    }

    return events;
  }

  /**
   * @param {string} id
   * @returns {Promise<number>}
   */
  async function readHighestSeq(id) {
    const events = await readEvents(id);
    let highest = 0;
    for (const event of events) {
      const seq = Number(event?.seq);
      if (Number.isSafeInteger(seq) && seq > highest) highest = seq;
    }
    return highest;
  }

  /**
   * @param {string} id
   * @param {Record<string, unknown>} event
   * @param {{ now?: () => number }} [opts]
   * @returns {Promise<Record<string, unknown>>}
   */
  function appendEvent(id, event, opts = {}) {
    /** @type {string} */
    let safe;
    try {
      safe = safeSegment(id, idKind);
    } catch (err) {
      return Promise.reject(err);
    }
    const now = opts.now ?? (() => Date.now());

    return serialise(safe, async () => {
      const seq = (await nextSeq(safe)) + 1;
      const stamped = { v: 1, ...event, seq, ts: now() };
      assertValid(stamped);

      await fs.mkdir(dirOf(safe), { recursive: true });
      await fs.appendFile(journalOf(safe), `${JSON.stringify(stamped)}\n`, 'utf8');
      await recordTail(safe, seq);

      if (shouldSnapshot?.(seq) && makeSnapshot) {
        void refreshSnapshot(safe).catch((err) => {
          console.warn(
            `[orchestrator] snapshot write failed for ${namespace}/${safe}:`,
            err?.message ?? err,
          );
        });
      }

      return stamped;
    });
  }

  /**
   * @param {string} id
   * @param {Record<string, unknown>[]} events
   * @param {{ now?: () => number }} [opts]
   * @returns {Promise<Record<string, unknown>[]>}
   */
  function appendEvents(id, events, opts = {}) {
    /** @type {string} */
    let safe;
    try {
      safe = safeSegment(id, idKind);
    } catch (err) {
      return Promise.reject(err);
    }
    const now = opts.now ?? (() => Date.now());

    return serialise(safe, async () => {
      let seq = await nextSeq(safe);

      /** @type {Record<string, unknown>[]} */
      const stampedAll = [];
      for (const event of events) {
        seq += 1;
        const stamped = { v: 1, ...event, seq, ts: now() };
        assertValid(stamped);
        stampedAll.push(stamped);
      }
      if (stampedAll.length === 0) return [];

      await fs.mkdir(dirOf(safe), { recursive: true });
      await fs.appendFile(
        journalOf(safe),
        `${stampedAll.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8',
      );
      await recordTail(safe, seq);

      if (makeSnapshot && stampedAll.some((e) => shouldSnapshot?.(Number(e.seq)))) {
        void refreshSnapshot(safe).catch((err) => {
          console.warn(
            `[orchestrator] snapshot write failed for ${namespace}/${safe}:`,
            err?.message ?? err,
          );
        });
      }

      return stampedAll;
    });
  }

  /**
   * @param {string} id
   * @param {unknown} snapshot
   * @returns {Promise<void>}
   */
  async function writeSnapshot(id, snapshot) {
    const safe = safeSegment(id, idKind);
    const target = snapshotOf(safe);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${(snapshotWrites += 1)}`;
    await fs.writeFile(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
    await fs.rename(tmp, target);
  }

  /**
   * @param {string} id
   * @returns {Promise<unknown | null>}
   */
  async function readSnapshot(id) {
    try {
      const raw = await fs.readFile(snapshotOf(id), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function refreshSnapshot(id) {
    return serialise(id, async () => {
      if (!makeSnapshot) return;
      const events = await readEvents(id);
      if (events.length === 0) return;
      const through = events.reduce((max, e) => {
        const seq = Number(e?.seq);
        return Number.isSafeInteger(seq) && seq > max ? seq : max;
      }, 0);
      if (through === 0) return;
      await writeSnapshot(id, makeSnapshot(id, fold(events), through));
    });
  }

  /**
   * Current state.
   * @param {string} id
   * @returns {Promise<unknown>}
   */
  async function loadState(id) {
    const events = await readEvents(id);
    const snapshot = await readSnapshot(id);
    if (!snapshot || !isSnapshotUsable || !foldFrom || !isSnapshotUsable(snapshot, events)) {
      return fold(events);
    }
    return foldFrom(snapshot, events);
  }

  /**
   * @param {string} id
   * @returns {Promise<unknown[]>}
   */
  async function loadAbandonments(id) {
    if (!queryAbandonments) return [];
    return queryAbandonments(await readEvents(id));
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function createEntry(id) {
    const safe = safeSegment(id, idKind);
    await ensureMinnowLayout();
    await fs.mkdir(dirOf(safe), { recursive: true });
    const file = journalOf(safe);
    try {
      const handle = await fs.open(file, 'wx');
      await handle.close();
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function entryExists(id) {
    try {
      await fs.access(journalOf(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async function deleteEntry(id) {
    const safe = safeSegment(id, idKind);
    return serialise(safe, async () => {
      if (!(await entryExists(safe))) return false;
      await fs.rm(dirOf(safe), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      highestSeq.delete(safe);
      return true;
    });
  }

  /**
   * @returns {Promise<string[]>}
   */
  async function listEntries() {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(path.join(getMinnowHome(), namespace), { withFileTypes: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
      throw err;
    }
    /** @type {string[]} */
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await entryExists(entry.name)) ids.push(entry.name);
    }
    return ids.sort();
  }

  /** @returns {void} */
  function resetCache() {
    appendChains.clear();
    highestSeq.clear();
  }

  return {
    namespace,
    entryDir: dirOf,
    journalPath: journalOf,
    snapshotPath: snapshotOf,
    readEvents,
    readHighestSeq,
    appendEvent,
    appendEvents,
    writeSnapshot,
    readSnapshot,
    refreshSnapshot,
    loadState,
    loadAbandonments,
    createEntry,
    entryExists,
    deleteEntry,
    listEntries,
    resetCache,
  };
}
