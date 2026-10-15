/* Reporting Center: front end core (no build step). Helpers, sign-in, navigation, users & roles, settings, outbox & audit. */
'use strict';

// ------------------------------------------------------------------ tiny helpers
const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const money = n => (n == null || n === '' ? '—' : (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const money0 = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const fdate = d => (d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const fdatetime = d => (d ? new Date(d.includes('T') || d.endsWith('Z') ? d : d.replace(' ', 'T') + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const initials = n => String(n || '?').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(method, url, body, { raw = false } = {}) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opt);
  const data = raw ? res : await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'Sign in required') { S.user = null; render(); throw new Error('Your session ended. Please sign in again.'); }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.data = data; throw e; }
  return data;
}
function toast(msg, type = '') {
  const t = h('div', { class: 'toast ' + type }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3200);
}
const tryApi = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'err'); throw e; } };

const ICONS = {
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  flow: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  log: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 14.5A9 9 0 1 1 20.7 14.5"/><circle cx="12" cy="14" r="1.5"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
};
const icon = (name, size = 16) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.innerHTML = ICONS[name] || ''; return s; };

// ------------------------------------------------------------------ theme (light / dark; defaults to the OS setting)
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function themeToggle() {
  const btn = h('button', { class: 'ghost', 'aria-label': 'Toggle light or dark mode' });
  const paint = () => { const dark = currentTheme() === 'dark'; btn.replaceChildren(icon(dark ? 'sun' : 'moon')); btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode'; };
  btn.onclick = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('rc_theme', next); } catch {}
    paint();
  };
  paint();
  return btn;
}

// ------------------------------------------------------------------ modal / drawer primitives
function modal(title, body, { actions = [], wide = false, onClose } = {}) {
  const scrim = h('div', { class: 'scrim top' });
  const close = () => { scrim.remove(); m.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const m = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('span', { class: 'spacer' }), h('button', { class: 'ghost sm', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map(a => (a instanceof Node ? a : h('button', { class: a.primary ? 'primary' : a.danger ? 'danger' : '', onclick: () => a.onClick(close) }, a.label)))) : null);
  scrim.onclick = close;
  document.addEventListener('keydown', esc);
  document.body.append(scrim, m);
  setTimeout(() => m.querySelector('input, select, textarea')?.focus(), 30);
  return { close, el: m };
}
function confirmBox(msg, label = 'Confirm') {
  return new Promise(res => { let answered = false; const done = v => { if (!answered) { answered = true; res(v); } };
    modal('Please confirm', h('p', { style: { margin: 0 } }, msg), { onClose: () => done(false),
      actions: [{ label: 'Cancel', onClick: c => { done(false); c(); } }, { label, primary: true, onClick: c => { done(true); c(); } }] }); });
}


const pageHead = (title, sub, ...right) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null), h('span', { class: 'spacer' }), ...right);
const kpi = (k, v, s, cls = '') => h('div', { class: 'kpi ' + cls }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 's' }, s));

// ------------------------------------------------------------------ state, boot & routing
const S = { user: null, perms: null, caps: {}, company: '', timezone: '' };
const can = cap => !!S.perms && (S.perms.is_admin || !!S.perms.admin?.[cap]);

async function boot() {
  const s = await api('GET', '/api/session');
  Object.assign(S, { user: s.user, perms: s.perms, caps: s.caps, company: s.company, timezone: s.timezone });
  document.title = `Reporting Center · ${S.company}`;
  render();
}
window.addEventListener('hashchange', () => route());

