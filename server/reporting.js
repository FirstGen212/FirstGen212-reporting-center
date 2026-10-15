// Reports on the core Supabase database: ad-hoc and saved reports, report types and customer reports,
// exports (CSV / Excel / PDF), scheduled email delivery on any cadence, expiring external share links, and a
// data audit of the fields each export needs.
const crypto = require('crypto');
const { db, all, get, run, J, getSetting, setSetting, audit: auditLog } = require('./db');
const perms = require('./perms');
const source = require('./reportSource');
const Q = require('./reportQuery');
const X = require('./reportExport');
const A = require('./reportAudit');
const cron = require('./reportCron');
const mail = require('./mail');
const { tz, todayISO } = require('./time');

db.exec(`
CREATE TABLE IF NOT EXISTS rc_reports (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  kind TEXT NOT NULL DEFAULT 'report',       -- report | type (a template that customer reports are made from)
  type_id INTEGER REFERENCES rc_reports(id) ON DELETE SET NULL,
  customer TEXT,                             -- customer reports: the value matched against the type's customer field
  spec TEXT NOT NULL DEFAULT '{}', required TEXT NOT NULL DEFAULT '[]',
  audit_mode TEXT NOT NULL DEFAULT 'warn',   -- off | warn | block
  default_format TEXT DEFAULT 'xlsx',
  owner_id INTEGER REFERENCES users(id), shared INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rc_schedules (
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES rc_reports(id) ON DELETE CASCADE,
  name TEXT, customer TEXT, cadence TEXT NOT NULL DEFAULT '{}', cron TEXT NOT NULL,
  recipients TEXT NOT NULL, cc TEXT, subject TEXT, message TEXT, formats TEXT NOT NULL DEFAULT '["xlsx"]',
  skip_empty INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
  next_run_at TEXT, last_run_at TEXT, last_status TEXT, last_error TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rc_runs (
  id INTEGER PRIMARY KEY, report_id INTEGER, schedule_id INTEGER, share_id INTEGER, trigger TEXT, format TEXT, customer TEXT,
  rows INTEGER, status TEXT, error TEXT, audit TEXT, user_id INTEGER, ms INTEGER, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rc_runs_report ON rc_runs(report_id, id);
CREATE TABLE IF NOT EXISTS rc_shares (
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES rc_reports(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, label TEXT, customer TEXT,
  mode TEXT NOT NULL DEFAULT 'snapshot',     -- snapshot (data frozen when shared) | live (re-run on each visit)
  snapshot TEXT, formats TEXT NOT NULL DEFAULT '["xlsx","csv","pdf"]',
  expires_at TEXT NOT NULL, revoked_at TEXT, views INTEGER DEFAULT 0, last_viewed_at TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------------------------------------------------------------- permissions
const can = (req, cap) => perms.can(req.perms, cap);
const httpErr = (status, msg, extra) => Object.assign(new Error(msg), { status }, extra || {});

// ---------------------------------------------------------------- data policy (which tables and fields are reportable)
// tables: null means every table in the "public" schema. hidden/unhidden: field ids (a JSON column hides all its keys).
// role_tables: { roleId: [tableKeys] } narrows a role to some tables; roles not listed see every enabled table.
const policy = () => ({ tables: null, hidden: [], unhidden: [], role_tables: {}, ...getSetting('rc_policy', {}) });

async function schema({ refresh = false } = {}) {
  let s = source.cachedSchema();
  if (!s || refresh) s = await source.introspect();
  return s;
}
function enabledTables(s, pol = policy()) {
  return (s?.tables || []).filter(t => (pol.tables ? pol.tables.includes(t.key) : t.schema === 'public'));
}
function tablesFor(req, s) {
  const pol = policy();
  let list = enabledTables(s, pol);
  if (!req.perms.is_admin && req.user.role_id && Array.isArray(pol.role_tables?.[req.user.role_id])) list = list.filter(t => pol.role_tables[req.user.role_id].includes(t.key));
  return list;
}
async function tableFor(req, key) {
  const t = tablesFor(req, await schema()).find(x => x.key === key);
  if (!t) throw httpErr(403, `You don't have access to the table "${key}", or it isn't enabled for reporting`);
  return t;
}
const publicFields = t => { const pol = policy(); return Q.fieldsOf(t).filter(f => !Q.isHidden(pol, f.id)).map(f => ({ id: f.id, label: f.label, kind: f.kind, fill: f.fill, json: f.path.length > 0 })); };

// ---------------------------------------------------------------- reports
const rowOut = r => r && ({ ...r, spec: J(r.spec, {}), required: J(r.required, []), shared: !!r.shared });
const canSee = (req, r) => r && (req.perms.is_admin || r.owner_id === req.user.id || r.shared);
const canEdit = (req, r) => r && can(req, 'build_reports') && (req.perms.is_admin || r.owner_id === req.user.id || r.shared);
function loadReport(req, id, { edit = false } = {}) {
  const r = rowOut(get('SELECT * FROM rc_reports WHERE id = ?', Number(id)));
  if (!r || !canSee(req, r)) throw httpErr(404, 'Report not found');
  if (edit && !canEdit(req, r)) throw httpErr(403, 'You can view this report but not change it');
  return r;
}
/** What actually runs: a customer report takes its definition, required fields and audit mode from its type. */
function effective(r) {
  if (r.type_id) {
    const t = rowOut(get('SELECT * FROM rc_reports WHERE id = ?', r.type_id));
    if (t) return { ...r, spec: t.spec, required: t.required, audit_mode: t.audit_mode, type_name: t.name };
  }
  return r;
}

function cleanSpec(spec = {}) {
  const s = {
    table: String(spec.table || ''),
    columns: (spec.columns || []).filter(c => c?.field).slice(0, 60).map(c => ({ field: String(c.field), label: c.label ? String(c.label).slice(0, 120) : undefined, agg: c.agg || undefined })),
    filters: (spec.filters || []).filter(f => f?.field && f.op).slice(0, 40).map(f => ({ field: String(f.field), op: String(f.op), value: f.value ?? '', value2: f.value2 ?? '' })),
    match: spec.match === 'any' ? 'any' : 'all',
    latest: spec.latest?.key && spec.latest?.order ? { key: String(spec.latest.key), order: String(spec.latest.order), as_of: String(spec.latest.as_of || '') } : null,
    sort: (spec.sort || []).slice(0, 5).map(s => ({ col: Number(s.col), dir: s.dir === 'desc' ? 'desc' : 'asc' })).filter(s => Number.isInteger(s.col)),
    limit: Number(spec.limit) > 0 ? Math.min(Q.MAX_ROWS, Number(spec.limit)) : null,
    customer_field: spec.customer_field ? String(spec.customer_field) : null,
    audit_ids: (spec.audit_ids || []).filter(Boolean).slice(0, 3).map(String),
  };
  return s;
}
const cleanRequired = list => (list || []).filter(r => r?.field).slice(0, 60).map(r => ({ field: String(r.field), label: r.label ? String(r.label).slice(0, 120) : undefined,
  rule: A.RULES[r.rule] ? r.rule : 'required', arg: r.arg ? String(r.arg).slice(0, 500) : undefined, severity: r.severity === 'warning' ? 'warning' : 'critical' }));

const today = () => todayISO();
async function execute(req, spec, { customer = null, limit } = {}) {
  const table = await tableFor(req, spec.table);
  const q = Q.compile(spec, { table, policy: policy(), customer, today: today(), limit });
  const started = Date.now();
  const res = await source.readOnly(q.sql, q.params);
  const truncated = res.rows.length > q.cap;
  const rows = Q.normalizeRows(res.rows.slice(0, q.cap), q.columns);
  return { columns: q.columns.map(c => ({ label: c.label, kind: c.kind, field: c.field, agg: c.agg || null })), rows, truncated, ms: Date.now() - started, sql: req.perms.is_admin ? { text: q.sql, params: q.params } : undefined };
}
async function runAudit(req, r, customer) {
  const table = await tableFor(req, r.spec.table);
  return A.audit(r.spec, r.required, { table, policy: policy(), customer, today: today() });
}
function logRun(row) {
  run('INSERT INTO rc_runs(report_id, schedule_id, share_id, trigger, format, customer, rows, status, error, audit, user_id, ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    row.report_id || null, row.schedule_id || null, row.share_id || null, row.trigger, row.format || null, row.customer || null, row.rows ?? null,
    row.status, row.error || null, row.audit ? JSON.stringify(row.audit) : null, row.user_id || null, row.ms ?? null);
}
const auditBrief = a => a && { passed: a.passed, checked_rows: a.checked_rows, rows_with_issues: a.rows_with_issues, critical_rows: a.critical_rows, summary: A.summarize(a) };

/** Run the audit when the report asks for it; throws 409 when critical problems hold the export back. */
async function gate(req, r, customer, { override = false } = {}) {
  if (r.audit_mode === 'off' || !r.required?.length) return null;
  const a = await runAudit(req, r, customer);
  if (!a.passed && r.audit_mode === 'block') {
    if (override && (req.perms.is_admin || can(req, 'manage_reporting_data'))) {
      auditLog({ entity: 'report', entity_id: r.id || 0, field: 'audit_override', new_value: `Exported despite: ${A.summarize(a)}`, user_id: req.user.id });
      return a;
    }
    throw httpErr(409, `Export held back: ${A.summarize(a)} Fix the data, or open the Data audit tab to see which rows.`, { audit: auditBrief(a) });
  }
  return a;
}
const subtitleOf = (r, customer) => [r.type_name || null, customer ? `Customer: ${customer}` : null, r.description || null].filter(Boolean).join(' · ');
async function buildFile(req, r, fmt, customer, a) {
  const result = await execute(req, r.spec, { customer });
  const notes = [];
  if (result.truncated) notes.push(`Limited to the first ${result.rows.length.toLocaleString()} rows.`);
  if (a && !a.passed) notes.push(`Data audit: ${A.summarize(a)}`);
  const file = await X.render(result, fmt, { title: r.name, subtitle: subtitleOf(r, customer), suffix: customer, notes, brand: require('./brand').brandFor(null) });
  return { file, result };
}

// ---------------------------------------------------------------- scheduled delivery
const userEmails = () => new Set(all("SELECT lower(email) e FROM users WHERE active = 1 AND email IS NOT NULL AND email <> ''").map(u => u.e));
const splitEmails = v => [...new Set(String(v || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean))];
function checkRecipients(req, list) {
  const bad = list.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e));
  if (bad.length) throw httpErr(400, `Not an email address: ${bad.join(', ')}`);
  const internal = userEmails();
  const outside = list.filter(e => !internal.has(e.toLowerCase()));
  if (outside.length && !can(req, 'share_reports')) throw httpErr(403, `Sending to people outside the app needs the "share reports" permission: ${outside.join(', ')}`);
}
const schedOut = s => s && ({ ...s, cadence: J(s.cadence, {}), formats: J(s.formats, ['xlsx']), enabled: !!s.enabled, skip_empty: !!s.skip_empty, describe: cron.describeCadence(J(s.cadence, {})) });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function emailHTML({ title, message, result, a, customer, held }) {
  const cols = result ? result.columns.slice(0, 8) : [];
  const preview = result && result.rows.length ? `<table style="border-collapse:collapse;font-size:12px;margin-top:12px">
    <tr>${cols.map(c => `<th style="text-align:left;padding:4px 8px;background:#2e5bff;color:#fff">${esc(c.label)}</th>`).join('')}</tr>
    ${result.rows.slice(0, 10).map((r, i) => `<tr style="background:${i % 2 ? '#f3f5fb' : '#fff'}">${cols.map((c, j) => `<td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(X.display(r[j], c.kind))}</td>`).join('')}</tr>`).join('')}
  </table>${result.rows.length > 10 || result.columns.length > 8 ? '<p style="color:#666;font-size:12px">Preview only. The full report is attached.</p>' : ''}` : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#111;max-width:720px">
    <h2 style="margin:0 0 4px">${esc(title)}</h2>
    <p style="color:#666;margin:0 0 12px">${customer ? `Customer: ${esc(customer)} · ` : ''}${result ? `${result.rows.length.toLocaleString()} row(s)` : ''} · ${esc(new Date().toLocaleString('en-US', { timeZone: tz(), dateStyle: 'medium', timeStyle: 'short' }))}</p>
    ${held ? `<p style="background:#fff4e5;border:1px solid #f0c36d;padding:10px;border-radius:6px"><b>This report was held back.</b> ${esc(A.summarize(a))} The list of rows to fix is attached. It goes out on the next scheduled run once the data is complete.</p>` : ''}
    ${!held && a && !a.passed ? `<p style="background:#fff4e5;border:1px solid #f0c36d;padding:10px;border-radius:6px">Data audit: ${esc(A.summarize(a))}</p>` : ''}
    ${message ? `<p style="white-space:pre-wrap">${esc(message)}</p>` : ''}
    ${held ? '' : preview}
    <p style="color:#999;font-size:11px;margin-top:20px">Sent by the Reporting Center. Ask the report owner to change or stop this schedule.</p></div>`;
}

