import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  prompt      TEXT NOT NULL,
  engine      TEXT NOT NULL DEFAULT 'claude',
  cwd         TEXT,
  stream      INTEGER NOT NULL DEFAULT 0, -- 0 = buffered (default), 1 = stream-json
  concise     INTEGER NOT NULL DEFAULT 1, -- 1 = concise answer (default), 0 = full
  status      TEXT NOT NULL,              -- queued | running | done | failed | canceled
  output      TEXT,
  error       TEXT,
  exit_code   INTEGER,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  name  TEXT PRIMARY KEY,
  value TEXT
);
`;

// Lightweight migrations for databases created by an earlier version.
function migrate(db) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
  if (!cols.includes('stream')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN stream INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('concise')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN concise INTEGER NOT NULL DEFAULT 1`);
  }
}

/**
 * Open (or create) the SQLite database and ensure the schema exists.
 * Pass ':memory:' for an ephemeral DB (used by tests).
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function insertTask(db, task) {
  db.prepare(
    `INSERT INTO tasks (id, prompt, engine, cwd, stream, concise, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
  ).run(
    task.id, task.prompt, task.engine, task.cwd ?? null,
    task.stream ? 1 : 0, task.concise ? 1 : 0, task.created_at
  );
  return getTask(db, task.id);
}

export function getSetting(db, name) {
  const row = db.prepare('SELECT value FROM settings WHERE name = ?').get(name);
  return row ? row.value : null;
}
export function setSetting(db, name, value) {
  db.prepare(
    `INSERT INTO settings (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`
  ).run(name, value);
}

/** Append streamed output to a task incrementally. */
export function appendOutput(db, id, text) {
  db.prepare(`UPDATE tasks SET output = COALESCE(output, '') || ? WHERE id = ?`).run(text, id);
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

export function markRunning(db, id, startedAt) {
  db.prepare(`UPDATE tasks SET status='running', started_at=? WHERE id=?`).run(startedAt, id);
}

export function markFinished(db, id, { status, output, error, exitCode, finishedAt }) {
  db.prepare(
    `UPDATE tasks SET status=?, output=?, error=?, exit_code=?, finished_at=? WHERE id=?`
  ).run(status, output ?? null, error ?? null, exitCode ?? null, finishedAt, id);
  return getTask(db, id);
}

/**
 * Cursor-paginated history, newest first.
 * cursor = created_at of the last item from the previous page (exclusive).
 */
export function listTasks(db, { cursor, limit = 20 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  let rows;
  if (cursor) {
    rows = db
      .prepare(
        `SELECT * FROM tasks WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(Number(cursor), lim + 1);
  } else {
    rows = db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
      .all(lim + 1);
  }
  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim);
  const nextCursor = hasMore ? items[items.length - 1].created_at : null;
  return { items, nextCursor };
}

export function getQueuedIds(db) {
  return db
    .prepare(`SELECT id FROM tasks WHERE status='queued' ORDER BY created_at ASC`)
    .all()
    .map((r) => r.id);
}

/**
 * On startup, any task still marked 'running' is an orphan from a previous
 * crash/restart; fail it so the queue is in a clean state.
 */
export function failOrphans(db, finishedAt) {
  const orphans = db.prepare(`SELECT id FROM tasks WHERE status='running'`).all();
  for (const { id } of orphans) {
    markFinished(db, id, {
      status: 'failed',
      error: 'Interrupted by server restart',
      exitCode: null,
      finishedAt,
    });
  }
  return orphans.length;
}
