const path = require('path');
const express = require('express');

const { all, get, run, J, getSetting, setSetting, audit } = require('./db');
const perms = require('./perms');
const auth = require('./auth');
const mail = require('./mail');
const source = require('./reportSource');
const reporting = require('./reporting');
const { tz } = require('./time');

// ---------------------------------------------------------------- first start
if (!get('SELECT 1 FROM roles LIMIT 1')) {
  const caps = list => JSON.stringify({ admin: Object.fromEntries(list.map(c => [c, true])) });
  run('INSERT INTO roles(name, description, perms) VALUES(?,?,?)', 'Admin', 'Everything, including users, settings and data access', JSON.stringify({ is_admin: true }));
  run('INSERT INTO roles(name, description, perms) VALUES(?,?,?)', 'Report builder', 'Builds, schedules and shares reports', caps(['view_reporting', 'build_reports', 'schedule_reports', 'share_reports']));
  run('INSERT INTO roles(name, description, perms) VALUES(?,?,?)', 'Viewer', 'Runs and exports the reports others have built', caps(['view_reporting']));
}
if (auth.DEMO_MODE && !get('SELECT 1 FROM users LIMIT 1')) {
  for (const [name, role, title] of [['Demo Admin', 'Admin', 'Admin'], ['Demo Builder', 'Report builder', 'Analyst'], ['Demo Viewer', 'Viewer', 'Account manager']])
    run('INSERT INTO users(name, email, title, role_id) VALUES(?,?,?,?)', name, `${name.toLowerCase().replace(' ', '.')}@example.com`, title, get('SELECT id FROM roles WHERE name = ?', role).id);
}
auth.bootstrapAdmin();
if (process.env.APP_URL) setSetting('app_url', process.env.APP_URL.replace(/\/$/, ''));

const app = express();
app.set('trust proxy', 1); // behind Render, so req.secure reflects HTTPS
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '2mb' }));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

// ---------------------------------------------------------------- auth
const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=')[1]) : null;
};
app.use('/api', (req, res, next) => {
  req.user = auth.userFromToken(readCookie(req, 'rc_session'));
  req.perms = perms.effectivePerms(req.user);
  next();
});
const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in required' }));
const requireCap = cap => (req, res, next) => (perms.can(req.perms, cap) ? next() : res.status(403).json({ error: 'You do not have permission for this action' }));
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { if (!e.status || e.status >= 500) console.error(e); res.status(e.status || 500).json({ error: e.message, ...(e.audit ? { audit: e.audit } : {}) }); }
};
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const publicUser = u => u && { id: u.id, name: u.name, email: u.email, title: u.title, role_id: u.role_id, active: !!u.active, last_login_at: u.last_login_at, has_password: !!u.password_hash, created_at: u.created_at };

