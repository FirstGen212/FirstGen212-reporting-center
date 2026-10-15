// Turns a saved report definition into one parameterised, read-only SELECT. Nothing typed by a user ever becomes SQL:
// tables and columns must exist in the discovered schema, JSON key paths are restricted to plain names, and every
// value is a bind parameter.
//
// A report definition ("spec"):
//   table:     'public.census_snapshot_history'
//   columns:   [{ field: 'fields.firstName', label: 'First name', agg?: count|count_distinct|sum|avg|min|max }]
//   filters:   [{ field, op, value, value2 }]    match: 'all' | 'any'
//   latest:    { key: 'airtable_id', order: 'captured_at', as_of: '2026-09-30' | '' }   one row per key: its newest version
//   sort:      [{ col: 0, dir: 'asc' | 'desc' }]   (col is a position in columns)
//   limit:     number | null
//   joins:     [{ id: 'j1', table: 'public.census_company_directory', on: { left: 'fields.company.0.id', right: 'airtable_id' },
//                 keep_unmatched: true, latest?: { key, order, as_of } }]   other tables linked in by matching values
// Field ids are a column name, or a JSON column followed by a key path: 'fields.company.0.label'. A field from a linked
// table carries its join id: 'j1:name'.
const { qi } = require('./reportSource');

const MAX_ROWS = Number(process.env.REPORT_MAX_ROWS) || 100000;
const SENSITIVE = /(^|[._ -])(ssn|social_?security|sin|tax_?id|tin|dob|date_?of_?birth|birth_?date|password|passwd|secret|token|api_?key|bank_?account|routing|account_?number|card_?number|cvv)([._ -]|$)/i;

const humanize = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Every field a table offers: its columns, and the keys found inside its JSON columns. */
function fieldsOf(table) {
  const out = [];
  for (const c of table.columns) {
    out.push({ id: c.name, column: c.name, path: [], kind: c.kind, label: humanize(c.name), type: c.type });
    if (c.kind === 'json') for (const j of c.json_fields || []) {
      const segs = j.path.split('.');
      out.push({ id: `${c.name}.${j.path}`, column: c.name, path: segs, kind: j.kind, fill: j.fill,
        label: segs.filter(s => !/^\d+$/.test(s)).map(humanize).join(' › ') || humanize(c.name) });
    }
  }
  return out;
}

/** Resolve a field id against a table, allowing JSON key paths that the sample did not happen to include. */
function resolveField(table, id, known = fieldsOf(table)) {
  const hit = known.find(f => f.id === id);
  if (hit) return hit;
  const col = table.columns.filter(c => c.kind === 'json').sort((a, b) => b.name.length - a.name.length).find(c => String(id).startsWith(c.name + '.'));
  if (col) {
    const segs = String(id).slice(col.name.length + 1).split('.');
    if (segs.length && segs.length <= 6 && segs.every(s => /^[\w\- ]{1,80}$/.test(s))) return { id, column: col.name, path: segs, kind: 'text', label: segs.map(humanize).join(' › '), custom: true };
  }
  const e = new Error(`"${id}" is not a field of ${table.name}`); e.status = 400; throw e;
}

const splitId = id => { const m = /^(j\d{1,2}):(.+)$/.exec(String(id)); return m ? [m[1], m[2]] : [null, String(id)]; };
const tableLabel = t => humanize(t.name);

/** The tables a report reads (its main table plus linked ones) and how to resolve any field id against them. */
function scope(spec, lookup) {
  const base = lookup(spec.table);
  const parts = [{ id: null, alias: 't', table: base }];
  for (const j of spec.joins || []) parts.push({ id: j.id, alias: j.id, table: lookup(j.table), join: j });
  const known = new Map(parts.map(p => [p.id, fieldsOf(p.table)]));
  const resolve = id => {
    const [jid, fid] = splitId(id);
    const p = parts.find(x => x.id === jid);
    if (!p) { const e = new Error(`"${id}" comes from a table that isn't linked to this report`); e.status = 400; throw e; }
    const f = resolveField(p.table, fid, known.get(jid));
    return { ...f, id: String(id), base_id: f.id, alias: p.alias, short: f.label, label: jid ? `${tableLabel(p.table)} › ${f.label}` : f.label };
  };
  return { base, parts, resolve };
}
/** A table lookup from compile/audit options: an explicit lookup, or the single table given. */
function lookupFrom({ lookup, table }) {
  if (lookup) return lookup;
  return key => { if (table && (!key || key === table.key || key === `${table.schema}.${table.name}`)) return table; const e = new Error(`Unknown table "${key}"`); e.status = 400; throw e; };
}