// A scheduled send runs as the person who created the schedule, with their current permissions.
function asUser(userId) {
  const user = get('SELECT * FROM users WHERE id = ? AND active = 1', userId);
  if (!user) throw new Error('The person who created this schedule is no longer active. Reassign or delete the schedule.');
  return { user, perms: perms.effectivePerms(user) };
}
async function deliver(schedule, { trigger = 'schedule', actor = null } = {}) {
  const s = schedOut(schedule);
  const started = Date.now();
  let status = 'sent', error = null, rows = null, a = null;
  try {
    const req = asUser(s.created_by);
    if (!perms.can(req.perms, 'schedule_reports')) throw new Error(`${req.user.name} no longer has permission to schedule reports`);
    const r = effective(rowOut(get('SELECT * FROM rc_reports WHERE id = ?', s.report_id)));
    if (!r) throw new Error('The report was deleted');
    const customer = s.customer || r.customer || null;
    if (r.audit_mode !== 'off' && r.required?.length) a = await runAudit(req, r, customer);
    const to = splitEmails(s.recipients), cc = splitEmails(s.cc);
    const subject = (s.subject || r.name).replace(/\{\{\s*date\s*\}\}/gi, today()).replace(/\{\{\s*customer\s*\}\}/gi, customer || '');
    if (a && !a.passed && r.audit_mode === 'block') {
      status = 'held';
      const t = A.issuesTable(a);
      const owner = get('SELECT email FROM users WHERE id = ?', s.created_by)?.email;
      await mail.sendEmail({ to: owner || to, subject: `Held: ${subject}`, kind: 'report_held', meta: { schedule_id: s.id, report_id: r.id },
        html: emailHTML({ title: r.name, message: null, result: null, a, customer, held: true }),
        attachments: [{ filename: X.fileName(`${r.name} data to fix`, 'xlsx', customer), content: await X.toXLSX(t, { title: `${r.name}: data to fix`, subtitle: A.summarize(a) }) }] });
    } else {
      const result = await execute(req, r.spec, { customer });
      rows = result.rows.length;
      if (!rows && s.skip_empty) status = 'skipped';
      else {
        const notes = [...(result.truncated ? [`Limited to the first ${rows.toLocaleString()} rows.`] : []), ...(a && !a.passed ? [`Data audit: ${A.summarize(a)}`] : [])];
        const attachments = [];
        for (const fmt of s.formats) { const f = await X.render(result, fmt, { title: r.name, subtitle: subtitleOf(r, customer), suffix: customer, notes }); attachments.push({ filename: f.filename, content: f.content }); }
        const id = await mail.sendEmail({ to, cc, subject, kind: 'scheduled_report', meta: { schedule_id: s.id, report_id: r.id }, attachments,
          html: emailHTML({ title: r.name, message: s.message, result, a, customer }) });
        const out = get('SELECT status, error FROM outbox WHERE id = ?', id);
        if (out?.status === 'failed') { status = 'failed'; error = out.error; }
        else if (out?.status === 'dry_run') status = 'dry_run';
      }
    }
  } catch (e) { status = 'failed'; error = e.message; console.error('[reporting] schedule', s.id, e.message); }
  const now = new Date();
  let next = null;
  try { next = cron.nextRun(s.cron, tz(), now.getTime())?.toISOString() || null; } catch {}
  run('UPDATE rc_schedules SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = CASE WHEN ? = \'manual\' THEN next_run_at ELSE ? END WHERE id = ?',
    now.toISOString(), status, error, trigger, next, s.id);
  logRun({ report_id: s.report_id, schedule_id: s.id, trigger, format: s.formats.join(','), customer: s.customer, rows, status, error, audit: auditBrief(a), user_id: actor, ms: Date.now() - started });
  return { status, error, rows, audit: auditBrief(a) };
}
let ticking = false;
/** Called every minute by the app's scheduler: sends every enabled schedule whose time has come (once, even after downtime). */
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = all("SELECT * FROM rc_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at", new Date().toISOString());
    for (const s of due) await deliver(s);
  } finally { ticking = false; }
}

