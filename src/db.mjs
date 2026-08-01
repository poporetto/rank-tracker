import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Every stored check carries one of these four statuses. Keeping `blocked` and
 * `error` distinct from `absent` is the whole ballgame: if a CAPTCHA page were
 * recorded as "not ranking", the history chart would show a rank collapse that
 * never happened.
 */
export const STATUS = {
  FOUND: 'found',     // parsed the SERP, the domain is at `position`
  ABSENT: 'absent',   // parsed a full SERP of `results_parsed` results, domain not in it
  BLOCKED: 'blocked', // CAPTCHA / consent wall / bot challenge - we learned nothing
  ERROR: 'error',     // network, timeout, parse or auth failure - we learned nothing
};

/** Statuses that represent real knowledge about the ranking. */
export const CONCLUSIVE = [STATUS.FOUND, STATUS.ABSENT];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  domain           TEXT    NOT NULL UNIQUE,
  match_subdomains INTEGER NOT NULL DEFAULT 1,
  gsc_site         TEXT,
  created_at       TEXT    NOT NULL
);

-- A keyword is engine-agnostic: it is checked on every available engine.
-- Which engine produced a number lives on the check, not here.
CREATE TABLE IF NOT EXISTS keywords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword    TEXT    NOT NULL,
  country    TEXT    NOT NULL DEFAULT 'us',
  language   TEXT    NOT NULL DEFAULT 'en',
  depth      INTEGER NOT NULL DEFAULT 30,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  UNIQUE (project_id, keyword, country, language)
);
CREATE INDEX IF NOT EXISTS idx_keywords_project ON keywords(project_id);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  status      TEXT    NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  message     TEXT
);