const isHidden = (policy, id) => {
  id = splitId(id)[1];
  const hidden = policy?.hidden || [], shown = policy?.unhidden || [];
  const parts = String(id).split('.');
  for (let i = parts.length; i > 0; i--) { const p = parts.slice(0, i).join('.'); if (hidden.includes(p)) return true; if (shown.includes(p)) return false; }
  return SENSITIVE.test(id);
};

// ---------------------------------------------------------------- expressions
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";
const NUM_RE = "'^\\s*-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*$'";
const DATE_RE = "'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'";

/** SQL for a field: `text` is always a text expression, `typed` is cast to the field's kind (null when it doesn't fit). */
function expr(f, alias = 't') {
  const col = `${alias}.${qi(f.column)}`;
  if (!f.path.length) {
    const text = f.kind === 'text' ? col : `${col}::text`;
    return { text, typed: col, kind: f.kind, raw: col };
  }
  const p = lit('{' + f.path.join(',') + '}');
  const text = `(${col} #>> ${p})`;
  const json = `(${col} #> ${p})`;
  let typed = text;
  if (f.kind === 'number') typed = `(CASE WHEN ${text} ~ ${NUM_RE} THEN ${text}::numeric END)`;
  else if (f.kind === 'date') typed = `(CASE WHEN ${text} ~ ${DATE_RE} THEN left(${text}, 10)::date END)`;
  else if (f.kind === 'boolean') typed = `(CASE lower(${text}) WHEN 'true' THEN true WHEN 'false' THEN false END)`;
  else if (f.kind === 'list') typed = json;
  return { text, typed, kind: f.kind, raw: json };
}

const OPS = {
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'empty', 'not_empty'],
  date: ['on', 'before', 'after', 'between', 'last_days', 'next_days', 'this_month', 'last_month', 'this_year', 'empty', 'not_empty'],
  boolean: ['is_true', 'is_false', 'empty', 'not_empty'],
  list: ['contains', 'not_contains', 'empty', 'not_empty'],
  json: ['contains', 'not_contains', 'empty', 'not_empty'],
};

function emptySQL(e) {
  if (e.kind === 'list') return `(${e.raw} IS NULL OR jsonb_typeof(${e.raw}::jsonb) = 'null' OR ${e.raw}::text IN ('[]', '""'))`;
  if (e.kind === 'json') return `(${e.raw} IS NULL OR ${e.raw}::text IN ('{}', '[]', 'null', '""'))`;
  if (e.kind === 'text') return `(${e.text} IS NULL OR btrim(${e.text}) = '')`;
  return `(${e.typed} IS NULL)`;
}

