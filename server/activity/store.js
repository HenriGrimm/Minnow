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

export function readCodeActivity(root, { source = 'all', day } = {}) {
  if (!['all', 'agent', 'completions'].includes(source)) throw new Error('Invalid source');
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid day');
  const db = database(root);
  try {
    const trackingSince = db.prepare('SELECT value FROM metadata WHERE key = ?').get('trackingSince').value;
    const since = new Date(Date.now() - 366 * 86400000).toISOString().slice(0, 10);
    const days = db.prepare(`SELECT substr(at, 1, 10) AS day, source,
      sum(additions) AS additions, sum(deletions) AS deletions
      FROM edits WHERE at >= ? AND (? = 'all' OR source = ?)
      GROUP BY day, source ORDER BY day`).all(since, source, source);
    const rows = day ? db.prepare(`SELECT * FROM edits WHERE substr(at, 1, 10) = ?
      AND (? = 'all' OR source = ?) ORDER BY at DESC LIMIT 100`).all(day, source, source) : [];
    return { trackingSince, days, events: rows.map(r => ({ ...r, paths: JSON.parse(r.paths) })) };
  } finally { db.close(); }
}