const NAV = [
  ['Reports', [['#/reporting', 'Reports', 'chart', 'view_reporting']]],
  ['Admin', [['#/users', 'Users & roles', 'users', 'manage_users'], ['#/settings', 'Settings', 'plug', 'manage_users'], ['#/log', 'Outbox & audit log', 'log', 'view_audit']]],
];
function render() {
  const root = $('#root');
  root.innerHTML = '';
  if (!S.user) return root.append(loginView());
  const items = sec => sec.filter(i => !i[3] || can(i[3]));
  const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'RC'), 'Reporting Center'),
    NAV.map(([sec, list]) => items(list).length ? [h('div', { class: 'nav-sec' }, sec), h('div', { class: 'nav' }, items(list).map(([href, label, ic]) =>
      h('a', { href, 'data-href': href, onclick: () => sidebar.classList.remove('open') }, icon(ic), label)))] : null));
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'ghost menu-btn', 'aria-label': 'Menu', onclick: () => sidebar.classList.toggle('open') }, icon('menu')),
    h('span', { class: 'muted small hide-sm' }, S.company),
    h('span', { class: 'spacer' }),
    themeToggle(),
    h('button', { class: 'ghost user-pill', onclick: passwordModal, title: 'Change your password' }, h('span', { class: 'avatar' }, initials(S.user.name)),
      h('span', { class: 'hide-sm' }, S.user.name, ' ', h('span', { class: 'muted small' }, `· ${S.perms.role_name || 'No role'}`))),
    h('button', { class: 'sm', onclick: async () => { await api('DELETE', '/api/session'); S.user = null; render(); } }, 'Sign out'));
  root.append(h('div', { class: 'app' }, sidebar, h('div', { class: 'main' }, top, h('main', { class: 'content', id: 'view' }))));
  route();
}
async function route() {
  if (!S.user) return;
  let hash = location.hash || '';
  if (!hash || hash === '#/' || hash === '#') { hash = can('view_reporting') ? '#/reporting' : can('manage_users') ? '#/users' : '#/none'; history.replaceState(null, '', hash); }
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.href === hash || hash.startsWith(a.dataset.href + '/')));
  const view = $('#view');
  if (!view) return;
  view.innerHTML = '';
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const [, name, arg] = hash.split('/');
  const views = { reporting: [viewReporting, 'view_reporting'], users: [viewUsers, 'manage_users'], settings: [viewSettings, 'manage_users'], log: [viewLog, 'view_audit'] };
  if (views[name] && !can(views[name][1])) { location.hash = '#/'; return; }
  const fn = views[name]?.[0];
  if (!fn) { view.append(h('div', { class: 'callout' }, 'Your role has no screens yet. Ask an admin to give you access.')); return; }
  try { await fn(view, arg); } catch (e) { view.append(h('div', { class: 'callout warn' }, e.message)); console.error(e); }
}