function compile(spec, { table, lookup, policy, customer = null, today = new Date().toISOString().slice(0, 10), limit, forAudit = null } = {}) {
  if (!spec.table && !table) { const e = new Error('Pick a table to report on'); e.status = 400; throw e; }
  const sc = scope({ ...spec, table: spec.table || table.key }, lookupFrom({ lookup, table }));
  table = sc.base;
  const field = id => {
    const f = sc.resolve(id);
    if (isHidden(policy, f.base_id)) { const e = new Error(`"${f.label}" is restricted and can't be used in reports`); e.status = 403; throw e; }
    return f;
  };
  const params = [];
  const P = v => { params.push(v); return `$${params.length}`; };
  const fill = v => (typeof v === 'string' ? v.replace(/\{\{\s*customer\s*\}\}/gi, customer ?? '').replace(/\{\{\s*today\s*\}\}/gi, today) : v);

  // ---- FROM (each table optionally reduced to the newest row per key, as of a date), then the linked tables
  const source = (tbl, latest, alias, prefix) => {
    const name = `${qi(tbl.schema)}.${qi(tbl.name)}`;
    if (!latest?.key || !latest?.order) return `${name} ${alias}`;
    const kf = field(prefix + latest.key), of = field(prefix + latest.order);
    const k = expr(kf, 't0'), o = expr(of, 't0');
    const asOf = fill(latest.as_of || '');
    const where = asOf ? ` WHERE ${o.kind === 'date' && !of.path.length ? o.raw : o.typed} < (${P(asOf)}::date + INTERVAL '1 day')` : '';
    return `(SELECT DISTINCT ON (${k.text}) t0.* FROM ${name} t0${where} ORDER BY ${k.text}, ${o.typed} DESC NULLS LAST) ${alias}`;
  };
  let from = source(table, spec.latest, 't', '');
  sc.parts.slice(1).forEach((p, i) => {
    const j = p.join;
    if (!j.on?.left || !j.on?.right) { const e = new Error(`Choose how ${tableLabel(p.table)} links to the report`); e.status = 400; throw e; }
    const L = field(j.on.left), R = field(`${p.id}:${j.on.right}`);
    if (L.alias === p.alias || (L.alias !== 't' && sc.parts.findIndex(x => x.alias === L.alias) > i)) { const e = new Error(`${tableLabel(p.table)} must link to a table listed before it`); e.status = 400; throw e; }
    const le = expr(L, L.alias), re = expr(R, R.alias);
    // Plain columns of the same type compare directly (so indexes still help); anything else compares as text.
    const on = !L.path.length && !R.path.length && L.kind === R.kind && L.kind !== 'json' ? `${le.raw} = ${re.raw}` : `${le.text} = ${re.text}`;
    from += ` ${j.keep_unmatched === false ? 'JOIN' : 'LEFT JOIN'} ${source(p.table, j.latest, p.alias, p.id + ':')} ON ${on}`;
  });

  // ---- WHERE
  const conds = [];
  for (const flt of spec.filters || []) {
    if (!flt?.field || !flt.op) continue;
    const f = field(flt.field), e = expr(f, f.alias);
    const allowed = OPS[f.kind] || OPS.text;
    if (!allowed.includes(flt.op)) { const err = new Error(`"${flt.op}" can't be used on ${f.label}`); err.status = 400; throw err; }
    const v = fill(flt.value), v2 = fill(flt.value2);
    const list = () => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean);
    const num = x => { const n = Number(x); if (x === '' || x == null || Number.isNaN(n)) { const err = new Error(`${f.label}: "${x ?? ''}" is not a number`); err.status = 400; throw err; } return n; };
    const day = x => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x || ''))) { const err = new Error(`${f.label}: enter a date as YYYY-MM-DD`); err.status = 400; throw err; } return x; };
    const T = e.typed, X = e.text;
    switch (flt.op) {
      case 'eq': conds.push(f.kind === 'number' ? `${T} = ${P(num(v))}` : `lower(${X}) = lower(${P(String(v ?? ''))})`); break;
      case 'neq': conds.push(f.kind === 'number' ? `${T} IS DISTINCT FROM ${P(num(v))}` : `lower(coalesce(${X}, '')) <> lower(${P(String(v ?? ''))})`); break;
      case 'contains': conds.push(`${f.kind === 'list' || f.kind === 'json' ? e.raw + '::text' : X} ILIKE ${P('%' + String(v ?? '') + '%')}`); break;
      case 'not_contains': conds.push(`coalesce(${f.kind === 'list' || f.kind === 'json' ? e.raw + '::text' : X}, '') NOT ILIKE ${P('%' + String(v ?? '') + '%')}`); break;
      case 'starts_with': conds.push(`${X} ILIKE ${P(String(v ?? '') + '%')}`); break;
      case 'ends_with': conds.push(`${X} ILIKE ${P('%' + String(v ?? ''))}`); break;
      case 'in': conds.push(f.kind === 'number' ? `${T} = ANY(${P(list().map(num))}::numeric[])` : `lower(${X}) = ANY(${P(list().map(s => s.toLowerCase()))}::text[])`); break;
      case 'not_in': conds.push(`NOT (lower(coalesce(${X}, '')) = ANY(${P(list().map(s => s.toLowerCase()))}::text[]))`); break;
      case 'gt': conds.push(`${T} > ${P(num(v))}`); break;
      case 'gte': conds.push(`${T} >= ${P(num(v))}`); break;
      case 'lt': conds.push(`${T} < ${P(num(v))}`); break;
      case 'lte': conds.push(`${T} <= ${P(num(v))}`); break;
      case 'between': conds.push(f.kind === 'date' ? `(${T} >= ${P(day(v))}::date AND ${T} < (${P(day(v2))}::date + INTERVAL '1 day'))` : `${T} BETWEEN ${P(num(v))} AND ${P(num(v2))}`); break;
      case 'on': conds.push(`(${T} >= ${P(day(v))}::date AND ${T} < (${P(day(v))}::date + INTERVAL '1 day'))`); break;
      case 'before': conds.push(`${T} < ${P(day(v))}::date`); break;
      case 'after': conds.push(`${T} >= (${P(day(v))}::date + INTERVAL '1 day')`); break;
      case 'last_days': conds.push(`(${T} >= (${P(today)}::date - ${P(num(v))}::int) AND ${T} < (${P(today)}::date + INTERVAL '1 day'))`); break;
      case 'next_days': conds.push(`(${T} >= ${P(today)}::date AND ${T} < (${P(today)}::date + ${P(num(v))}::int + 1))`); break;
      case 'this_month': conds.push(`(${T} >= date_trunc('month', ${P(today)}::date) AND ${T} < date_trunc('month', ${P(today)}::date) + INTERVAL '1 month')`); break;
      case 'last_month': conds.push(`(${T} >= date_trunc('month', ${P(today)}::date) - INTERVAL '1 month' AND ${T} < date_trunc('month', ${P(today)}::date))`); break;
      case 'this_year': conds.push(`(${T} >= date_trunc('year', ${P(today)}::date) AND ${T} < date_trunc('year', ${P(today)}::date) + INTERVAL '1 year')`); break;
      case 'is_true': conds.push(`${T} IS TRUE`); break;
      case 'is_false': conds.push(`${T} IS FALSE`); break;
      case 'empty': conds.push(emptySQL(e)); break;
      case 'not_empty': conds.push(`NOT ${emptySQL(e)}`); break;
    }
  }
  let where = conds.length ? `(${conds.join(spec.match === 'any' ? ' OR ' : ' AND ')})` : '';
  if (spec.customer_field && customer != null && customer !== '') {
    const cf = field(spec.customer_field);
    const c = `lower(${expr(cf, cf.alias).text}) = lower(${P(String(customer))})`;
    where = where ? `${where} AND ${c}` : c;
  }

  // ---- SELECT
  let cols = (spec.columns || []).filter(c => c?.field);
  if (forAudit) cols = forAudit.map(id => ({ field: id }));            // row-level, no aggregation
  if (!cols.length) { const e = new Error('Add at least one column'); e.status = 400; throw e; }
  const AGG = { count: 'count', count_distinct: 'count', sum: 'sum', avg: 'avg', min: 'min', max: 'max' };
  const out = [];
  const select = cols.map((c, i) => {
    const agg = forAudit ? null : (c.agg && AGG[c.agg] ? c.agg : null);
    if (c.field === '*') { out.push({ key: `c${i}`, label: c.label || 'Count', kind: 'number', agg: 'count', field: '*' }); return `count(*) AS "c${i}"`; }
    const f = field(c.field), e = expr(f, f.alias);
    let sql, kind = f.kind;
    if (agg === 'count') { sql = `count(${e.raw})`; kind = 'number'; }
    else if (agg === 'count_distinct') { sql = `count(DISTINCT ${e.text})`; kind = 'number'; }
    else if (agg === 'sum' || agg === 'avg') { if (f.kind !== 'number') { const err = new Error(`${f.label} isn't a number, so it can't be ${agg === 'sum' ? 'summed' : 'averaged'}`); err.status = 400; throw err; } sql = `${agg}(${e.typed})`; }
    else if (agg) sql = `${agg}(${f.kind === 'number' || f.kind === 'date' ? e.typed : e.text})`;
    else sql = f.kind === 'list' || f.kind === 'json' ? e.raw : (f.kind === 'text' ? e.text : e.typed);
    const aggLabel = { count: 'Count of ', count_distinct: 'Distinct ', sum: 'Total ', avg: 'Average ', min: 'Min ', max: 'Max ' }[agg] || '';
    out.push({ key: `c${i}`, label: c.label || aggLabel + (f.short || f.label), kind, agg, field: f.id });
    return `${sql} AS "c${i}"`;
  });
  const grouped = out.some(c => c.agg);
  const groupBy = grouped ? out.map((c, i) => (c.agg ? null : i + 1)).filter(Boolean) : [];

  const order = forAudit ? [] : (spec.sort || []).filter(s => Number.isInteger(Number(s.col)) && out[Number(s.col)])
    .map(s => `"c${Number(s.col)}" ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  const cap = Math.min(MAX_ROWS, Number(limit) || MAX_ROWS, Number(spec.limit) || MAX_ROWS);
  const sql = `SELECT ${select.join(', ')} FROM ${from}${where ? ` WHERE ${where}` : ''}`
    + (groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : '')
    + (order.length ? ` ORDER BY ${order.join(', ')}` : '')
    + ` LIMIT ${cap + 1}`;
  return { sql, params, columns: out, cap };
}

// Values as they come back from Postgres → plain JSON-friendly values.
function normalizeRows(rows, columns) {
  return rows.map(r => columns.map(c => {
    let v = r[c.key];
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
    if (c.kind === 'number' && typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }));
}

module.exports = { compile, normalizeRows, fieldsOf, resolveField, isHidden, scope, expr, lookupFrom, splitId, tableLabel, OPS, MAX_ROWS, humanize };
