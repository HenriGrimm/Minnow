import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';

// Linked worktrees share a project ledger without recording their merge twice.
export function activityWorkspaceKey(root) {
  let project = root;
  try {
    const marker = fs.readFileSync(path.join(root, '.git'), 'utf8').trim();
    if (marker.startsWith('gitdir:')) {
      const gitDir = path.resolve(root, marker.slice(7).trim());
      const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      if (path.basename(common) === '.git') project = path.dirname(common);
    }
  } catch { /* A normal repository or a folder without Git. */ }
  return normalizeWorkspacePathKey(project);
}

function database(root) {
  const dir = path.join(getMinnowHome(), 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(activityWorkspaceKey(root)).digest('hex');
  const db = new Database(path.join(dir, `${key}.sqlite`));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edits (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL,
      additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
      paths TEXT NOT NULL, chatId TEXT, workspace TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS edits_at ON edits(at);`);
  db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('trackingSince', new Date().toISOString());
  return db;
}

export function recordCodeActivity(root, event) {
  const { additions, deletions, source } = event;
  if (!['agent', 'completions'].includes(source) ||
      !Number.isSafeInteger(additions) || additions < 0 ||
      !Number.isSafeInteger(deletions) || deletions < 0 ||
      additions + deletions > 10_000_000) throw new Error('Invalid edit counts or source');
  if (additions + deletions === 0) return false;
  const db = database(root);
  try {
    return db.prepare('INSERT OR IGNORE INTO edits VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      String(event.id || randomUUID()).slice(0, 160), new Date().toISOString(), source,
      additions, deletions, JSON.stringify((event.paths ?? []).filter(p => typeof p === 'string').slice(0, 100)),
      typeof event.chatId === 'string' ? event.chatId.slice(0, 160) : null, root,
    ).changes > 0;
  } finally { db.close(); }
}

/** Calendar day (YYYY-MM-DD) of an ISO timestamp in `timeZone`; en-CA formats dates as ISO. */
function dayFormatter(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at) => format.format(new Date(at));
}

export function readCodeActivity(root, { source = 'all', day, timeZone = 'UTC' } = {}) {
  if (!['all', 'agent', 'completions'].includes(source)) throw new Error('Invalid source');
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid day');
  let localDay;
  try { localDay = dayFormatter(timeZone); } catch { throw new Error('Invalid timeZone'); }
  const db = database(root);
  try {
    const trackingSince = localDay(db.prepare('SELECT value FROM metadata WHERE key = ?').get('trackingSince').value);
    // Timestamps are stored in UTC; widen the window by a day so edge days survive the zone shift.
    const since = new Date(Date.now() - 367 * 86400000).toISOString();
    const totals = new Map();
    for (const row of db.prepare(`SELECT at, source, additions, deletions FROM edits
      WHERE at >= ? AND (? = 'all' OR source = ?)`).iterate(since, source, source)) {
      const key = `${localDay(row.at)}
${row.source}`;
      const value = totals.get(key) ?? { day: localDay(row.at), source: row.source, additions: 0, deletions: 0 };
      value.additions += row.additions; value.deletions += row.deletions;
      totals.set(key, value);
    }
    const days = [...totals.values()].sort((a, b) => a.day.localeCompare(b.day));
    let events = [];
    if (day) {
      const lo = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString();
      const hi = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86400000).toISOString();
      events = db.prepare(`SELECT * FROM edits WHERE at >= ? AND at < ? AND (? = 'all' OR source = ?)
        ORDER BY at DESC`).all(lo, hi, source, source)
        .filter(r => localDay(r.at) === day).slice(0, 100)
        .map(r => ({ ...r, paths: JSON.parse(r.paths) }));
    }
    return { trackingSince, days, events };
  } finally { db.close(); }
}
