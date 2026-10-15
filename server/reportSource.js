// The connection to the core Supabase (Postgres) database, and what the app knows about its shape.
// Every query runs in a READ ONLY transaction with a statement timeout, so a report can never change data.
// Connection: REPORTING_DB_URL if set (ideally a read-only database role), else the one saved under Settings.
const { getSetting, setSetting } = require('./db');

const TIMEOUT_MS = Number(process.env.REPORT_QUERY_TIMEOUT_MS) || 120000;
const SAMPLE_ROWS = 1000;      // rows sampled per JSON column to discover the keys inside it
const MAX_JSON_DEPTH = 3;
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast', 'auth', 'storage', 'realtime', 'supabase_functions', 'extensions',
  'graphql', 'graphql_public', 'pgbouncer', 'pgsodium', 'pgsodium_masks', 'vault', 'net', 'cron', 'supabase_migrations'];

function connectionString() {
  return process.env.REPORTING_DB_URL || getSetting('reporting_db_url', null) || null;
}
let pool = null, poolKey = null;
function pg() {
  const url = connectionString();
  if (!url) { const e = new Error('The database is not connected. Set REPORTING_DB_URL on the server, or add the connection under Settings.'); e.status = 400; throw e; }
  if (!pool || poolKey !== url) {
    if (pool) pool.end().catch(() => {});
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]|host=\/|\?host=/.test(url);
    pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    pool.on('error', e => console.error('[reporting] pool', e.message));
    poolKey = url;
  }
  return pool;
}

// Plain dates stay as 'YYYY-MM-DD' text (the default parser turns them into local-midnight Date objects).
const TYPES = { getTypeParser: (oid, format) => (oid === 1082 ? v => v : require('pg').types.getTypeParser(oid, format)) };

async function readOnly(sql, params = [], { timeoutMs = TIMEOUT_MS } = {}) {
  const client = await pg().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Number(timeoutMs) | 0)}`);
    const out = await client.query({ text: sql, values: params, types: TYPES });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (/statement timeout|canceling statement/i.test(e.message)) {
      const err = new Error(`The database took longer than ${Math.round(timeoutMs / 1000)}s to answer. Add a filter or use fewer rows.`); err.status = 504; throw err;
    }
    const err = new Error(`Database error: ${e.message}`); err.status = 400; throw err;
  } finally { client.release(); }
}

// ---------------------------------------------------------------- schema discovery
const KIND = t => {
  t = String(t || '').toLowerCase();
  if (/^(smallint|integer|bigint|numeric|decimal|real|double precision|money)$/.test(t)) return 'number';
  if (/^(date|timestamp)/.test(t)) return 'date';
  if (t === 'boolean') return 'boolean';
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t === 'array' || t === 'user-defined' || t === 'uuid' || /char|text|inet|interval|time/.test(t)) return 'text';
  return 'text';
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
function kindOfValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (ISO_DATE.test(v)) return 'date';
  return 'text';
}
// Walk sampled JSON values and collect each key path with the kind of value it holds. Arrays of objects are
// reached through their first element (company.0.label), which is how single-link Airtable fields arrive.
function collectPaths(samples) {
  const seen = new Map(); // path -> {kinds:Map, filled}
  const visit = (v, path, depth) => {
    if (path.length) {
      const key = path.join('.');
      const k = kindOfValue(v);
      const rec = seen.get(key) || { kinds: new Map(), filled: 0 };
      if (k) { rec.kinds.set(k, (rec.kinds.get(k) || 0) + 1); rec.filled++; }
      seen.set(key, rec);
    }
    if (depth >= MAX_JSON_DEPTH || v == null) return;
    if (Array.isArray(v)) { if (v.length && v[0] && typeof v[0] === 'object') visit(v[0], [...path, '0'], depth + 1); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) if (/^[\w\- ]{1,80}$/.test(k)) visit(x, [...path, k], depth + 1);
  };
  for (const s of samples) visit(s, [], 0);
  const out = [];
  for (const [path, rec] of seen) {
    const kinds = [...rec.kinds.entries()].sort((a, b) => b[1] - a[1]);
    let kind = kinds[0]?.[0] || 'text';
    if (kind === 'object') continue;                 // reached through its children
    if (kinds.length > 1 && kind !== 'text' && kinds.some(([k]) => k === 'text')) kind = 'text';
    out.push({ path, kind: kind === 'array' ? 'list' : kind, fill: samples.length ? Math.round((rec.filled / samples.length) * 100) : 0 });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function introspect() {
  const { rows: cols } = await readOnly(
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.ordinal_position, t.table_type
       FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema <> ALL($1::text[]) AND c.table_schema NOT LIKE 'pg\\_%'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`, [SYSTEM_SCHEMAS]);
  const { rows: est } = await readOnly(
    `SELECT n.nspname AS schema, c.relname AS name, GREATEST(c.reltuples, 0)::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p')`).catch(() => ({ rows: [] }));
  const tables = new Map();
  for (const c of cols) {
    const key = `${c.table_schema}.${c.table_name}`;
    if (!tables.has(key)) tables.set(key, { key, schema: c.table_schema, name: c.table_name, view: c.table_type !== 'BASE TABLE',
      est_rows: Number(est.find(e => e.schema === c.table_schema && e.name === c.table_name)?.rows || 0), columns: [] });
    tables.get(key).columns.push({ name: c.column_name, type: c.data_type, kind: KIND(c.data_type) });
  }
  // Discover the keys inside JSON columns from a sample of rows.
  for (const t of tables.values()) {
    for (const col of t.columns.filter(c => c.kind === 'json')) {
      try {
        const { rows } = await readOnly(`SELECT ${qi(col.name)} AS v FROM ${qi(t.schema)}.${qi(t.name)} WHERE ${qi(col.name)} IS NOT NULL LIMIT ${SAMPLE_ROWS}`, [], { timeoutMs: 30000 });
        col.json_fields = collectPaths(rows.map(r => (typeof r.v === 'string' ? safeParse(r.v) : r.v)));
      } catch (e) { col.json_fields = []; col.json_error = e.message; }
    }
  }
  const schema = { refreshed_at: new Date().toISOString(), tables: [...tables.values()] };
  setSetting('rc_schema', schema);
  return schema;
}
const safeParse = s => { try { return JSON.parse(s); } catch { return null; } };
const qi = name => '"' + String(name).replace(/"/g, '""') + '"';

/** The last discovered schema (kept in settings so the screen works without hitting the database each time). */
const cachedSchema = () => getSetting('rc_schema', null);

/** Forget the open connection and the discovered schema (after the connection string changes). */
function reset() { if (pool) pool.end().catch(() => {}); pool = null; poolKey = null; setSetting('rc_schema', null); }

module.exports = { reset, readOnly, introspect, cachedSchema, connectionString, collectPaths, qi, SYSTEM_SCHEMAS };