CREATE TABLE IF NOT EXISTS checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id     INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  run_id         INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  checked_at     TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  position       REAL,
  url            TEXT,
  results_parsed INTEGER NOT NULL DEFAULT 0,
  depth_target   INTEGER NOT NULL DEFAULT 0,
  engine         TEXT    NOT NULL,
  country        TEXT    NOT NULL,
  language       TEXT    NOT NULL,
  impressions    INTEGER,
  clicks         INTEGER,
  ctr            REAL,
  message        TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_keyword ON checks(keyword_id, engine, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_run ON checks(run_id);

CREATE TABLE IF NOT EXISTS serp_results (
  check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url      TEXT    NOT NULL,
  title    TEXT,
  PRIMARY KEY (check_id, position)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

let db;

export function openDb(file = resolve(process.cwd(), 'data', 'rank-tracker.db')) {
  if (db) return db;
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  // Keywords used to carry an `engine` column, back when one keyword meant one
  // engine. Now every keyword is checked on every engine. Rather than guess how
  // to merge the old per-engine rows, say so plainly and stop.
  const columns = db.prepare('PRAGMA table_info(keywords)').all();
  if (columns.some((c) => c.name === 'engine')) {
    throw new Error(
      `This database uses the old per-engine keyword layout and cannot be migrated automatically.\n` +
        `Delete it and start fresh:  rm -rf data/\n  (${file})`,
    );
  }

  // Additive migration: manual ordering. Safe to run against a populated
  // database — existing keywords keep their current (creation) order.
  if (!columns.some((c) => c.name === 'sort_order')) {
    db.exec('ALTER TABLE keywords ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE keywords SET sort_order = id');
  }
  return db;
}

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ settings */

export function getSetting(key, fallback = null) {
  const row = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  openDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

export function deleteSetting(key) {
  openDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/* ------------------------------------------------------------------ projects */

export function listProjects() {
  return openDb().prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all();
}

export function getProject(id) {
  return openDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function createProject({ name, domain, matchSubdomains = true }) {
  const info = openDb()
    .prepare('INSERT INTO projects (name, domain, match_subdomains, created_at) VALUES (?, ?, ?, ?)')
    .run(name, domain, matchSubdomains ? 1 : 0, now());
  return getProject(Number(info.lastInsertRowid));
}

export function updateProject(id, { name, domain, matchSubdomains, gscSite }) {
  const p = getProject(id);
  if (!p) return null;
  openDb()
    .prepare('UPDATE projects SET name = ?, domain = ?, match_subdomains = ?, gsc_site = ? WHERE id = ?')
    .run(
      name ?? p.name,
      domain ?? p.domain,
      matchSubdomains === undefined ? p.match_subdomains : matchSubdomains ? 1 : 0,
      gscSite === undefined ? p.gsc_site : gscSite || null,
      id,
    );
  return getProject(id);
}

export function deleteProject(id) {
  openDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ keywords */

export function listKeywords(projectId) {
  return openDb()
    .prepare('SELECT * FROM keywords WHERE project_id = ? ORDER BY sort_order, id')
    .all(projectId);
}

/** Persist a drag-and-drop ordering. Ids not listed keep their place at the end. */
export function reorderKeywords(projectId, orderedIds) {
  const database = openDb();
  const stmt = database.prepare('UPDATE keywords SET sort_order = ? WHERE id = ? AND project_id = ?');
  database.exec('BEGIN');
  try {
    orderedIds.forEach((id, index) => stmt.run(index + 1, Number(id), projectId));
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

export function getKeyword(id) {
  return openDb().prepare('SELECT * FROM keywords WHERE id = ?').get(id);
}

export function createKeyword({ projectId, keyword, country, language, depth }) {
  const existing = openDb()
    .prepare('SELECT * FROM keywords WHERE project_id = ? AND keyword = ? AND country = ? AND language = ?')
    .get(projectId, keyword, country, language);
  if (existing) return { keyword: existing, created: false };

  const next =
    (openDb().prepare('SELECT MAX(sort_order) AS m FROM keywords WHERE project_id = ?').get(projectId)?.m ?? 0) + 1;
  const info = openDb()
    .prepare(
      `INSERT INTO keywords (project_id, keyword, country, language, depth, active, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(projectId, keyword, country, language, depth, next, now());
  return { keyword: getKeyword(Number(info.lastInsertRowid)), created: true };
}

export function setKeywordActive(id, active) {
  openDb().prepare('UPDATE keywords SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getKeyword(id);
}

export function deleteKeyword(id) {
  openDb().prepare('DELETE FROM keywords WHERE id = ?').run(id);
}

/* -------------------------------------------------------------------- checks */

export function recordCheck(keywordId, runId, result, keywordRow, engine) {
  const database = openDb();
  const info = database
    .prepare(
      `INSERT INTO checks (keyword_id, run_id, checked_at, status, position, url,
                           results_parsed, depth_target, engine, country, language,
                           impressions, clicks, ctr, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      keywordId,
      runId,
      now(),
      result.status,
      result.position ?? null,
      result.url ?? null,
      result.resultsParsed ?? 0,
      keywordRow.depth,
      engine,
      keywordRow.country,
      keywordRow.language,
      result.impressions ?? null,
      result.clicks ?? null,
      result.ctr ?? null,
      result.message ?? null,
    );

  const checkId = Number(info.lastInsertRowid);
  if (Array.isArray(result.serp) && result.serp.length) {
    const stmt = database.prepare('INSERT OR REPLACE INTO serp_results (check_id, position, url, title) VALUES (?, ?, ?, ?)');
    for (const row of result.serp) stmt.run(checkId, row.position, row.url, row.title ?? null);
  }
  return checkId;
}

/*
 * Every history lookup is scoped to a single engine. One keyword now holds
 * interleaved DuckDuckGo and Search Console checks, and those numbers are not
 * comparable: DuckDuckGo position 2 next to a Search Console 28-day average of
 * 7.4 is not a six-place drop, it is two different measurements. Mixing them
 * would silently manufacture deltas.
 */

export function latestCheck(keywordId, engine) {
  return openDb()
    .prepare('SELECT * FROM checks WHERE keyword_id = ? AND engine = ? ORDER BY checked_at DESC, id DESC LIMIT 1')
    .get(keywordId, engine);
}

/**
 * The most recent check on this engine that actually told us something,
 * optionally excluding one check id. Used for delta: a `blocked` run must
 * never reset the baseline.
 */
export function latestConclusiveCheck(keywordId, engine, excludeCheckId = null) {
  return openDb()
    .prepare(
      `SELECT * FROM checks
        WHERE keyword_id = ? AND engine = ? AND status IN (?, ?) AND (? IS NULL OR id != ?)
        ORDER BY checked_at DESC, id DESC LIMIT 1`,
    )
    .get(keywordId, engine, STATUS.FOUND, STATUS.ABSENT, excludeCheckId, excludeCheckId);
}

export function checkHistory(keywordId, engine, limit = 200) {
  return openDb()
    .prepare('SELECT * FROM checks WHERE keyword_id = ? AND engine = ? ORDER BY checked_at DESC, id DESC LIMIT ?')
    .all(keywordId, engine, limit);
}

/** Every check for a keyword regardless of engine — CSV export only. */
export function allChecks(keywordId, limit = 2000) {
  return openDb()
    .prepare('SELECT * FROM checks WHERE keyword_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?')
    .all(keywordId, limit);
}

export function serpForCheck(checkId) {
  return openDb()
    .prepare('SELECT position, url, title FROM serp_results WHERE check_id = ? ORDER BY position')
    .all(checkId);
}

/* ---------------------------------------------------------------------- runs */

export function createRun(projectId, total) {
  const info = openDb()
    .prepare('INSERT INTO runs (project_id, started_at, status, total, done) VALUES (?, ?, ?, ?, 0)')
    .run(projectId, now(), 'running', total);
  return Number(info.lastInsertRowid);
}

export function bumpRun(runId, done) {
  openDb().prepare('UPDATE runs SET done = ? WHERE id = ?').run(done, runId);
}

export function finishRun(runId, status, message = null) {
  openDb().prepare('UPDATE runs SET finished_at = ?, status = ?, message = ? WHERE id = ?').run(now(), status, message, runId);
}

export function getRun(runId) {
  return openDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

export function listRuns(projectId, limit = 20) {
  return openDb()
    .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit);
}

/** Any run left `running` from a previous process is dead - mark it so at boot. */
export function reapStaleRuns() {
  openDb()
    .prepare(`UPDATE runs SET status = 'interrupted', finished_at = ?, message = 'Server restarted during run' WHERE status = 'running'`)
    .run(now());
}