function loginView() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'you@company.com' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'callout warn hidden', role: 'alert' });
  const btn = h('button', { class: 'primary', type: 'submit', style: { justifyContent: 'center' } }, 'Sign in');
  const form = h('form', { class: 'col', style: { gap: '12px' }, onsubmit: async e => {
    e.preventDefault();
    err.classList.add('hidden'); btn.disabled = true;
    try { await api('POST', '/api/session', { email: email.value, password: pw.value }); await boot(); }
    catch (x) { err.textContent = x.message; err.classList.remove('hidden'); pw.value = ''; pw.focus(); }
    finally { btn.disabled = false; }
  } }, err, h('label', { class: 'field' }, 'Email', email), h('label', { class: 'field' }, 'Password', pw), btn,
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Forgot your password? Ask an admin to reset it.'));
  const demo = h('div');
  api('GET', '/api/auth-config').then(async cfg => {
    if (!cfg.demo) return;
    const users = await api('GET', '/api/login-options');
    demo.append(h('div', { class: 'card', style: { marginTop: '14px' } }, h('h2', null, 'Demo mode: sign in as anyone'),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Only shown because DEMO_MODE is on. Never enable it on a deployed server.'),
      h('div', { class: 'col' }, users.map(u => h('button', { class: 'u', onclick: async () => { await api('POST', '/api/session', { user_id: u.id }); await boot(); } },
        h('span', { class: 'row' }, h('span', { class: 'avatar' }, initials(u.name)), u.name), h('span', { class: 'muted small' }, u.role || ''))))));
  });
  setTimeout(() => email.focus(), 50);
  return h('div', { class: 'login' },
    h('div', { class: 'row', style: { marginBottom: '6px' } }, h('div', { class: 'brand', style: { fontSize: '20px', padding: 0 } }, h('div', { class: 'logo' }, 'RC'), 'Reporting Center'), h('span', { class: 'spacer' }), themeToggle()),
    h('div', { class: 'card' }, h('h2', null, 'Sign in'), form), demo);
}
function passwordModal() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), next = h('input', { type: 'password', autocomplete: 'new-password' });
  modal('Change your password', h('div', { class: 'col' }, h('label', { class: 'field' }, 'Current password', cur), h('label', { class: 'field' }, 'New password (10+ characters, letters and numbers)', next)), { actions: [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Change password', primary: true, onClick: async c => { await tryApi(() => api('POST', '/api/me/password', { current: cur.value, password: next.value }), 'Password changed'); c(); } }] });
}

// ------------------------------------------------------------------ users & roles
async function viewUsers(view) {
  const d = await api('GET', '/api/users');
  const roleName = id => d.roles.find(r => r.id === id)?.name || 'No role';
  view.append(pageHead('Users & roles', 'Who can sign in, and what each role can do.', h('button', { class: 'primary', onclick: () => userModal(null, d) }, '+ Add person')));
  view.append(h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Name', 'Email', 'Role', 'Last sign-in', ''].map(x => h('th', null, x)))),
    h('tbody', null, d.users.map(u => h('tr', { style: u.active ? {} : { opacity: 0.55 } },
      h('td', null, h('b', null, u.name), u.title ? h('div', { class: 'small muted' }, u.title) : null),
      h('td', { class: 'small' }, u.email, u.has_password ? '' : h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, 'no password yet')),
      h('td', null, h('span', { class: 'badge blue' }, roleName(u.role_id)), u.active ? '' : h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'inactive')),
      h('td', { class: 'small muted' }, u.last_login_at ? fdatetime(u.last_login_at) : 'never'),
      h('td', { class: 'right' }, h('button', { class: 'sm', onclick: () => userModal(u, d) }, 'Edit'))))))));
  view.append(h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'card-head' }, h('h2', null, 'Roles'), h('span', { class: 'spacer' }), h('button', { class: 'sm', onclick: () => roleModal(null, d) }, '+ Add role')),
    h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Role', ...Object.values(d.caps).map(c => c), 'People', ''].map((x, i) => h('th', { class: i ? 'small' : '', style: i ? { whiteSpace: 'normal', minWidth: '90px' } : {} }, x)))),
      h('tbody', null, d.roles.map(r => h('tr', null, h('td', null, h('b', null, r.name), r.description ? h('div', { class: 'small muted' }, r.description) : null),
        Object.keys(d.caps).map(k => h('td', { class: 'small' }, r.perms.is_admin || r.perms.admin?.[k] ? '✓' : h('span', { class: 'faint' }, '—'))),
        h('td', { class: 'small' }, r.users), h('td', { class: 'right' }, h('button', { class: 'sm', onclick: () => roleModal(r, d) }, 'Edit')))))))));
}
function userModal(u, d) {
  const v = { name: '', email: '', title: '', role_id: d.roles.find(r => r.name === 'Viewer')?.id || d.roles[0]?.id, active: true, password: '', ...(u || {}) };
  v.password = '';
  const body = h('div', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Name', h('input', { value: v.name, oninput: e => { v.name = e.target.value; } })),
    h('label', { class: 'field' }, 'Email', h('input', { type: 'email', value: v.email, oninput: e => { v.email = e.target.value; } })),
    h('label', { class: 'field' }, 'Title (optional)', h('input', { value: v.title || '', oninput: e => { v.title = e.target.value; } })),
    h('label', { class: 'field' }, 'Role', h('select', { onchange: e => { v.role_id = Number(e.target.value); } }, d.roles.map(r => h('option', { value: r.id, selected: r.id === v.role_id }, r.name)))),
    h('label', { class: 'field' }, u ? 'Set a new password (optional)' : 'Password', h('input', { type: 'password', autocomplete: 'new-password', placeholder: `${d.min_password}+ characters, letters and numbers`, oninput: e => { v.password = e.target.value; } })),
    u ? h('label', { class: 'check', style: { alignSelf: 'end' } }, h('input', { type: 'checkbox', checked: v.active, onchange: e => { v.active = e.target.checked; } }), 'Can sign in') : null);
  modal(u ? `Edit ${u.name}` : 'Add a person', body, { wide: true, actions: [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Save', primary: true, onClick: async c => { await tryApi(() => (u ? api('PUT', `/api/users/${u.id}`, v) : api('POST', '/api/users', v)), 'Saved'); c(); route(); } }] });
}
function roleModal(r, d) {
  const v = { name: '', description: '', perms: { is_admin: false, admin: {} }, ...(r ? JSON.parse(JSON.stringify(r)) : {}) };
  v.perms.admin = v.perms.admin || {};
  const caps = h('div', { class: 'col' }, Object.entries(d.caps).map(([k, l]) => h('label', { class: 'check small' },
    h('input', { type: 'checkbox', checked: !!v.perms.admin[k], onchange: e => { v.perms.admin[k] = e.target.checked; } }), l)));
  const body = h('div', { class: 'col' },
    h('label', { class: 'field' }, 'Name', h('input', { value: v.name, oninput: e => { v.name = e.target.value; } })),
    h('label', { class: 'field' }, 'Description', h('input', { value: v.description || '', oninput: e => { v.description = e.target.value; } })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v.perms.is_admin, onchange: e => { v.perms.is_admin = e.target.checked; caps.classList.toggle('hidden', e.target.checked); } }), h('b', null, 'Admin'), h('span', { class: 'small muted' }, ' (everything)')),
    caps);
  caps.classList.toggle('hidden', v.perms.is_admin);
  modal(r ? `Edit role: ${r.name}` : 'Add a role', body, { actions: [
    ...(r ? [h('button', { class: 'danger', onclick: async () => { if (await confirmBox(`Delete the ${r.name} role?`, 'Delete')) { await tryApi(() => api('DELETE', `/api/roles/${r.id}`), 'Role deleted'); document.querySelector('.modal .ghost')?.click(); route(); } } }, 'Delete')] : []),
    { label: 'Cancel', onClick: c => c() },
    { label: 'Save', primary: true, onClick: async c => { await tryApi(() => (r ? api('PUT', `/api/roles/${r.id}`, v) : api('POST', '/api/roles', v)), 'Saved'); c(); route(); } }] });
}

// ------------------------------------------------------------------ settings
async function viewSettings(view) {
  const s = await api('GET', '/api/settings');
  const v = { company: s.company, timezone: s.timezone, app_url: s.app_url, database_url: '', email: { delivery_mode: s.email.mode, host: s.email.host || '', port: s.email.port, user: s.email.user || '', from: s.email.from, pass: '' } };
  const envNote = keys => keys.some(k => s.env.includes(k) || s.email.env.includes(k)) ? h('div', { class: 'small muted' }, `Set on the server: ${keys.filter(k => s.env.includes(k) || s.email.env.includes(k)).join(', ')}. Server values win over what is saved here.`) : null;
  const save = async () => { await tryApi(() => api('PUT', '/api/settings', v), 'Settings saved'); route(); };
  const logoIn = h('input', { type: 'file', accept: 'image/png', onchange: e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { v.logo = rd.result; }; rd.readAsDataURL(f); } });
  view.append(pageHead('Settings', null, h('button', { class: 'primary', onclick: save }, 'Save')));
  view.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h2', null, 'Company'),
      h('div', { class: 'col' },
        h('label', { class: 'field' }, 'Company name (shown on reports, shared pages and emails)', h('input', { value: v.company, oninput: e => { v.company = e.target.value; } })),
        h('label', { class: 'field' }, `Logo for PDFs (PNG)${s.has_logo ? ': a custom logo is set' : ''}`, logoIn),
        h('label', { class: 'field' }, 'Timezone (schedules run in this timezone)', h('input', { value: v.timezone, placeholder: 'America/New_York', oninput: e => { v.timezone = e.target.value; } })),
        h('label', { class: 'field' }, 'App address (used in shared links)', h('input', { value: v.app_url, placeholder: s.default_app_url || 'https://reports.yourcompany.com', oninput: e => { v.app_url = e.target.value; } })),
        envNote(['APP_URL', 'TIMEZONE']))),
    h('div', { class: 'card' }, h('h2', null, 'Database'),
      h('div', { class: 'col' },
        h('div', { class: 'small' }, s.database.url ? ['Connected to ', h('code', null, s.database.url)] : h('span', { class: 'badge warn' }, 'Not connected')),
        s.database.from_env ? h('div', { class: 'small muted' }, 'Set on the server with REPORTING_DB_URL.') :
          h('label', { class: 'field' }, 'Supabase connection string (Project settings → Database → Connection string)', h('input', { type: 'password', placeholder: 'postgresql://reporting_ro.xxxx:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres', oninput: e => { v.database_url = e.target.value; } })),
        h('div', { class: 'small muted' }, 'Reports only ever read. For extra safety, connect with a database user that can only read (see DEPLOY.md).'),
        h('div', null, h('button', { class: 'sm', onclick: async () => { const r = await tryApi(() => api('POST', '/api/settings/test-database')); toast(`Connected as ${r.user} to ${r.database}`); } }, 'Test the connection')))),
    h('div', { class: 'card' }, h('h2', null, 'Email'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Delivery', h('select', { onchange: e => { v.email.delivery_mode = e.target.value; } }, h('option', { value: 'dry_run', selected: v.email.delivery_mode !== 'live' }, 'Dry run: log to the outbox only'), h('option', { value: 'live', selected: v.email.delivery_mode === 'live' }, 'Live: send email'))),
        h('label', { class: 'field' }, 'From', h('input', { value: v.email.from, oninput: e => { v.email.from = e.target.value; } })),
        h('label', { class: 'field' }, 'SMTP host', h('input', { value: v.email.host, placeholder: 'smtp.sendgrid.net', oninput: e => { v.email.host = e.target.value; } })),
        h('label', { class: 'field' }, 'Port', h('input', { type: 'number', value: v.email.port, oninput: e => { v.email.port = e.target.value; } })),
        h('label', { class: 'field' }, 'Username', h('input', { value: v.email.user, oninput: e => { v.email.user = e.target.value; } })),
        h('label', { class: 'field' }, `Password${s.email.smtp_pass_set ? ' (set; leave blank to keep)' : ''}`, h('input', { type: 'password', oninput: e => { v.email.pass = e.target.value; } }))),
      envNote(['DELIVERY_MODE', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']),
      h('div', { style: { marginTop: '10px' } }, h('button', { class: 'sm', onclick: async () => { const r = await tryApi(() => api('POST', '/api/settings/test-email')); toast(r.status === 'sent' ? `Sent to ${S.user.email}` : r.status === 'dry_run' ? 'Logged to the outbox (dry run)' : `Not sent: ${r.error || r.status}`, r.status === 'failed' ? 'err' : ''); } }, 'Send me a test email')))));
}