app.get('/healthz', (req, res) => { get('SELECT 1 AS ok'); res.json({ ok: true }); });
app.get('/api/auth-config', (req, res) => res.json({ demo: auth.DEMO_MODE, min_password: auth.MIN_PASSWORD, company: getSetting('company', {}).name || 'First Gen' }));
app.get('/api/login-options', (req, res) => {
  if (!auth.DEMO_MODE) return res.json([]);
  res.json(all('SELECT u.id, u.name, u.title, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.active = 1 ORDER BY r.id, u.name'));
});
app.get('/api/session', (req, res) => res.json({
  user: publicUser(req.user), perms: req.user ? req.perms : null, caps: perms.ADMIN_CAPS,
  company: getSetting('company', {}).name || 'First Gen', timezone: tz(),
}));
app.post('/api/session', (req, res) => {
  let u = null;
  if (req.body.email) {
    const email = String(req.body.email).trim().toLowerCase();
    const key = `${email}|${req.ip}`;
    if (auth.throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    u = get('SELECT * FROM users WHERE lower(email) = ? AND active = 1', email);
    if (!u || !auth.verifyPassword(String(req.body.password || ''), u.password_hash)) {
      auth.recordFailure(key);
      audit({ entity: 'auth', entity_id: u?.id || 0, field: 'login_failed', new_value: email, source: 'auth' });
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    auth.clearFailures(key);
  } else if (auth.DEMO_MODE && req.body.user_id) {
    u = get('SELECT * FROM users WHERE id = ? AND active = 1', Number(req.body.user_id));
  }
  if (!u) return res.status(400).json({ error: 'Enter your email and password' });
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", u.id);
  audit({ entity: 'auth', entity_id: u.id, field: 'login', new_value: u.email, user_id: u.id, source: 'auth' });
  res.setHeader('Set-Cookie', auth.sessionCookie(req, auth.sessionToken(u)));
  res.json({ ok: true });
});
app.delete('/api/session', (req, res) => { res.setHeader('Set-Cookie', auth.sessionCookie(req, '', 0)); res.json({ ok: true }); });
app.post('/api/me/password', requireUser, wrap(async (req, res) => {
  if (req.user.password_hash && !auth.verifyPassword(String(req.body.current || ''), req.user.password_hash)) throw httpErr(400, 'Your current password is not right');
  const err = auth.validatePassword(req.body.password); if (err) throw httpErr(400, err);
  auth.setPassword(req.user.id, req.body.password);
  audit({ entity: 'user', entity_id: req.user.id, field: 'password', new_value: 'changed', user_id: req.user.id });
  res.setHeader('Set-Cookie', auth.sessionCookie(req, auth.sessionToken(get('SELECT * FROM users WHERE id = ?', req.user.id))));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- users & roles
const admin = [requireUser, requireCap('manage_users')];
app.get('/api/users', ...admin, (req, res) => res.json({
  users: all('SELECT * FROM users ORDER BY active DESC, name').map(publicUser),
  roles: all('SELECT * FROM roles ORDER BY id').map(r => ({ ...r, perms: J(r.perms, {}), users: get('SELECT COUNT(*) n FROM users WHERE role_id = ? AND active = 1', r.id).n })),
  caps: perms.ADMIN_CAPS, min_password: auth.MIN_PASSWORD,
}));
function userBody(b) {
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase();
  if (!name) throw httpErr(400, 'Enter a name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw httpErr(400, 'Enter a valid email address');
  const role_id = Number(b.role_id) || null;
  if (role_id && !get('SELECT 1 FROM roles WHERE id = ?', role_id)) throw httpErr(400, 'Pick a role');
  return { name: name.slice(0, 120), email, title: b.title ? String(b.title).slice(0, 120) : null, role_id };
}
const adminsLeft = exceptId => get(`SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND json_extract(r.perms, '$.is_admin') = 1 AND u.id <> ?`, exceptId).n;
app.post('/api/users', ...admin, wrap(async (req, res) => {
  const v = userBody(req.body);
  if (get('SELECT 1 FROM users WHERE lower(email) = ?', v.email)) throw httpErr(400, 'Someone already uses that email');
  if (req.body.password) { const e = auth.validatePassword(req.body.password); if (e) throw httpErr(400, e); }
  const id = Number(run('INSERT INTO users(name, email, title, role_id) VALUES(?,?,?,?)', v.name, v.email, v.title, v.role_id).lastInsertRowid);
  if (req.body.password) auth.setPassword(id, req.body.password);
  audit({ entity: 'user', entity_id: id, field: 'created', new_value: `${v.name} <${v.email}>`, user_id: req.user.id });
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', id)));
}));
app.put('/api/users/:id', ...admin, wrap(async (req, res) => {
  const cur = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!cur) throw httpErr(404, 'User not found');
  const v = userBody({ ...publicUser(cur), ...req.body });
  if (get('SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?', v.email, cur.id)) throw httpErr(400, 'Someone already uses that email');
  const active = req.body.active === undefined ? cur.active : (req.body.active ? 1 : 0);
  const wasAdmin = perms.effectivePerms(cur).is_admin, willBeAdmin = !!J(get('SELECT perms FROM roles WHERE id = ?', v.role_id)?.perms, {}).is_admin;
  if (wasAdmin && (!willBeAdmin || !active) && !adminsLeft(cur.id)) throw httpErr(400, 'Keep at least one active admin');
  if (req.body.password) { const e = auth.validatePassword(req.body.password); if (e) throw httpErr(400, e); auth.setPassword(cur.id, req.body.password); }
  run('UPDATE users SET name = ?, email = ?, title = ?, role_id = ?, active = ? WHERE id = ?', v.name, v.email, v.title, v.role_id, active, cur.id);
  audit({ entity: 'user', entity_id: cur.id, field: 'updated', old_value: publicUser(cur), new_value: { ...v, active: !!active, password_reset: !!req.body.password }, user_id: req.user.id });
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', cur.id)));
}));
function roleBody(b) {
  const name = String(b.name || '').trim();
  if (!name) throw httpErr(400, 'Name the role');
  const adminCaps = Object.fromEntries(Object.keys(perms.ADMIN_CAPS).filter(k => b.perms?.admin?.[k]).map(k => [k, true]));
  return { name: name.slice(0, 80), description: b.description ? String(b.description).slice(0, 300) : null, perms: { is_admin: !!b.perms?.is_admin, admin: adminCaps } };
}
app.post('/api/roles', ...admin, wrap(async (req, res) => {
  const v = roleBody(req.body);
  if (get('SELECT 1 FROM roles WHERE name = ?', v.name)) throw httpErr(400, 'A role with that name exists');
  const id = Number(run('INSERT INTO roles(name, description, perms) VALUES(?,?,?)', v.name, v.description, JSON.stringify(v.perms)).lastInsertRowid);
  audit({ entity: 'role', entity_id: id, field: 'created', new_value: v, user_id: req.user.id });
  res.json({ id });
}));
app.put('/api/roles/:id', ...admin, wrap(async (req, res) => {
  const cur = get('SELECT * FROM roles WHERE id = ?', Number(req.params.id));
  if (!cur) throw httpErr(404, 'Role not found');
  const v = roleBody(req.body);
  if (J(cur.perms, {}).is_admin && !v.perms.is_admin && !get(`SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND json_extract(r.perms, '$.is_admin') = 1 AND r.id <> ?`, cur.id)) throw httpErr(400, 'Keep at least one active admin');
  run('UPDATE roles SET name = ?, description = ?, perms = ? WHERE id = ?', v.name, v.description, JSON.stringify(v.perms), cur.id);
  audit({ entity: 'role', entity_id: cur.id, field: 'updated', old_value: J(cur.perms, {}), new_value: v, user_id: req.user.id });
  res.json({ ok: true });
}));
app.delete('/api/roles/:id', ...admin, wrap(async (req, res) => {
  const cur = get('SELECT * FROM roles WHERE id = ?', Number(req.params.id));
  if (!cur) throw httpErr(404, 'Role not found');
  if (get('SELECT 1 FROM users WHERE role_id = ?', cur.id)) throw httpErr(400, 'Move the people in this role to another role first');
  run('DELETE FROM roles WHERE id = ?', cur.id);
  audit({ entity: 'role', entity_id: cur.id, field: 'deleted', old_value: cur.name, user_id: req.user.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- settings
const mask = v => (v ? String(v).replace(/(:\/\/[^:]+:)[^@]+@/, '$1••••••@') : '');
app.get('/api/settings', ...admin, (req, res) => {
  const e = getSetting('email', {});
  res.json({
    company: getSetting('company', {}).name || '', has_logo: !!getSetting('company', {}).logo, timezone: tz(), app_url: process.env.APP_URL || getSetting('app_url', ''), default_app_url: process.env.RENDER_EXTERNAL_URL || '',
    database: { url: mask(source.connectionString()), from_env: !!process.env.REPORTING_DB_URL },
    email: { ...mail.publicStatus(), smtp_pass_set: !!(process.env.SMTP_PASS || e.smtp_pass) },
    env: ['APP_URL', 'TIMEZONE', 'REPORTING_DB_URL'].filter(k => process.env[k]),
  });
});
app.put('/api/settings', ...admin, wrap(async (req, res) => {
  const b = req.body;
  if (b.company !== undefined) { const c = getSetting('company', {}); c.name = String(b.company || '').slice(0, 120); setSetting('company', c); }
  if (b.logo !== undefined) {
    if (b.logo && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.logo)) throw httpErr(400, 'The logo must be a PNG');
    if (b.logo && b.logo.length > 700000) throw httpErr(400, 'Use a logo under 500 KB');
    const c = getSetting('company', {}); c.logo = b.logo || null; setSetting('company', c);
  }
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw httpErr(400, 'Unknown timezone'); }
    setSetting('timezone', b.timezone);
  }
  if (b.app_url !== undefined) setSetting('app_url', String(b.app_url || '').trim().replace(/\/$/, ''));
  if (b.database_url) {
    if (!/^postgres(ql)?:\/\//.test(b.database_url)) throw httpErr(400, 'Paste a postgres:// connection string');
    setSetting('reporting_db_url', String(b.database_url).trim());
    source.reset();
    audit({ entity: 'settings', field: 'reporting_db_url', new_value: mask(b.database_url), user_id: req.user.id });
  }
  if (b.email) {
    const cur = getSetting('email', {}), e = b.email;
    const next = { ...cur, delivery_mode: e.delivery_mode === 'live' ? 'live' : 'dry_run', smtp_host: e.host ?? cur.smtp_host, smtp_port: Number(e.port) || cur.smtp_port || 587,
      smtp_user: e.user ?? cur.smtp_user, email_from: e.from ?? cur.email_from };
    if (e.pass) next.smtp_pass = e.pass;
    setSetting('email', next);
    audit({ entity: 'settings', field: 'email', new_value: { ...next, smtp_pass: next.smtp_pass ? '(set)' : null }, user_id: req.user.id });
  }
  res.json({ ok: true });
}));
app.post('/api/settings/test-email', ...admin, wrap(async (req, res) => {
  const id = await mail.sendEmail({ to: req.user.email, subject: 'Reporting Center test email', kind: 'test', html: '<p>Email delivery from the Reporting Center works.</p>' });
  res.json(get('SELECT status, error FROM outbox WHERE id = ?', id));
}));
app.post('/api/settings/test-database', ...admin, wrap(async (req, res) => {
  const { rows } = await source.readOnly('SELECT current_user AS user, current_database() AS database, version() AS version');
  res.json(rows[0]);
}));

// ---------------------------------------------------------------- outbox & audit log
app.get('/api/outbox', requireUser, requireCap('view_audit'), (req, res) =>
  res.json(all('SELECT id, kind, to_addr, cc, subject, attachments, status, error, created_at FROM outbox ORDER BY id DESC LIMIT 200').map(o => ({ ...o, attachments: J(o.attachments, []) }))));
app.get('/api/outbox/:id', requireUser, requireCap('view_audit'), (req, res) => {
  const o = get('SELECT * FROM outbox WHERE id = ?', Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(o.body || '');
});
app.get('/api/audit', requireUser, requireCap('view_audit'), (req, res) =>
  res.json(all('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300')));

// ---------------------------------------------------------------- reports (+ public share pages at /r/:token)
reporting.mount(app, { requireUser, requireCap, wrap });

// ---------------------------------------------------------------- scheduler: due report emails, checked every minute
setInterval(() => reporting.tick().catch(e => console.error('[scheduler]', e)), 60 * 1000).unref?.();

app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

const PORT = Number(process.env.PORT) || 4400;
app.listen(PORT, () => console.log(`Reporting Center running at http://localhost:${PORT}  (email: ${mail.publicStatus().mode})`));