// ---------------------------------------------------------------- external share links
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
// APP_URL or the Settings value wins (e.g. a custom domain); otherwise Render's own onrender.com address.
const appUrl = () => (process.env.APP_URL || getSetting('app_url', '') || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4400').replace(/\/$/, '');
function shareFor(token) {
  if (!/^[\w-]{20,80}$/.test(String(token || ''))) return null;
  const s = get('SELECT * FROM rc_shares WHERE token_hash = ?', hashToken(token));
  if (!s || s.revoked_at || s.expires_at < new Date().toISOString()) return null;
  return s;
}
async function shareData(s) {
  if (s.mode === 'snapshot') return J(s.snapshot, { columns: [], rows: [] });
  const r = effective(rowOut(get('SELECT * FROM rc_reports WHERE id = ?', s.report_id)));
  const req = asUser(s.created_by);
  if (!perms.can(req.perms, 'share_reports')) throw new Error('This link is no longer active.');
  const out = await execute(req, r.spec, { customer: s.customer });
  return { columns: out.columns, rows: out.rows, truncated: out.truncated, at: new Date().toISOString() };
}
function sharePage(s, r, data) {
  const brand = require('./brand').brandFor(null);
  const fm = J(s.formats, []);
  const shown = data.rows.slice(0, 500);
  const label = { xlsx: 'Excel', csv: 'CSV', pdf: 'PDF' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(s.label || r.name)}</title><style>
:root{--bg:#f6f7fb;--panel:#fff;--text:#111;--muted:#666;--line:#e3e6ef;--accent:#2e5bff;--stripe:#f3f5fb}
@media (prefers-color-scheme: dark){:root{--bg:#0f1220;--panel:#171b2e;--text:#e8eaf3;--muted:#9aa0b8;--line:#2a3050;--accent:#6d8bff;--stripe:#1c2138}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,Arial,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:24px 16px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.btns{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
a.btn{display:inline-block;padding:7px 12px;border-radius:7px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600}
.scroll{overflow:auto;max-height:70vh;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:13px}
th{position:sticky;top:0;background:var(--accent);color:#fff;text-align:left;padding:6px 10px;white-space:nowrap}td{padding:5px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
tr:nth-child(even) td{background:var(--stripe)}td.n{text-align:right}</style></head><body><div class="wrap"><div class="card">
<div class="muted">${esc(brand.name)}</div><h1>${esc(s.label || r.name)}</h1>
<div class="muted">${s.customer ? `Customer: ${esc(s.customer)} · ` : ''}${data.rows.length.toLocaleString()} row(s) · data as of ${esc(new Date(data.at || s.created_at + 'Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))} · link expires ${esc(s.expires_at.slice(0, 10))}</div>
${fm.length ? `<div class="btns">${fm.map(f => `<a class="btn" href="${esc(s._path)}/download.${f}">Download ${label[f] || f}</a>`).join('')}</div>` : ''}
<div class="scroll"><table><thead><tr>${data.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
${shown.map(row => `<tr>${row.map((v, i) => `<td${data.columns[i].kind === 'number' ? ' class="n"' : ''}>${esc(X.display(v, data.columns[i].kind))}</td>`).join('')}</tr>`).join('')}
</tbody></table></div>${data.rows.length > shown.length ? `<p class="muted">Showing ${shown.length} of ${data.rows.length.toLocaleString()} rows. Download the file for all of them.</p>` : ''}
</div></div></body></html>`;
}

// ---------------------------------------------------------------- routes
function mount(app, { requireUser, requireCap, wrap }) {
  const view = [requireUser, requireCap('view_reporting')];
  const build = [requireUser, requireCap('build_reports')];
  const send = (res, f) => { res.setHeader('Content-Type', f.mime); res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`); res.send(f.content); };

  app.get('/api/rc/meta', ...view, wrap(async (req, res) => {
    const configured = !!source.connectionString();
    let s = null, error = null;
    if (configured) { try { s = await schema(); } catch (e) { error = e.message; } }
    const tables = s ? tablesFor(req, s).map(t => ({ key: t.key, schema: t.schema, name: t.name, view: t.view, est_rows: t.est_rows, fields: publicFields(t) })) : [];
    const reports = all('SELECT r.*, u.name AS owner_name, t.name AS type_name FROM rc_reports r LEFT JOIN users u ON u.id = r.owner_id LEFT JOIN rc_reports t ON t.id = r.type_id ORDER BY r.kind DESC, r.name')
      .map(rowOut).filter(r => canSee(req, r)).map(r => ({ ...r, can_edit: !!canEdit(req, r) }));
    res.json({
      connection: { configured, via: process.env.REPORTING_DB_URL ? 'REPORTING_DB_URL' : 'settings', error, refreshed_at: s?.refreshed_at || null },
      caps: { build: can(req, 'build_reports'), schedule: can(req, 'schedule_reports'), share: can(req, 'share_reports'), manage: can(req, 'manage_reporting_data'), admin: !!req.perms.is_admin },
      tables, reports, ops: Q.OPS, rules: A.RULES, max_rows: Q.MAX_ROWS, pdf_max_rows: X.PDF_MAX_ROWS, timezone: tz(),
      internal_emails: [...userEmails()],
    });
  }));

  app.post('/api/rc/preview', ...view, wrap(async (req, res) => {
    const spec = cleanSpec(req.body.spec);
    res.json(await execute(req, spec, { customer: req.body.customer || null, limit: Math.min(1000, Number(req.body.limit) || 200) }));
  }));
  app.post('/api/rc/values', ...view, wrap(async (req, res) => {
    const table = await tableFor(req, String(req.body.table || ''));
    const spec = cleanSpec({ table: table.key, latest: req.body.latest, columns: [{ field: String(req.body.field) }, { field: '*', agg: 'count' }],
      filters: req.body.q ? [{ field: String(req.body.field), op: 'contains', value: String(req.body.q) }] : [], sort: [{ col: 1, dir: 'desc' }], limit: 300 });
    const out = await execute(req, spec, { limit: 300 });
    res.json(out.rows.filter(r => r[0] != null && r[0] !== '').map(r => ({ value: r[0], count: r[1] })));
  }));

  // reports & report types
  app.get('/api/rc/reports/:id', ...view, (req, res) => { const r = loadReport(req, req.params.id); res.json({ ...r, can_edit: !!canEdit(req, r) }); });
  const saveBody = (req, cur = {}) => {
    const b = req.body;
    const kind = b.kind === 'type' ? 'type' : 'report';
    const type_id = kind === 'report' && b.type_id ? Number(b.type_id) : null;
    if (type_id) { const t = get("SELECT * FROM rc_reports WHERE id = ? AND kind = 'type'", type_id); if (!t || !canSee(req, rowOut(t))) throw httpErr(400, 'That report type no longer exists'); }
    const name = String(b.name ?? cur.name ?? '').trim();
    if (!name) throw httpErr(400, 'Give the report a name');
    return { name: name.slice(0, 160), description: b.description ? String(b.description).slice(0, 1000) : null, kind, type_id,
      customer: b.customer ? String(b.customer).slice(0, 300) : null, spec: type_id ? {} : cleanSpec(b.spec), required: type_id ? [] : cleanRequired(b.required),
      audit_mode: ['off', 'warn', 'block'].includes(b.audit_mode) ? b.audit_mode : 'warn', default_format: X.FORMATS[b.default_format] ? b.default_format : 'xlsx', shared: b.shared === false ? 0 : 1 };
  };
  const validate = async (req, v) => {
    if (v.type_id) return;
    const table = await tableFor(req, v.spec.table);
    Q.compile(v.spec, { table, policy: policy() });
    if (v.kind === 'type' && !v.spec.customer_field) throw httpErr(400, 'A report type needs a customer field, so customer reports can be made from it');
    for (const r of v.required) Q.resolveField(table, r.field);
  };
  app.post('/api/rc/reports', ...build, wrap(async (req, res) => {
    const v = saveBody(req); await validate(req, v);
    const id = Number(run('INSERT INTO rc_reports(name, description, kind, type_id, customer, spec, required, audit_mode, default_format, owner_id, shared) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      v.name, v.description, v.kind, v.type_id, v.customer, JSON.stringify(v.spec), JSON.stringify(v.required), v.audit_mode, v.default_format, req.user.id, v.shared).lastInsertRowid);
    auditLog({ entity: 'report', entity_id: id, field: 'created', new_value: `${v.kind === 'type' ? 'Report type' : 'Report'} "${v.name}"`, user_id: req.user.id });
    res.json(rowOut(get('SELECT * FROM rc_reports WHERE id = ?', id)));
  }));
  app.put('/api/rc/reports/:id', ...build, wrap(async (req, res) => {
    const cur = loadReport(req, req.params.id, { edit: true });
    const v = saveBody(req, cur); await validate(req, v);
    if (cur.kind === 'type' && v.kind !== 'type' && get('SELECT 1 FROM rc_reports WHERE type_id = ?', cur.id)) throw httpErr(400, 'Customer reports use this report type, so it has to stay a type');
    run("UPDATE rc_reports SET name=?, description=?, kind=?, type_id=?, customer=?, spec=?, required=?, audit_mode=?, default_format=?, shared=?, updated_at=datetime('now') WHERE id=?",
      v.name, v.description, v.kind, v.type_id, v.customer, JSON.stringify(v.spec), JSON.stringify(v.required), v.audit_mode, v.default_format, v.shared, cur.id);
    auditLog({ entity: 'report', entity_id: cur.id, field: 'updated', new_value: v.name, user_id: req.user.id });
    res.json(rowOut(get('SELECT * FROM rc_reports WHERE id = ?', cur.id)));
  }));
  app.delete('/api/rc/reports/:id', ...build, wrap(async (req, res) => {
    const cur = loadReport(req, req.params.id, { edit: true });
    const users = all('SELECT name FROM rc_reports WHERE type_id = ?', cur.id);
    if (users.length) throw httpErr(400, `Delete the customer reports made from this type first: ${users.map(u => u.name).join(', ')}`);
    run('DELETE FROM rc_reports WHERE id = ?', cur.id);
    auditLog({ entity: 'report', entity_id: cur.id, field: 'deleted', old_value: cur.name, user_id: req.user.id });
    res.json({ ok: true });
  }));
  // Customer reports for many customers at once, from a type.
  app.post('/api/rc/reports/:id/customers', ...build, wrap(async (req, res) => {
    const t = loadReport(req, req.params.id);
    if (t.kind !== 'type') throw httpErr(400, 'Customer reports are made from a report type');
    const list = [...new Set((req.body.customers || []).map(c => String(c).trim()).filter(Boolean))].slice(0, 500);
    let created = 0;
    for (const c of list) {
      if (get('SELECT 1 FROM rc_reports WHERE type_id = ? AND customer = ?', t.id, c)) continue;
      run('INSERT INTO rc_reports(name, kind, type_id, customer, audit_mode, default_format, owner_id, shared) VALUES(?,?,?,?,?,?,?,1)', `${t.name}: ${c}`.slice(0, 160), 'report', t.id, c, t.audit_mode, t.default_format, req.user.id);
      created++;
    }
    res.json({ created, skipped: list.length - created });
  }));

  app.post('/api/rc/reports/:id/run', ...view, wrap(async (req, res) => {
    const r = effective(loadReport(req, req.params.id));
    res.json(await execute(req, r.spec, { customer: req.body.customer || r.customer || null, limit: Math.min(1000, Number(req.body.limit) || 200) }));
  }));
  app.get('/api/rc/reports/:id/export', ...view, wrap(async (req, res) => {
    const r = effective(loadReport(req, req.params.id));
    const fmt = String(req.query.format || r.default_format || 'xlsx');
    const customer = req.query.customer || r.customer || null;
    const started = Date.now();
    const a = await gate(req, r, customer, { override: req.query.override === '1' });
    const { file, result } = await buildFile(req, r, fmt, customer, a);
    logRun({ report_id: r.id, trigger: 'export', format: fmt, customer, rows: result.rows.length, status: 'ok', audit: auditBrief(a), user_id: req.user.id, ms: Date.now() - started });
    send(res, file);
  }));
  // One file per customer, zipped: every customer report made from a type, or every value of the customer field.
  app.get('/api/rc/reports/:id/export-customers', ...view, wrap(async (req, res) => {
    const r = effective(loadReport(req, req.params.id));
    if (!r.spec.customer_field) throw httpErr(400, 'Set a customer field on this report first');
    const fmt = String(req.query.format || r.default_format || 'xlsx');
    let customers = r.kind === 'type' ? all('SELECT customer FROM rc_reports WHERE type_id = ? AND customer IS NOT NULL', r.id).map(x => x.customer) : [];
    if (!customers.length) {
      const vals = await execute(req, cleanSpec({ table: r.spec.table, latest: r.spec.latest, columns: [{ field: r.spec.customer_field }, { field: '*', agg: 'count' }] }), { limit: 1000 });
      customers = vals.rows.map(x => x[0]).filter(v => v != null && v !== '');
    }
    if (customers.length > 300) throw httpErr(400, `That's ${customers.length} customers. Narrow it to 300 or fewer with a filter.`);
    const files = [], held = [];
    for (const c of customers) {
      try { const a = await gate(req, r, c); files.push((await buildFile(req, r, fmt, c, a)).file); }
      catch (e) { if (e.status === 409) held.push(`${c}: ${e.audit?.summary || e.message}`); else throw e; }
    }
    if (held.length) files.push({ filename: 'HELD-BACK.txt', content: Buffer.from(`These customers were held back by the data audit:\r\n\r\n${held.join('\r\n')}\r\n`) });
    logRun({ report_id: r.id, trigger: 'export_customers', format: fmt, rows: files.length, status: held.length ? 'partial' : 'ok', user_id: req.user.id });
    send(res, { filename: X.fileName(r.name + ' by customer', fmt).replace(/\.\w+$/, '.zip'), mime: 'application/zip', content: await X.zip(files) });
  }));
  // Unsaved report straight from the builder.
  app.post('/api/rc/export', ...view, wrap(async (req, res) => {
    const r = { id: null, name: String(req.body.name || 'Report'), spec: cleanSpec(req.body.spec), required: cleanRequired(req.body.required), audit_mode: ['off', 'warn', 'block'].includes(req.body.audit_mode) ? req.body.audit_mode : 'warn' };
    const fmt = String(req.body.format || 'xlsx');
    const a = await gate(req, r, req.body.customer || null, { override: !!req.body.override });
    const { file, result } = await buildFile(req, r, fmt, req.body.customer || null, a);
    logRun({ trigger: 'export', format: fmt, rows: result.rows.length, status: 'ok', user_id: req.user.id });
    send(res, file);
  }));

  // data audit
  app.post('/api/rc/audit', ...view, wrap(async (req, res) => {
    let r;
    if (req.body.report_id) r = effective(loadReport(req, req.body.report_id));
    else r = { spec: cleanSpec(req.body.spec), required: cleanRequired(req.body.required) };
    const a = await runAudit(req, r, req.body.customer || r.customer || null);
    if (req.body.report_id) logRun({ report_id: r.id, trigger: 'audit', customer: req.body.customer || r.customer, rows: a.checked_rows, status: a.passed ? 'passed' : 'issues', audit: auditBrief(a), user_id: req.user.id, ms: a.ms });
    res.json({ ...a, summary: A.summarize(a) });
  }));
  app.post('/api/rc/audit/export', ...view, wrap(async (req, res) => {
    let r;
    if (req.body.report_id) r = effective(loadReport(req, req.body.report_id));
    else r = { name: req.body.name || 'Report', spec: cleanSpec(req.body.spec), required: cleanRequired(req.body.required) };
    const a = await runAudit(req, r, req.body.customer || r.customer || null);
    const t = A.issuesTable(a);
    const fmt = req.body.format === 'csv' ? 'csv' : 'xlsx';
    const extra = [
      { name: 'Checks', columns: ['Field', 'Check', 'Severity', 'Missing', 'Invalid', '% OK'].map(label => ({ label })), rows: a.rules.map(x => [x.label, x.rule_label + (x.arg ? ` (${x.arg})` : ''), x.severity, x.missing, x.invalid, x.ok_pct]) },
      ...(a.customers.length ? [{ name: 'By customer', columns: ['Customer', 'Rows', 'Rows with issues', 'Rows with critical issues'].map(label => ({ label })), rows: a.customers.map(c => [c.customer, c.rows, c.issue_rows, c.critical_rows]) }] : []),
      { name: 'Fill rates', columns: ['Column', 'Filled', '% filled'].map(label => ({ label })), rows: a.fill.map(f => [f.label, f.filled, f.pct]) },
    ];
    const f = fmt === 'csv' ? await X.render(t, 'csv', { title: `${r.name} data audit` }) : { filename: X.fileName(`${r.name} data audit`, 'xlsx'), mime: X.FORMATS.xlsx.mime, content: await X.toXLSX(t, { title: `${r.name}: data audit`, subtitle: A.summarize(a), extraSheets: extra }) };
    send(res, f);
  }));

  // schedules
  app.get('/api/rc/schedules', ...view, (req, res) => {
    const rows = all('SELECT s.*, r.name AS report_name, u.name AS created_by_name FROM rc_schedules s JOIN rc_reports r ON r.id = s.report_id LEFT JOIN users u ON u.id = s.created_by ORDER BY s.enabled DESC, s.next_run_at')
      .filter(s => req.perms.is_admin || s.created_by === req.user.id || can(req, 'schedule_reports')).map(schedOut);
    res.json(rows);
  });
  app.get('/api/rc/runs', ...view, (req, res) => {
    const id = Number(req.query.report_id) || null;
    res.json(all(`SELECT x.*, u.name AS user_name, r.name AS report_name FROM rc_runs x LEFT JOIN users u ON u.id = x.user_id LEFT JOIN rc_reports r ON r.id = x.report_id
      ${id ? 'WHERE x.report_id = ?' : ''} ORDER BY x.id DESC LIMIT 100`, ...(id ? [id] : [])).map(x => ({ ...x, audit: J(x.audit, null) })));
  });
  app.post('/api/rc/cron/preview', ...view, (req, res) => {
    try {
      const c = req.body.cadence ? cron.cadenceToCron(req.body.cadence) : String(req.body.cron || '');
      res.json({ cron: c, describe: req.body.cadence ? cron.describeCadence(req.body.cadence) : '', next: cron.nextRuns(c, tz(), 5).map(d => d.toISOString()), timezone: tz() });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  const schedBody = req => {
    const b = req.body;
    const cadence = b.cadence || {};
    const c = cron.cadenceToCron(cadence);
    const err = cron.validate(c); if (err) throw httpErr(400, err);
    const recipients = splitEmails(b.recipients), cc = splitEmails(b.cc);
    if (!recipients.length) throw httpErr(400, 'Add at least one recipient');
    checkRecipients(req, [...recipients, ...cc]);
    const formats = [...new Set((b.formats || ['xlsx']).filter(f => X.FORMATS[f]))];
    if (!formats.length) throw httpErr(400, 'Attach at least one file format');
    return { cadence, cron: c, recipients: recipients.join(', '), cc: cc.join(', ') || null, subject: b.subject ? String(b.subject).slice(0, 200) : null, message: b.message ? String(b.message).slice(0, 4000) : null,
      formats, skip_empty: b.skip_empty ? 1 : 0, enabled: b.enabled === false ? 0 : 1, customer: b.customer ? String(b.customer) : null, name: b.name ? String(b.name).slice(0, 160) : null };
  };
  const loadSchedule = (req, id) => {
    const s = get('SELECT * FROM rc_schedules WHERE id = ?', Number(id));
    if (!s) throw httpErr(404, 'Schedule not found');
    if (!req.perms.is_admin && s.created_by !== req.user.id && !can(req, 'schedule_reports')) throw httpErr(403, 'You can only change schedules you created');
    return s;
  };
  app.post('/api/rc/schedules', requireUser, requireCap('schedule_reports'), wrap(async (req, res) => {
    const r = loadReport(req, req.body.report_id);
    const v = schedBody(req);
    const next = v.enabled ? cron.nextRun(v.cron, tz())?.toISOString() : null;
    const id = Number(run('INSERT INTO rc_schedules(report_id, name, customer, cadence, cron, recipients, cc, subject, message, formats, skip_empty, enabled, next_run_at, created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      r.id, v.name, v.customer, JSON.stringify(v.cadence), v.cron, v.recipients, v.cc, v.subject, v.message, JSON.stringify(v.formats), v.skip_empty, v.enabled, next, req.user.id).lastInsertRowid);
    auditLog({ entity: 'report_schedule', entity_id: id, field: 'created', new_value: `${r.name}: ${cron.describeCadence(v.cadence)} to ${v.recipients}`, user_id: req.user.id });
    res.json(schedOut(get('SELECT * FROM rc_schedules WHERE id = ?', id)));
  }));
  app.put('/api/rc/schedules/:id', requireUser, requireCap('schedule_reports'), wrap(async (req, res) => {
    const s = loadSchedule(req, req.params.id);
    const v = schedBody(req);
    const next = v.enabled ? cron.nextRun(v.cron, tz())?.toISOString() : null;
    run('UPDATE rc_schedules SET name=?, customer=?, cadence=?, cron=?, recipients=?, cc=?, subject=?, message=?, formats=?, skip_empty=?, enabled=?, next_run_at=? WHERE id=?',
      v.name, v.customer, JSON.stringify(v.cadence), v.cron, v.recipients, v.cc, v.subject, v.message, JSON.stringify(v.formats), v.skip_empty, v.enabled, next, s.id);
    auditLog({ entity: 'report_schedule', entity_id: s.id, field: 'updated', new_value: `${cron.describeCadence(v.cadence)} to ${v.recipients}${v.enabled ? '' : ' (paused)'}`, user_id: req.user.id });
    res.json(schedOut(get('SELECT * FROM rc_schedules WHERE id = ?', s.id)));
  }));
  app.delete('/api/rc/schedules/:id', requireUser, requireCap('schedule_reports'), wrap(async (req, res) => {
    const s = loadSchedule(req, req.params.id);
    run('DELETE FROM rc_schedules WHERE id = ?', s.id);
    auditLog({ entity: 'report_schedule', entity_id: s.id, field: 'deleted', old_value: s.recipients, user_id: req.user.id });
    res.json({ ok: true });
  }));
  app.post('/api/rc/schedules/:id/send-now', requireUser, requireCap('schedule_reports'), wrap(async (req, res) => {
    const s = loadSchedule(req, req.params.id);
    res.json(await deliver(s, { trigger: 'manual', actor: req.user.id }));
  }));

  // external share links
  app.get('/api/rc/shares', ...view, (req, res) => {
    const rows = all(`SELECT s.id, s.report_id, s.label, s.customer, s.mode, s.formats, s.expires_at, s.revoked_at, s.views, s.last_viewed_at, s.created_at, u.name AS created_by_name, r.name AS report_name
      FROM rc_shares s JOIN rc_reports r ON r.id = s.report_id LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC`)
      .filter(s => req.perms.is_admin || can(req, 'share_reports'));
    res.json(rows.map(s => ({ ...s, formats: J(s.formats, []), active: !s.revoked_at && s.expires_at >= new Date().toISOString() })));
  });
  app.post('/api/rc/shares', requireUser, requireCap('share_reports'), wrap(async (req, res) => {
    const r = effective(loadReport(req, req.body.report_id));
    const customer = req.body.customer || r.customer || null;
    const days = Math.min(365, Math.max(1, Number(req.body.expires_days) || 30));
    const mode = req.body.mode === 'live' ? 'live' : 'snapshot';
    const formats = [...new Set((req.body.formats || ['xlsx', 'csv', 'pdf']).filter(f => X.FORMATS[f]))];
    const a = await gate(req, r, customer);
    let snapshot = null;
    if (mode === 'snapshot') { const d = await execute(req, r.spec, { customer }); snapshot = JSON.stringify({ columns: d.columns, rows: d.rows, truncated: d.truncated, at: new Date().toISOString() }); }
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + days * 864e5).toISOString();
    const id = Number(run('INSERT INTO rc_shares(report_id, token_hash, label, customer, mode, snapshot, formats, expires_at, created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      r.id, hashToken(token), req.body.label ? String(req.body.label).slice(0, 160) : null, customer, mode, snapshot, JSON.stringify(formats), expires, req.user.id).lastInsertRowid);
    auditLog({ entity: 'report_share', entity_id: id, field: 'created', new_value: `${r.name}${customer ? ` (${customer})` : ''}: ${mode} link, expires ${expires.slice(0, 10)}`, user_id: req.user.id });
    logRun({ report_id: r.id, share_id: id, trigger: 'share', customer, status: 'ok', audit: auditBrief(a), user_id: req.user.id });
    res.json({ id, url: `${appUrl()}/r/${token}`, expires_at: expires, audit: auditBrief(a) });
  }));
  app.delete('/api/rc/shares/:id', requireUser, requireCap('share_reports'), wrap(async (req, res) => {
    const s = get('SELECT * FROM rc_shares WHERE id = ?', Number(req.params.id));
    if (!s) throw httpErr(404, 'Link not found');
    run("UPDATE rc_shares SET revoked_at = datetime('now'), snapshot = NULL WHERE id = ?", s.id);
    auditLog({ entity: 'report_share', entity_id: s.id, field: 'revoked', user_id: req.user.id });
    res.json({ ok: true });
  }));

  // data settings
  app.get('/api/rc/settings', requireUser, requireCap('manage_reporting_data'), wrap(async (req, res) => {
    const s = source.connectionString() ? await schema().catch(() => null) : null;
    const pol = policy();
    res.json({ policy: pol, roles: all('SELECT id, name FROM roles ORDER BY id'),
      tables: (s?.tables || []).map(t => ({ key: t.key, schema: t.schema, name: t.name, view: t.view, est_rows: t.est_rows,
        enabled: pol.tables ? pol.tables.includes(t.key) : t.schema === 'public',
        fields: Q.fieldsOf(t).map(f => ({ id: f.id, label: f.label, kind: f.kind, fill: f.fill, json: f.path.length > 0, hidden: Q.isHidden(pol, f.id) })) })),
      refreshed_at: s?.refreshed_at || null });
  }));
  app.put('/api/rc/settings', requireUser, requireCap('manage_reporting_data'), wrap(async (req, res) => {
    const b = req.body, cur = policy();
    const list = v => (Array.isArray(v) ? v.map(String) : []);
    const next = { tables: Array.isArray(b.tables) ? list(b.tables) : cur.tables, hidden: b.hidden ? list(b.hidden) : cur.hidden, unhidden: b.unhidden ? list(b.unhidden) : cur.unhidden,
      role_tables: b.role_tables && typeof b.role_tables === 'object' ? Object.fromEntries(Object.entries(b.role_tables).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, list(v)])) : cur.role_tables };
    setSetting('rc_policy', next);
    auditLog({ entity: 'settings', entity_id: 0, field: 'rc_policy', old_value: cur, new_value: next, user_id: req.user.id });
    res.json({ ok: true });
  }));
  app.post('/api/rc/schema/refresh', requireUser, requireCap('manage_reporting_data'), wrap(async (req, res) => {
    const s = await schema({ refresh: true });
    res.json({ tables: s.tables.length, refreshed_at: s.refreshed_at });
  }));

  // public share pages (no sign-in; the unguessable, expiring token is the key)
  const pageErr = res => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Link unavailable</title><p style="font-family:system-ui;padding:24px">This link has expired or was turned off. Ask the person who shared it for a new one.</p>');
  app.get('/r/:token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
    try {
      const s = shareFor(req.params.token); if (!s) return pageErr(res);
      const r = get('SELECT * FROM rc_reports WHERE id = ?', s.report_id);
      const data = await shareData(s);
      run("UPDATE rc_shares SET views = views + 1, last_viewed_at = datetime('now') WHERE id = ?", s.id);
      res.type('html').send(sharePage({ ...s, _path: `/r/${req.params.token}` }, r, data));
    } catch (e) { console.error('[reporting] share', e.message); pageErr(res); }
  });
  app.get('/r/:token/download.:fmt', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const s = shareFor(req.params.token); if (!s) return pageErr(res);
      if (!J(s.formats, []).includes(req.params.fmt)) return pageErr(res);
      const r = get('SELECT * FROM rc_reports WHERE id = ?', s.report_id);
      const data = await shareData(s);
      const f = await X.render(data, req.params.fmt, { title: s.label || r.name, suffix: s.customer, subtitle: s.customer ? `Customer: ${s.customer}` : '' });
      logRun({ report_id: s.report_id, share_id: s.id, trigger: 'share_download', format: req.params.fmt, customer: s.customer, rows: data.rows.length, status: 'ok' });
      send(res, f);
    } catch (e) { console.error('[reporting] share download', e.message); pageErr(res); }
  });
}

module.exports = { mount, tick, deliver };