// ------------------------------------------------------------------ outbox & audit log
async function viewLog(view) {
  const [out, log] = await Promise.all([api('GET', '/api/outbox'), api('GET', '/api/audit')]);
  view.append(pageHead('Outbox & audit log', 'Every email the app has sent or logged, and every change people have made.'));
  view.append(h('div', { class: 'card' }, h('h2', null, 'Outbox'), out.length ? h('div', { class: 'table-wrap', style: { maxHeight: '45vh' } }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['When', 'To', 'Subject', 'Files', 'Status'].map(x => h('th', null, x)))),
    h('tbody', null, out.map(o => h('tr', null, h('td', { class: 'small' }, fdatetime(o.created_at)), h('td', { class: 'small' }, o.to_addr, o.cc ? h('div', { class: 'faint' }, `cc ${o.cc}`) : null),
      h('td', null, h('a', { href: `/api/outbox/${o.id}`, target: '_blank' }, o.subject || '(no subject)')), h('td', { class: 'small' }, o.attachments.map(a => a.filename).join(', ')),
      h('td', null, h('span', { class: 'badge ' + ({ sent: 'ok', dry_run: 'blue', failed: 'bad' }[o.status] || ''), title: o.error || '' }, o.status === 'dry_run' ? 'dry run' : o.status))))))) : h('div', { class: 'empty' }, 'No email yet.')));
  view.append(h('div', { class: 'card' }, h('h2', null, 'Audit log'), h('div', { class: 'table-wrap', style: { maxHeight: '50vh' } }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['When', 'Who', 'What', 'Detail'].map(x => h('th', null, x)))),
    h('tbody', null, log.map(a => h('tr', null, h('td', { class: 'small' }, fdatetime(a.created_at)), h('td', { class: 'small' }, a.user_name || a.source),
      h('td', { class: 'small' }, `${a.entity} ${a.field}`), h('td', { class: 'small muted', style: { maxWidth: '520px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: a.new_value || '' }, a.new_value || a.old_value || ''))))))));
}

boot();
