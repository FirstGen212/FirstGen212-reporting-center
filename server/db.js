// The app's own small database (SQLite): users and roles, saved reports, schedules, shared links, run history,
// the email outbox and the audit log. Report data is never stored here; it is read from Supabase on demand.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'reporting-center.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
  perms TEXT NOT NULL DEFAULT '{}'           -- {is_admin, admin:{capability:true}}
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, title TEXT,
  role_id INTEGER REFERENCES roles(id), overrides TEXT NOT NULL DEFAULT '{}',
  password_hash TEXT, password_changed_at TEXT, last_login_at TEXT,
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, channel TEXT, kind TEXT, to_addr TEXT, cc TEXT, bcc TEXT, subject TEXT, body TEXT,
  attachments TEXT, status TEXT, error TEXT, meta TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, field TEXT, old_value TEXT, new_value TEXT,
  user_id INTEGER, source TEXT DEFAULT 'ui', created_at TEXT DEFAULT (datetime('now'))
);
`);

const all = (sql, ...a) => db.prepare(sql).all(...a);
const get = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

function getSetting(key, dflt) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? J(r.value, dflt) : dflt;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
function audit({ entity, entity_id = 0, field, old_value, new_value, user_id = null, source = 'ui' }) {
  const s = v => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  run('INSERT INTO audit_log(entity, entity_id, field, old_value, new_value, user_id, source) VALUES(?,?,?,?,?,?,?)',
    entity, entity_id, field, s(old_value), s(new_value), user_id, source);
}

module.exports = { db, all, get, run, J, getSetting, setSetting, audit, DB_PATH };
