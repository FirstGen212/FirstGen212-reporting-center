/* Reports: build reports on the core database, report types & customer reports, exports, scheduled
   email, external share links and the data audit. */
'use strict';

const RC = { tab: 'reports', meta: null, draft: null, result: null, audit: null, side: 'preview' };
const OP_LABELS = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: "doesn't contain", starts_with: 'starts with', ends_with: 'ends with',
  in: 'is any of', not_in: 'is none of', empty: 'is empty', not_empty: 'is not empty', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'is between',
  on: 'is on', before: 'is before', after: 'is after', last_days: 'in the last N days', next_days: 'in the next N days',
  this_month: 'is this month', last_month: 'is last month', this_year: 'is this year', is_true: 'is yes', is_false: 'is no',
};
const NO_VALUE = ['empty', 'not_empty', 'this_month', 'last_month', 'this_year', 'is_true', 'is_false'];
const AGG_LABELS = { '': 'Value', count: 'Count', count_distinct: 'Count distinct', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' };
const FMT_LABELS = { xlsx: 'Excel', csv: 'CSV', pdf: 'PDF' };
const KIND_LABEL = { text: 'text', number: 'number', date: 'date', boolean: 'yes/no', list: 'list', json: 'JSON' };

const tzTime = iso => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: RC.meta.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const rowsEst = n => (Number(n) > 0 ? `~${Number(n).toLocaleString()} rows` : 'size unknown');
const rcTable = key => RC.meta.tables.find(t => t.key === key);
const rcField = (table, id) => table?.fields.find(f => f.id === id);
const tLabel = t => (t ? String(t.name).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
/** Every field a report can use: its main table's, plus those of linked tables (ids "j1:field"). */
function rcScope(spec) {
  const base = rcTable(spec.table);
  const fields = (base?.fields || []).map(f => ({ ...f, group: (spec.joins || []).length ? tLabel(base) : null, table: base?.key }));
  for (const j of spec.joins || []) {
    const t = rcTable(j.table);
    for (const f of t?.fields || []) fields.push({ ...f, id: `${j.id}:${f.id}`, label: `${tLabel(t)} › ${f.label}`, short: f.label, group: tLabel(t), table: t.key, join: j.id });
  }
  return { key: spec.table, fields };
}
/** Where a field from any table lands in this report: the field id to use, linking the table in first if needed. */
async function rcPlaceField(d, tableKey, fieldId, { link = false } = {}) {
  const s = d.spec;
  s.joins = s.joins || [];
  if (tableKey === s.table) return fieldId;
  const have = s.joins.find(j => j.table === tableKey);
  if (have) return `${have.id}:${fieldId}`;
  if (!link && !s.columns.length && !s.filters.length && !s.joins.length && !d.required.length) {
    s.table = tableKey; s.latest = null; s.sort = []; s.customer_field = null;
    return fieldId;
  }
  const id = 'j' + (Math.max(0, ...s.joins.map(j => Number(j.id.slice(1)) || 0)) + 1);
  const j = { id, table: tableKey, on: { left: '', right: '' }, keep_unmatched: true, latest: null };
  let sug = null;
  try { sug = await api('POST', '/api/rc/link-suggest', { spec: s, table: tableKey }); } catch {}
  const best = sug?.suggestions?.[0];
  if (best && (best.fk || best.rate >= 20)) {
    j.on = { left: best.left, right: best.right };
    j._note = `Linked automatically: ${best.left_label} = ${tLabel(rcTable(tableKey))} › ${best.right_label}${best.fk ? '' : ` (${best.rate}% of sampled values match)`}.`
      + (best.repeats ? ` Some values match more than one ${tLabel(rcTable(tableKey))} row, so those rows repeat. If it's a history table, turn on "only its newest row" below.` : '');
    toast(`Linked ${tLabel(rcTable(tableKey))} to the report`);
  } else {
    j._note = `Couldn't tell how ${tLabel(rcTable(tableKey))} links to the report. Choose the matching fields below.`;
    j._open = true;
  }
  j._suggestions = sug?.suggestions || [];
  s.joins.push(j);
  return `${id}:${fieldId}`;
}
/** A search box over every field in every table the user can report on. */
function fieldFinder(d, onPick, { placeholder = 'Search fields in every table…', filter = null } = {}) {
  const wrap = h('div', { class: 'rc-finder' });
  const list = h('div', { class: 'rc-finder-list hidden', role: 'listbox' });
  const inScope = new Set([d.spec.table, ...(d.spec.joins || []).map(j => j.table)]);
  const all = [];
  for (const t of RC.meta.tables) for (const f of t.fields) if (!filter || filter(f)) all.push({ t, f, hay: `${f.label} ${f.id} ${t.name}`.toLowerCase() });
  const draw = () => {
    const words = inp.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = all.filter(x => words.every(w => x.hay.includes(w)))
      .sort((a, b) => (inScope.has(b.t.key) - inScope.has(a.t.key)) || a.f.label.localeCompare(b.f.label)).slice(0, 60);
    list.replaceChildren(...hits.map(x => h('button', { type: 'button', class: 'rc-finder-item', onmousedown: async e => { e.preventDefault(); inp.value = ''; list.classList.add('hidden'); await onPick(x.t.key, x.f.id); } },
      h('span', null, x.f.label), h('span', { class: 'faint small' }, ` ${tLabel(x.t)}${inScope.has(x.t.key) ? '' : ' (will be linked)'} · ${KIND_LABEL[x.f.kind] || x.f.kind}`))));
    if (!hits.length) list.append(h('div', { class: 'small muted', style: { padding: '8px 10px' } }, 'No fields match.'));
    list.classList.remove('hidden');
  };
  const inp = h('input', { type: 'search', placeholder, oninput: draw, onfocus: draw, onblur: () => setTimeout(() => list.classList.add('hidden'), 150),
    onkeydown: e => { if (e.key === 'Escape') { list.classList.add('hidden'); inp.blur(); } if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.rc-finder-item')?.dispatchEvent(new MouseEvent('mousedown')); } } });
  wrap.append(inp, list);
  return wrap;
}
const fmtCell = (v, kind) => {
  if (v == null || v === '') return h('span', { class: 'faint' }, '—');
  if (kind === 'number' && typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.endsWith('T00:00:00.000Z') ? v.slice(0, 10) : fdatetime(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

// Downloads go through fetch so a held-back export can explain itself (and admins can choose to export anyway).
async function rcDownload(method, url, body) {
  const go = async override => {
    let u = url, b = body;
    if (override) { if (method === 'GET') u += (u.includes('?') ? '&' : '?') + 'override=1'; else b = { ...body, override: true }; }
    const res = await fetch(u, { method, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && !override && (RC.meta.caps.manage || RC.meta.caps.admin)) {
        if (await confirmBox(`${data.error} Export anyway? This is recorded in the audit history.`, 'Export anyway')) return go(true);
        return;
      }
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'report';
    const a = h('a', { href: URL.createObjectURL(await res.blob()), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`Downloaded ${name}`);
  };
  try { await go(false); } catch (e) { toast(e.message, 'err'); }
}
const formatMenu = (onPick, label = 'Export') => {
  const sel = h('select', { 'aria-label': label, onchange: e => { const v = e.target.value; e.target.value = ''; if (v) onPick(v); } },
    h('option', { value: '' }, `${label}…`), Object.entries(FMT_LABELS).map(([k, l]) => h('option', { value: k }, l)));
  return sel;
};

// ------------------------------------------------------------------ entry
async function viewReporting(view, arg) {
  if (!can('view_reporting')) { view.append(h('div', { class: 'callout warn' }, 'Your role cannot run reports yet. Ask an admin for access.')); return; }
  RC.meta = await api('GET', '/api/rc/meta');
  if (arg) return viewReportEditor(view, arg);
  const c = RC.meta.caps;
  view.append(pageHead('Reports', 'Build reports on any field in the core database, send them on a schedule, share them, and check the data they depend on.',
    c.build ? h('button', { onclick: () => { location.hash = '#/reporting/new-type'; } }, '+ Report type') : null,
    c.build ? h('button', { class: 'primary', onclick: () => { location.hash = '#/reporting/new'; } }, '+ New report') : null));
  view.append(connectionNote());
  const tabs = [['reports', 'Reports'], ['types', 'Report types'], ['schedules', 'Schedules'], ...(c.share ? [['shares', 'Shared links']] : []), ['activity', 'Activity'], ...(c.manage ? [['data', 'Data settings']] : [])];
  if (!tabs.some(t => t[0] === RC.tab)) RC.tab = 'reports';
  view.append(h('div', { class: 'tabs', style: { marginBottom: '12px' } }, tabs.map(([k, l]) => h('button', { class: RC.tab === k ? 'on' : '', onclick: () => { RC.tab = k; route(); } }, l))));
  const body = h('div');
  view.append(body);
  if (RC.tab === 'reports') body.append(reportsList(RC.meta.reports.filter(r => r.kind === 'report')));
  if (RC.tab === 'types') body.append(typesList(RC.meta.reports.filter(r => r.kind === 'type')));
  if (RC.tab === 'schedules') body.append(await schedulesCard());
  if (RC.tab === 'shares') body.append(await sharesCard());
  if (RC.tab === 'activity') body.append(await activityCard());
  if (RC.tab === 'data') body.append(await dataSettingsCard());
}
function connectionNote() {
  const c = RC.meta.connection;
  if (!c.configured) return h('div', { class: 'callout warn', style: { marginBottom: '12px' } }, 'The database is not connected yet. An admin can add the connection under Settings, or set REPORTING_DB_URL on the server (a read-only database user is best).');
  if (c.error) return h('div', { class: 'callout warn', style: { marginBottom: '12px' } }, `Couldn't read the database: ${c.error}`);
  if (!RC.meta.tables.length) return h('div', { class: 'callout warn', style: { marginBottom: '12px' } }, c.found || c.no_access
    ? `${c.found} table${c.found === 1 ? ' was' : 's were'} found in the database${c.no_access ? ` and ${c.no_access} can't be read yet` : ''}, but none are available to you. ${RC.meta.caps.manage ? 'Choose them under Data settings.' : 'An admin can enable them under Data settings.'}`
    : 'No tables were found in the database. An admin can check Data settings.');
  return '';
}

function reportsList(list) {
  if (!list.length) return h('div', { class: 'card' }, h('div', { class: 'empty' }, 'No reports yet. ', RC.meta.caps.build ? h('a', { href: '#/reporting/new' }, 'Build the first one') : ''));
  return h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Report', 'Data', 'Owner', 'Updated', ''].map(x => h('th', null, x)))),
    h('tbody', null, list.map(r => h('tr', null,
      h('td', null, h('a', { href: `#/reporting/${r.id}` }, h('b', null, r.name)), r.description ? h('div', { class: 'small muted' }, r.description) : null),
      h('td', { class: 'small' }, r.type_id ? h('span', null, h('span', { class: 'badge blue' }, r.type_name || 'Type'), ' ', r.customer || '') : (r.spec.table || '').replace(/^public\./, '')),
      h('td', { class: 'small' }, r.owner_name || '—', r.shared ? '' : h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'private')),
      h('td', { class: 'small muted' }, fdatetime(r.updated_at)),
      h('td', { class: 'right' }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        formatMenu(fmt => rcDownload('GET', `/api/rc/reports/${r.id}/export?format=${fmt}`)),
        h('button', { class: 'sm', onclick: () => { location.hash = `#/reporting/${r.id}`; } }, 'Open'))))))));
}
function typesList(list) {
  const intro = h('p', { class: 'small muted', style: { marginTop: 0 } }, 'A report type is a template with a customer field and required data. Make a customer report from it for each customer, export one file per customer, and audit the data before anything goes out.');
  if (!list.length) return h('div', { class: 'card' }, intro, h('div', { class: 'empty' }, 'No report types yet. ', RC.meta.caps.build ? h('a', { href: '#/reporting/new-type' }, 'Create one') : ''));
  const count = id => RC.meta.reports.filter(r => r.type_id === id).length;
  return h('div', null, intro, h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Report type', 'Customer field', 'Required fields', 'If data is missing', 'Customer reports', ''].map(x => h('th', null, x)))),
    h('tbody', null, list.map(t => {
      const table = rcScope(t.spec);
      return h('tr', null,
        h('td', null, h('a', { href: `#/reporting/${t.id}` }, h('b', null, t.name)), t.description ? h('div', { class: 'small muted' }, t.description) : null),
        h('td', { class: 'small' }, rcField(table, t.spec.customer_field)?.label || t.spec.customer_field || '—'),
        h('td', { class: 'small' }, t.required.length || '—'),
        h('td', null, h('span', { class: 'badge ' + ({ block: 'bad', warn: 'warn' }[t.audit_mode] || '') }, { block: 'Hold the export', warn: 'Warn', off: 'No check' }[t.audit_mode])),
        h('td', { class: 'small' }, count(t.id)),
        h('td', { class: 'right' }, h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          RC.meta.caps.build ? h('button', { class: 'sm', onclick: () => addCustomersModal(t) }, '+ Customer reports') : null,
          formatMenu(fmt => rcDownload('GET', `/api/rc/reports/${t.id}/export-customers?format=${fmt}`), 'Export per customer'),
          h('button', { class: 'sm', onclick: () => { location.hash = `#/reporting/${t.id}`; } }, 'Open'))));
    })))));
}

async function addCustomersModal(t) {
  const box = h('div', { class: 'col' }, h('div', { class: 'muted small' }, 'Loading customers…'));
  const picked = new Set();
  const m = modal(`Customer reports from "${t.name}"`, box, { wide: true, actions: [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Create', primary: true, onClick: async c => { const out = await tryApi(() => api('POST', `/api/rc/reports/${t.id}/customers`, { customers: [...picked] })); toast(`${out.created} customer report(s) created${out.skipped ? `, ${out.skipped} already existed` : ''}`); c(); route(); } }] });
  try {
    const vals = await api('POST', '/api/rc/values', { table: t.spec.table, field: t.spec.customer_field, latest: t.spec.latest, joins: t.spec.joins || [] });
    const have = new Set(RC.meta.reports.filter(r => r.type_id === t.id).map(r => r.customer));
    const q = h('input', { placeholder: 'Search customers', oninput: () => draw() });
    const list = h('div', { class: 'form-grid', style: { maxHeight: '50vh', overflow: 'auto' } });
    const draw = () => { list.replaceChildren(...vals.filter(v => String(v.value).toLowerCase().includes(q.value.toLowerCase())).map(v => h('label', { class: 'check small' },
      h('input', { type: 'checkbox', disabled: have.has(String(v.value)), checked: picked.has(String(v.value)) || have.has(String(v.value)), onchange: e => { e.target.checked ? picked.add(String(v.value)) : picked.delete(String(v.value)); } }),
      `${v.value} `, h('span', { class: 'faint' }, `(${v.count})`)))); };
    box.replaceChildren(h('div', { class: 'row' }, q, h('button', { class: 'sm', onclick: () => { vals.forEach(v => { if (!have.has(String(v.value))) picked.add(String(v.value)); }); draw(); } }, 'Select all')), list,
      h('div', { class: 'small muted' }, 'Ticked and greyed out means a customer report already exists.'));
    draw();
  } catch (e) { box.replaceChildren(h('div', { class: 'callout warn' }, e.message)); }
  return m;
}

// ------------------------------------------------------------------ editor
function blankDraft(kind) {
  const t = RC.meta.tables[0];
  return { id: null, name: '', description: '', kind, type_id: null, customer: '', shared: true, audit_mode: 'warn', default_format: 'xlsx', can_edit: true,
    spec: { table: t?.key || '', columns: [], filters: [], match: 'all', latest: null, sort: [], limit: null, customer_field: null, joins: [] }, required: [] };
}
async function viewReportEditor(view, arg) {
  if (arg === 'new' || arg === 'new-type') { if (!RC.draft || RC.draft.id || RC.draft._new !== arg) { RC.draft = { ...blankDraft(arg === 'new-type' ? 'type' : 'report'), _new: arg }; RC.result = null; RC.audit = null; } }
  else if (!RC.draft || String(RC.draft.id) !== String(arg)) { RC.draft = await api('GET', `/api/rc/reports/${arg}`); RC.result = null; RC.audit = null; RC.side = 'preview'; }
  const d = RC.draft;
  const type = d.type_id ? RC.meta.reports.find(r => r.id === d.type_id) : null;
  const spec = type ? type.spec : d.spec;
  const editable = d.can_edit && RC.meta.caps.build;
  const isNew = !d.id;

  view.append(pageHead(isNew ? (d.kind === 'type' ? 'New report type' : 'New report') : d.name,
    type ? `Customer report made from the "${type.name}" type` : d.kind === 'type' ? 'Report type: a template for customer reports' : 'Report',
    h('a', { href: '#/reporting', class: 'btn' }, '← All reports'),
    !isNew ? formatMenu(fmt => rcDownload('GET', `/api/rc/reports/${d.id}/export?format=${fmt}${d.customer ? '' : RC.customerPick ? '&customer=' + encodeURIComponent(RC.customerPick) : ''}`)) : formatMenu(fmt => rcDownload('POST', '/api/rc/export', { name: d.name || 'Report', spec, required: d.required, audit_mode: d.audit_mode, format: fmt, customer: RC.customerPick || null })),
    editable && !isNew ? h('button', { class: 'danger', onclick: deleteReport }, 'Delete') : null,
    editable ? h('button', { class: 'primary', onclick: saveReport }, isNew ? 'Save' : 'Save changes') : null));
  view.append(connectionNote());

  const left = h('div', { class: 'col', style: { gap: '14px' } });
  left.append(basicsCard(d, editable, type));
  if (type) left.append(h('div', { class: 'card' }, h('h2', null, 'Definition'), h('p', { class: 'small muted' }, 'Columns, filters and required data come from the report type, so every customer report stays the same shape.'),
    h('a', { class: 'btn', href: `#/reporting/${type.id}` }, `Open "${type.name}"`)));
  else left.append(definitionCard(d, editable), auditRulesCard(d, editable));
  const right = h('div', { class: 'col', style: { gap: '14px', minWidth: 0 } });
  view.append(h('div', { class: 'rc-grid' }, left, right));
  drawSide(right, d, spec);
}

function basicsCard(d, editable, type) {
  const dis = !editable;
  return h('div', { class: 'card' }, h('h2', null, 'Report'),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Name', h('input', { value: d.name, disabled: dis, placeholder: d.kind === 'type' ? 'e.g. Monthly census roster' : 'e.g. Active employees by company', oninput: e => { d.name = e.target.value; } })),
      d.type_id ? h('label', { class: 'field' }, 'Customer', customerInput(type.spec, d.customer, v => { d.customer = v; RC.result = null; }, dis)) : null,
      h('label', { class: 'field' }, 'Default file', h('select', { disabled: dis, onchange: e => { d.default_format = e.target.value; } }, Object.entries(FMT_LABELS).map(([k, l]) => h('option', { value: k, selected: d.default_format === k }, l)))),
      h('label', { class: 'field' }, 'Visible to', h('select', { disabled: dis, onchange: e => { d.shared = e.target.value === '1'; } }, h('option', { value: '1', selected: d.shared }, 'Everyone with Reporting Center access'), h('option', { value: '0', selected: !d.shared }, 'Only me (and admins)')))),
    h('label', { class: 'field', style: { marginTop: '10px' } }, 'Description', h('input', { value: d.description || '', disabled: dis, placeholder: 'Optional: what this report is for', oninput: e => { d.description = e.target.value; } })),
    !d.type_id && (d.spec.customer_field) ? h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'small muted' }, 'Run for customer'),
      customerInput(d.spec, RC.customerPick || '', v => { RC.customerPick = v; RC.result = null; }, false), h('span', { class: 'small faint' }, 'blank = all customers')) : null);
}
function customerInput(spec, value, onChange, disabled) {
  const id = 'rc-cust-' + Math.random().toString(36).slice(2);
  const list = h('datalist', { id });
  const inp = h('input', { value: value || '', list: id, disabled, placeholder: 'Pick or type a customer', onchange: e => onChange(e.target.value.trim()),
    onfocus: async () => { if (list.childElementCount || !spec.customer_field) return; try { const vals = await api('POST', '/api/rc/values', { table: spec.table, field: spec.customer_field, latest: spec.latest, joins: spec.joins || [] }); vals.forEach(v => list.append(h('option', { value: v.value }))); } catch {} } });
  return h('span', null, inp, list);
}

function fieldSelect(table, value, onChange, { disabled, allowCount = false, filter = null, placeholder = 'Choose a field' } = {}) {
  const sel = h('select', { disabled, onchange: e => onChange(e.target.value) }, h('option', { value: '' }, placeholder));
  if (allowCount) sel.append(h('option', { value: '*', selected: value === '*' }, 'Count of rows'));
  const groups = new Map();
  for (const f of (table?.fields || []).filter(f => !filter || filter(f))) {
    const inner = f.json ? `Inside ${(f.join ? f.id.split(':')[1] : f.id).split('.')[0]}` : 'Columns';
    const g = f.group ? `${f.group} · ${inner}` : inner;
    if (!groups.has(g)) groups.set(g, h('optgroup', { label: g }));
    groups.get(g).append(h('option', { value: f.id, selected: f.id === value }, `${f.short || f.label} · ${KIND_LABEL[f.kind] || f.kind}${f.fill != null && f.fill < 100 ? ` · ${f.fill}% filled` : ''}`));
  }
  sel.append(...groups.values());
  if (value && value !== '*' && !table?.fields.some(f => f.id === value)) sel.append(h('option', { value, selected: true }, value));
  return sel;
}

function definitionCard(d, editable) {
  const dis = !editable, s = d.spec;
  s.joins = s.joins || [];
  const baseTable = rcTable(s.table);
  const table = rcScope(s);
  const card = h('div', { class: 'card' });
  const redraw = () => card.replaceWith(definitionCard(d, editable));
  const changed = () => { RC.result = null; };
  const tableSel = h('select', { disabled: dis, onchange: e => { s.table = e.target.value; s.columns = []; s.filters = []; s.latest = null; s.sort = []; s.customer_field = null; s.joins = []; d.required = []; changed(); route(); } },
    RC.meta.tables.map(t => h('option', { value: t.key, selected: t.key === s.table }, `${t.schema === 'public' ? t.name : t.key}${t.view ? ' (view)' : ''} · ${rowsEst(t.est_rows)}`)));

  // columns
  const cols = h('div', { class: 'col' });
  s.columns.forEach((c, i) => {
    const f = rcField(table, c.field);
    const aggs = c.field === '*' ? ['count'] : ['', 'count', 'count_distinct', ...(f?.kind === 'number' ? ['sum', 'avg'] : []), ...(['number', 'date', 'text'].includes(f?.kind) ? ['min', 'max'] : [])];
    cols.append(h('div', { class: 'rc-row' },
      fieldSelect(table, c.field, v => { c.field = v; if (v === '*') c.agg = 'count'; changed(); redraw(); }, { disabled: dis, allowCount: true }),
      h('select', { disabled: dis || c.field === '*', title: 'Show the value, or summarise it', onchange: e => { c.agg = e.target.value || undefined; changed(); } }, aggs.map(a => h('option', { value: a, selected: (c.agg || '') === a }, AGG_LABELS[a]))),
      h('input', { value: c.label || '', disabled: dis, placeholder: f?.label || 'Column name', oninput: e => { c.label = e.target.value || undefined; } }),
      dis ? null : h('span', { class: 'row', style: { gap: '2px' } },
        h('button', { class: 'ghost sm', title: 'Move up', disabled: !i, onclick: () => { [s.columns[i - 1], s.columns[i]] = [s.columns[i], s.columns[i - 1]]; changed(); redraw(); } }, '↑'),
        h('button', { class: 'ghost sm', 'aria-label': 'Remove column', onclick: () => { s.columns.splice(i, 1); s.sort = s.sort.filter(x => x.col !== i).map(x => ({ ...x, col: x.col > i ? x.col - 1 : x.col })); changed(); redraw(); } }, icon('x', 14)))));
  });
  if (!s.columns.length) cols.append(h('div', { class: 'small muted' }, 'No columns yet.'));
  const addCols = dis ? null : h('div', { class: 'col', style: { gap: '6px', marginTop: '6px' } },
    fieldFinder(d, async (tk, fid) => { const id = await rcPlaceField(d, tk, fid); s.columns.push({ field: id }); changed(); route(); }, { placeholder: '+ Add a column: search fields in every table…' }),
    h('div', { class: 'row wrap' },
      h('button', { class: 'sm', onclick: () => { s.columns.push({ field: '*', agg: 'count' }); changed(); redraw(); } }, '+ Count of rows'),
      h('button', { class: 'sm', onclick: () => { const have = new Set(s.columns.map(c => c.field)); (baseTable?.fields || []).filter(f => !have.has(f.id) && f.kind !== 'json' && f.kind !== 'list').slice(0, 40).forEach(f => s.columns.push({ field: f.id })); changed(); redraw(); } }, `Add all ${tLabel(baseTable)} fields`)));

  // filters
  const flts = h('div', { class: 'col' });
  s.filters.forEach((flt, i) => {
    const f = rcField(table, flt.field);
    const ops = RC.meta.ops[f?.kind] || RC.meta.ops.text;
    if (!ops.includes(flt.op)) flt.op = ops[0];
    const valIn = (key, ph) => h('input', { value: flt[key] ?? '', disabled: dis, type: f?.kind === 'date' && !['last_days', 'next_days'].includes(flt.op) ? 'text' : 'text', placeholder: ph, oninput: e => { flt[key] = e.target.value; changed(); } });
    const ph = f?.kind === 'date' ? (['last_days', 'next_days'].includes(flt.op) ? 'days' : 'YYYY-MM-DD') : ['in', 'not_in'].includes(flt.op) ? 'a, b, c' : 'value or {{customer}}';
    flts.append(h('div', { class: 'rc-row' },
      fieldSelect(table, flt.field, v => { flt.field = v; changed(); redraw(); }, { disabled: dis }),
      h('select', { disabled: dis, onchange: e => { flt.op = e.target.value; changed(); redraw(); } }, ops.map(o => h('option', { value: o, selected: flt.op === o }, OP_LABELS[o] || o))),
      NO_VALUE.includes(flt.op) ? h('span') : h('span', { class: 'row' }, valIn('value', ph), flt.op === 'between' ? valIn('value2', ph) : null),
      dis ? null : h('button', { class: 'ghost sm', 'aria-label': 'Remove filter', onclick: () => { s.filters.splice(i, 1); changed(); redraw(); } }, icon('x', 14))));
  });
  const addFilter = dis ? null : fieldFinder(d, async (tk, fid) => {
    const id = await rcPlaceField(d, tk, fid);
    s.filters.push({ field: id, op: (RC.meta.ops[rcField(rcTable(tk), fid)?.kind] || RC.meta.ops.text)[0], value: '' }); changed(); route();
  }, { placeholder: '+ Add a filter: search fields…' });

  // linked tables
  const joinsBox = h('div', { class: 'col', style: { gap: '8px' } });
  s.joins.forEach((j, i) => {
    const t = rcTable(j.table);
    const before = rcScope({ ...s, joins: s.joins.slice(0, i) });
    const uses = id => String(id || '').startsWith(j.id + ':');
    const latestOnJ = !!j.latest;
    const box = h('div', { class: 'rc-join' + (!j.on.left || !j.on.right ? ' warn' : '') },
      h('div', { class: 'row' }, h('b', null, tLabel(t) || j.table), h('span', { class: 'small muted' }, t ? ` ${rowsEst(t.est_rows)}` : ' (no access)'), h('span', { class: 'spacer' }),
        dis ? null : h('button', { class: 'ghost sm', 'aria-label': 'Remove linked table', title: 'Remove this table and its columns and filters', onclick: () => {
          s.joins.splice(i, 1); s.columns = s.columns.filter(c => !uses(c.field)); s.filters = s.filters.filter(f => !uses(f.field)); d.required = d.required.filter(r => !uses(r.field));
          if (uses(s.customer_field)) s.customer_field = null; s.sort = s.sort.filter(x => s.columns[x.col]); changed(); route(); } }, icon('x', 14))),
      j._note ? h('div', { class: 'small muted' }, j._note) : null,
      h('div', { class: 'rc-row' }, h('span', { class: 'small muted' }, 'Match'),
        fieldSelect(before, j.on.left, v => { j.on.left = v; j._note = null; changed(); redraw(); }, { disabled: dis, filter: f => f.kind === 'text' || f.kind === 'number', placeholder: 'a field in the report' }),
        h('span', { class: 'small muted' }, 'with'),
        fieldSelect(t, j.on.right, v => { j.on.right = v; j._note = null; changed(); redraw(); }, { disabled: dis, filter: f => f.kind === 'text' || f.kind === 'number', placeholder: `a ${tLabel(t)} field` })),
      (j._suggestions || []).length > 1 && !dis ? h('div', { class: 'row wrap small' }, h('span', { class: 'muted' }, 'Other matches:'),
        j._suggestions.filter(x => x.left !== j.on.left || x.right !== j.on.right).slice(0, 3).map(x => h('button', { class: 'sm', onclick: () => { j.on = { left: x.left, right: x.right }; j._note = null; changed(); redraw(); } }, `${x.left_label} = ${x.right_label}${x.fk ? '' : ` · ${x.rate}%`}`))) : null,
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', disabled: dis, checked: j.keep_unmatched !== false, onchange: e => { j.keep_unmatched = e.target.checked; changed(); } }),
        `Keep report rows that have no matching ${tLabel(t)} row`),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', disabled: dis, checked: latestOnJ, onchange: e => {
        j.latest = e.target.checked ? { key: t?.fields.find(f => /(^|_)id$/i.test(f.id) && !f.json && f.id !== 'id')?.id || '', order: t?.fields.find(f => f.kind === 'date' && !f.json)?.id || '', as_of: '' } : null; changed(); redraw(); } }),
        `Use only the newest ${tLabel(t)} row for each record`),
      latestOnJ ? h('div', { class: 'rc-row' }, h('span', { class: 'small muted' }, 'One row per'), fieldSelect(t, j.latest.key, v => { j.latest.key = v; changed(); }, { disabled: dis }),
        h('span', { class: 'small muted' }, 'newest by'), fieldSelect(t, j.latest.order, v => { j.latest.order = v; changed(); }, { disabled: dis, filter: f => f.kind === 'date' || f.kind === 'number' })) : null);
    joinsBox.append(box);
  });
  const others = RC.meta.tables.filter(t => t.key !== s.table && !s.joins.some(j => j.table === t.key));
  const addJoin = dis || !others.length ? null : h('select', { onchange: async e => {
    const tk = e.target.value; if (!tk) return; e.target.disabled = true;
    await rcPlaceField(d, tk, '', { link: true }); changed(); route(); } },
    h('option', { value: '' }, '+ Link another table'), others.map(t => h('option', { value: t.key }, `${tLabel(t)} · ${rowsEst(t.est_rows)}`)));

  // newest row per record
  const latestOn = !!s.latest;
  const latest = h('div', { class: 'col' },
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', disabled: dis, checked: latestOn, onchange: e => {
      s.latest = e.target.checked ? { key: baseTable?.fields.find(f => /(^|_)id$/i.test(f.id) && !f.json && f.id !== 'id')?.id || baseTable?.fields[0]?.id || '', order: baseTable?.fields.find(f => f.kind === 'date' && !f.json)?.id || '', as_of: '' } : null; changed(); redraw(); } }),
      `Only the newest ${tLabel(baseTable)} row for each record (for history / snapshot tables)`),
    latestOn ? h('div', { class: 'rc-row' },
      h('span', { class: 'small muted' }, 'One row per'), fieldSelect(baseTable, s.latest.key, v => { s.latest.key = v; changed(); }, { disabled: dis }),
      h('span', { class: 'small muted' }, 'newest by'), fieldSelect(baseTable, s.latest.order, v => { s.latest.order = v; changed(); }, { disabled: dis, filter: f => f.kind === 'date' || f.kind === 'number' }),
      h('input', { value: s.latest.as_of || '', disabled: dis, placeholder: 'as of (YYYY-MM-DD, blank = now)', title: 'Rebuild the data as it stood on this date. {{today}} works too.', oninput: e => { s.latest.as_of = e.target.value; changed(); } })) : null);

  // sort, limit, customer field
  const sortRows = h('div', { class: 'row wrap' });
  const colOpts = sel => s.columns.map((c, i) => h('option', { value: i, selected: sel === i }, c.label || (c.field === '*' ? 'Count' : rcField(table, c.field)?.label || c.field)));
  s.sort.forEach((x, i) => sortRows.append(h('span', { class: 'chip' }, h('select', { disabled: dis, onchange: e => { x.col = Number(e.target.value); changed(); } }, colOpts(x.col)),
    h('select', { disabled: dis, onchange: e => { x.dir = e.target.value; changed(); } }, h('option', { value: 'asc', selected: x.dir !== 'desc' }, 'A→Z / low→high'), h('option', { value: 'desc', selected: x.dir === 'desc' }, 'Z→A / high→low')),
    dis ? null : h('button', { 'aria-label': 'Remove sort', onclick: () => { s.sort.splice(i, 1); changed(); redraw(); } }, '×'))));
  if (!dis && s.columns.length && s.sort.length < 3) sortRows.append(h('button', { class: 'sm', onclick: () => { s.sort.push({ col: 0, dir: 'asc' }); redraw(); } }, '+ Sort'));

  card.append(...[h('div', { class: 'card-head' }, h('h2', null, 'Data'), h('span', { class: 'spacer' }), h('button', { class: 'sm', onclick: () => runPreview() }, icon('refresh', 14), 'Run')),
    h('label', { class: 'field' }, s.joins.length ? 'Main table' : 'Table', tableSel),
    s.joins.length ? h('h3', null, 'Linked tables') : null, joinsBox, addJoin ? h('div', { style: { marginTop: '6px' } }, addJoin) : null,
    h('h3', null, 'Columns'), cols, addCols,
    h('h3', null, 'Filters ', s.filters.length > 1 ? h('select', { disabled: dis, class: 'sm', onchange: e => { s.match = e.target.value; changed(); } }, h('option', { value: 'all', selected: s.match !== 'any' }, 'match all'), h('option', { value: 'any', selected: s.match === 'any' }, 'match any')) : null),
    flts, addFilter,
    h('h3', null, 'History'), latest,
    h('h3', null, 'Sort & size'), sortRows,
    h('div', { class: 'form-grid', style: { marginTop: '8px' } },
      h('label', { class: 'field' }, 'Row limit', h('input', { type: 'number', min: 1, disabled: dis, value: s.limit || '', placeholder: `all (max ${RC.meta.max_rows.toLocaleString()})`, oninput: e => { s.limit = Number(e.target.value) || null; changed(); } })),
      h('label', { class: 'field' }, d.kind === 'type' ? 'Customer field (required for a type)' : 'Customer field (optional)',
        fieldSelect(table, s.customer_field || '', v => { s.customer_field = v || null; changed(); route(); }, { disabled: dis, filter: f => f.kind === 'text' || f.kind === 'number', placeholder: 'None' })))].filter(x => x != null));
  return card;
}

function auditRulesCard(d, editable) {
  const dis = !editable;
  const table = rcScope(d.spec);
  const card = h('div', { class: 'card' });
  const redraw = () => card.replaceWith(auditRulesCard(d, editable));
  const rows = h('div', { class: 'col' });
  d.required.forEach((r, i) => rows.append(h('div', { class: 'rc-row' },
    fieldSelect(table, r.field, v => { r.field = v; }, { disabled: dis }),
    h('select', { disabled: dis, onchange: e => { r.rule = e.target.value; redraw(); } }, Object.entries(RC.meta.rules).map(([k, l]) => h('option', { value: k, selected: r.rule === k }, l))),
    ['one_of', 'regex', 'min_length'].includes(r.rule) ? h('input', { value: r.arg || '', disabled: dis, placeholder: r.rule === 'one_of' ? 'a, b, c' : r.rule === 'regex' ? '^[A-Z]{3}\\d+$' : '3', oninput: e => { r.arg = e.target.value; } }) : h('span'),
    h('select', { disabled: dis, onchange: e => { r.severity = e.target.value; } }, h('option', { value: 'critical', selected: r.severity !== 'warning' }, 'Critical'), h('option', { value: 'warning', selected: r.severity === 'warning' }, 'Warning')),
    dis ? null : h('button', { class: 'ghost sm', 'aria-label': 'Remove check', onclick: () => { d.required.splice(i, 1); redraw(); } }, icon('x', 14)))));
  if (!d.required.length) rows.append(h('div', { class: 'small muted' }, 'No required fields yet. Add the fields an export cannot work without.'));
  card.append(h('h2', null, 'Required data'),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'The data audit checks these before an export, a scheduled email or a shared link. Critical problems can hold the report back until the data is fixed.'),
    rows,
    dis ? null : h('div', { class: 'row wrap', style: { marginTop: '6px' } },
      fieldSelect(table, '', v => { if (v) { d.required.push({ field: v, rule: 'required', severity: 'critical' }); redraw(); } }, { placeholder: '+ Add a required field' }),
      h('button', { class: 'sm', onclick: () => { const have = new Set(d.required.map(r => r.field)); d.spec.columns.filter(c => c.field !== '*' && !c.agg && !have.has(c.field)).forEach(c => d.required.push({ field: c.field, rule: 'required', severity: 'critical' })); redraw(); } }, 'Require every column')),
    h('label', { class: 'field', style: { marginTop: '10px', maxWidth: '360px' } }, 'When critical data is missing',
      h('select', { disabled: dis, onchange: e => { d.audit_mode = e.target.value; } },
        h('option', { value: 'block', selected: d.audit_mode === 'block' }, 'Hold the export and tell the owner'),
        h('option', { value: 'warn', selected: d.audit_mode === 'warn' }, 'Send it, with a warning'),
        h('option', { value: 'off', selected: d.audit_mode === 'off' }, "Don't check"))));
  return card;
}

async function saveReport() {
  const d = RC.draft;
  const body = { name: d.name, description: d.description, kind: d.kind, type_id: d.type_id, customer: d.customer, spec: d.spec, required: d.required, audit_mode: d.audit_mode, default_format: d.default_format, shared: d.shared };
  const out = await tryApi(() => (d.id ? api('PUT', `/api/rc/reports/${d.id}`, body) : api('POST', '/api/rc/reports', body)), 'Saved');
  RC.draft = { ...out, can_edit: true };
  if (location.hash !== `#/reporting/${out.id}`) location.hash = `#/reporting/${out.id}`; else route();
}
async function deleteReport() {
  const d = RC.draft;
  if (!(await confirmBox(`Delete "${d.name}"? Its schedules and shared links stop working.`, 'Delete'))) return;
  await tryApi(() => api('DELETE', `/api/rc/reports/${d.id}`), 'Deleted');
  RC.draft = null; location.hash = '#/reporting';
}

// ------------------------------------------------------------------ right side: preview, audit, schedules, links
function drawSide(box, d, spec) {
  const tabs = [['preview', 'Preview'], ['audit', 'Data audit'], ...(d.id ? [['schedules', 'Schedules'], ...(RC.meta.caps.share ? [['links', 'Shared links']] : [])] : [])];
  if (!tabs.some(t => t[0] === RC.side)) RC.side = 'preview';
  const body = h('div');
  box.append(h('div', { class: 'card' }, h('div', { class: 'tabs', style: { marginTop: 0, marginBottom: '10px' } }, tabs.map(([k, l]) => h('button', { class: RC.side === k ? 'on' : '', onclick: () => { RC.side = k; route(); } }, l))), body));
  if (RC.side === 'preview') previewPane(body, d, spec);
  if (RC.side === 'audit') auditPane(body, d, spec);
  if (RC.side === 'schedules') schedulesForReport(body, d);
  if (RC.side === 'links') linksForReport(body, d);
}
const runCustomer = d => d.customer || RC.customerPick || null;
async function runPreview() {
  const d = RC.draft, type = d.type_id ? RC.meta.reports.find(r => r.id === d.type_id) : null;
  RC.side = 'preview';
  try { RC.result = await api('POST', '/api/rc/preview', { spec: type ? type.spec : d.spec, customer: runCustomer(d), limit: 200 }); }
  catch (e) { RC.result = { error: e.message }; }
  route();
}
function previewPane(body, d, spec) {
  if (!RC.result) {
    body.append(h('div', { class: 'empty' }, spec.columns?.length ? h('button', { class: 'primary', onclick: runPreview }, icon('refresh', 14), 'Run preview') : 'Add columns on the left, then run a preview.'));
    return;
  }
  const r = RC.result;
  if (r.error) { body.append(h('div', { class: 'callout warn' }, r.error), h('button', { class: 'sm', style: { marginTop: '8px' }, onclick: runPreview }, 'Try again')); return; }
  body.append(h('div', { class: 'row', style: { marginBottom: '8px' } },
    h('span', { class: 'small muted' }, `${r.rows.length.toLocaleString()} row(s)${r.truncated ? ' shown (preview is limited; exports include everything)' : ''} · ${r.ms} ms${runCustomer(d) ? ` · ${runCustomer(d)}` : ''}`),
    h('span', { class: 'spacer' }), h('button', { class: 'sm', onclick: runPreview }, icon('refresh', 14), 'Refresh')));
  body.append(h('div', { class: 'table-wrap', style: { maxHeight: '62vh' } }, h('table', { class: 't rc-nowrap' },
    h('thead', null, h('tr', null, r.columns.map(c => h('th', { class: c.kind === 'number' ? 'num' : '' }, c.label)))),
    h('tbody', null, r.rows.length ? r.rows.map(row => h('tr', null, row.map((v, i) => h('td', { class: r.columns[i].kind === 'number' ? 'num' : '' }, fmtCell(v, r.columns[i].kind)))))
      : h('tr', null, h('td', { colspan: r.columns.length, class: 'empty' }, 'No rows match.'))))));
  if (r.sql) body.append(h('details', { class: 'small muted', style: { marginTop: '8px' } }, h('summary', null, 'SQL (admins only)'), h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, r.sql.text, '\n\n', JSON.stringify(r.sql.params))));
}

async function auditPane(body, d, spec) {
  const type = d.type_id ? RC.meta.reports.find(r => r.id === d.type_id) : null;
  const required = type ? type.required : d.required;
  const req = () => (d.id ? { report_id: d.id, customer: runCustomer(d) } : { spec, required, customer: runCustomer(d), name: d.name });
  const run = async () => { body.replaceChildren(h('div', { class: 'empty' }, 'Checking the data…')); try { RC.audit = await api('POST', '/api/rc/audit', req()); } catch (e) { RC.audit = { error: e.message }; } route(); };
  if (!required.length) body.append(h('div', { class: 'callout info', style: { marginBottom: '10px' } }, 'No required fields are set, so the audit shows fill rates only. Add required fields under "Required data".'));
  if (!RC.audit) { body.append(h('div', { class: 'empty' }, h('button', { class: 'primary', onclick: run }, 'Run the data audit'))); return; }
  const a = RC.audit;
  if (a.error) { body.append(h('div', { class: 'callout warn' }, a.error)); return; }
  body.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
    h('span', { class: 'badge ' + (a.passed ? (a.rows_with_issues ? 'warn' : 'ok') : 'bad') }, a.passed ? (a.rows_with_issues ? 'Warnings only' : 'Ready to export') : 'Critical data missing'),
    h('span', { class: 'small muted' }, `${a.summary}${a.truncated ? ' (checked the first rows only)' : ''}`), h('span', { class: 'spacer' }),
    h('button', { class: 'sm', onclick: run }, icon('refresh', 14), 'Re-run'),
    h('button', { class: 'sm', onclick: () => rcDownload('POST', '/api/rc/audit/export', { ...req(), format: 'xlsx' }) }, icon('download', 14), 'Rows to fix (Excel)')));
  body.append(h('div', { class: 'kpis' },
    kpi('Rows checked', a.checked_rows.toLocaleString(), a.truncated ? 'limit reached' : 'all matching rows'),
    kpi('Rows with problems', a.rows_with_issues.toLocaleString(), `${a.checked_rows ? Math.round((a.rows_with_issues / a.checked_rows) * 100) : 0}% of rows`, a.rows_with_issues ? 'bad' : 'ok'),
    kpi('Critical', a.critical_rows.toLocaleString(), a.critical_rows ? 'rows that can hold an export back' : 'nothing blocking', a.critical_rows ? 'bad' : 'ok')));
  if (a.rules.length) body.append(h('h3', null, 'Checks'), h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Field', 'Check', 'Severity', 'Missing', 'Invalid', 'OK'].map((x, i) => h('th', { class: i > 2 ? 'num' : '' }, x)))),
    h('tbody', null, a.rules.map(r => h('tr', null, h('td', null, r.label), h('td', { class: 'small' }, r.rule_label, r.arg ? ` (${r.arg})` : ''),
      h('td', null, h('span', { class: 'badge ' + (r.severity === 'critical' ? 'bad' : 'warn') }, r.severity)),
      h('td', { class: 'num' }, r.missing || '—'), h('td', { class: 'num' }, r.invalid || '—'), h('td', { class: 'num' }, `${r.ok_pct}%`)))))));
  if (a.customers.length) body.append(h('h3', null, 'By customer'), h('div', { class: 'table-wrap', style: { maxHeight: '240px' } }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Customer', 'Rows', 'With problems', 'Critical'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
    h('tbody', null, a.customers.map(c => h('tr', null, h('td', null, c.customer), h('td', { class: 'num' }, c.rows), h('td', { class: 'num' }, c.issue_rows || '—'),
      h('td', { class: 'num' }, c.critical_rows ? h('span', { class: 'badge bad' }, c.critical_rows) : '—')))))));
  if (a.issues.length) body.append(h('h3', null, `Rows to fix${a.issues_truncated ? ` (first ${a.issues.length.toLocaleString()})` : ''}`), h('div', { class: 'table-wrap', style: { maxHeight: '320px' } }, h('table', { class: 't' },
    h('thead', null, h('tr', null, [...(a.customers.length ? ['Customer'] : []), ...a.id_labels, 'Problems'].map(x => h('th', null, x)))),
    h('tbody', null, a.issues.slice(0, 300).map(i => h('tr', null, a.customers.length ? h('td', null, i.customer) : null, i.ids.map(x => h('td', null, fmtCell(x.value))),
      h('td', null, i.problems.map(p => h('span', { class: 'badge ' + (p.severity === 'critical' ? 'bad' : 'warn'), style: { marginRight: '4px' }, title: p.value != null ? `Current value: ${p.value}` : '' },
        `${p.label}: ${p.kind === 'missing' ? 'missing' : `not a ${p.rule.toLowerCase()}`}`)))))))));
  body.append(h('h3', null, 'Fill rate by column'), h('div', { class: 'col', style: { gap: '4px' } }, a.fill.map(f => h('div', { class: 'row small' },
    h('span', { style: { width: '40%' } }, f.label), h('div', { class: 'rc-bar' }, h('i', { style: { width: `${f.pct}%`, background: f.pct < 90 ? 'var(--warn)' : 'var(--ok)' } })), h('span', { class: 'num', style: { width: '52px' } }, `${f.pct}%`)))));
}

// ------------------------------------------------------------------ schedules
async function schedulesForReport(body, d) {
  const list = (await api('GET', '/api/rc/schedules')).filter(s => s.report_id === d.id);
  body.append(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'small muted' }, 'Emails this report on a schedule, with the files attached.'), h('span', { class: 'spacer' }),
    RC.meta.caps.schedule ? h('button', { class: 'primary sm', onclick: () => scheduleModal({ report_id: d.id }, d) }, '+ Schedule') : null));
  body.append(scheduleTable(list, false));
}
async function schedulesCard() {
  const list = await api('GET', '/api/rc/schedules');
  return h('div', null, h('p', { class: 'small muted', style: { marginTop: 0 } }, `Times are ${RC.meta.timezone}. A schedule sends as the person who created it, so it only ever includes data they can see. Until email delivery is switched to Live, sends are logged to the Outbox only.`),
    scheduleTable(list, true));
}
function scheduleTable(list, showReport) {
  if (!list.length) return h('div', { class: 'empty' }, 'No schedules yet. Open a report and choose Schedules.');
  const status = s => h('span', { class: 'badge ' + ({ sent: 'ok', dry_run: 'blue', held: 'warn', skipped: '', failed: 'bad' }[s.last_status] || '') , title: s.last_error || '' },
    { sent: 'Sent', dry_run: 'Logged (dry run)', held: 'Held: data missing', skipped: 'Skipped (no rows)', failed: 'Failed' }[s.last_status] || 'Not run yet');
  return h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, [...(showReport ? ['Report'] : []), 'When', 'To', 'Files', 'Next', 'Last', ''].map(x => h('th', null, x)))),
    h('tbody', null, list.map(s => h('tr', { style: s.enabled ? {} : { opacity: 0.6 } },
      showReport ? h('td', null, h('a', { href: `#/reporting/${s.report_id}` }, s.report_name), s.customer ? h('div', { class: 'small muted' }, s.customer) : null) : null,
      h('td', { class: 'small' }, s.describe, s.enabled ? '' : h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'paused')),
      h('td', { class: 'small' }, s.recipients, s.cc ? h('div', { class: 'faint' }, `cc ${s.cc}`) : null),
      h('td', { class: 'small' }, s.formats.map(f => FMT_LABELS[f]).join(', ')),
      h('td', { class: 'small' }, s.enabled && s.next_run_at ? tzTime(s.next_run_at) : '—'),
      h('td', { class: 'small' }, status(s), s.last_run_at ? h('div', { class: 'faint' }, fdatetime(s.last_run_at)) : null),
      h('td', { class: 'right' }, RC.meta.caps.schedule ? h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'sm', onclick: async () => { const r = await tryApi(() => api('POST', `/api/rc/schedules/${s.id}/send-now`)); toast(r.status === 'failed' ? `Failed: ${r.error}` : r.status === 'held' ? 'Held back: the owner was sent the rows to fix' : r.status === 'dry_run' ? 'Logged to the Outbox (dry run)' : 'Sent', r.status === 'failed' ? 'err' : ''); route(); } }, 'Send now'),
        h('button', { class: 'sm', onclick: () => scheduleModal(s, RC.meta.reports.find(r => r.id === s.report_id)) }, 'Edit'),
        h('button', { class: 'sm danger', 'aria-label': 'Delete schedule', onclick: async () => { if (await confirmBox('Delete this schedule?', 'Delete')) { await tryApi(() => api('DELETE', `/api/rc/schedules/${s.id}`), 'Schedule deleted'); route(); } } }, icon('x', 14))) : null))))));
}

function scheduleModal(s, report) {
  const v = { cadence: { kind: 'daily', time: '08:00', weekdays_only: true }, recipients: '', cc: '', subject: '', message: '', formats: [report?.default_format || 'xlsx'], skip_empty: false, enabled: true, customer: '', ...s };
  v.cadence = { ...v.cadence };
  const type = report?.type_id ? RC.meta.reports.find(r => r.id === report.type_id) : null;
  const custField = type ? type.spec.customer_field : report?.spec?.customer_field;
  const next = h('div', { class: 'small muted' });
  const refresh = debounce(async () => {
    try { const p = await api('POST', '/api/rc/cron/preview', { cadence: v.cadence }); next.replaceChildren(h('b', null, p.describe || p.cron), ` (${p.timezone}). Next: `, p.next.map(tzTime).join(' · ') || 'never'); }
    catch (e) { next.replaceChildren(h('span', { style: { color: 'var(--bad)' } }, e.message)); }
  }, 250);
  const cad = h('div', { class: 'col' });
  const drawCad = () => {
    const c = v.cadence;
    const time = h('label', { class: 'field' }, 'Time', h('input', { type: 'time', value: c.time || '08:00', oninput: e => { c.time = e.target.value; refresh(); } }));
    const parts = [];
    if (c.kind === 'daily') parts.push(time, h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!c.weekdays_only, onchange: e => { c.weekdays_only = e.target.checked; refresh(); } }), 'Weekdays only'));
    if (c.kind === 'weekly') { c.days = c.days || [1]; parts.push(time, h('div', { class: 'row wrap' }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: c.days.includes(i), onchange: e => { c.days = e.target.checked ? [...c.days, i] : c.days.filter(x => x !== i); refresh(); } }), n)))); }
    if (c.kind === 'monthly' || c.kind === 'quarterly') parts.push(time, h('label', { class: 'field' }, 'Day of the month', h('select', { onchange: e => { c.day = e.target.value === 'L' ? 'L' : Number(e.target.value); refresh(); } },
      [...Array(31)].map((_, i) => h('option', { value: i + 1, selected: Number(c.day || 1) === i + 1 }, i + 1)), h('option', { value: 'L', selected: c.day === 'L' }, 'Last day'))));
    if (c.kind === 'hourly') parts.push(h('label', { class: 'field' }, 'Every', h('select', { onchange: e => { c.every = Number(e.target.value); refresh(); } }, [1, 2, 3, 4, 6, 8, 12].map(n => h('option', { value: n, selected: Number(c.every || 1) === n }, `${n} hour${n > 1 ? 's' : ''}`)))));
    if (c.kind === 'cron') parts.push(h('label', { class: 'field' }, 'Cron expression (minute hour day month weekday)', h('input', { value: c.cron || '0 8 * * 1-5', oninput: e => { c.cron = e.target.value; refresh(); } })));
    cad.replaceChildren(h('label', { class: 'field' }, 'How often', h('select', { onchange: e => { v.cadence = { kind: e.target.value, time: c.time || '08:00', cron: c.cron }; drawCad(); } },
      [['hourly', 'Every few hours'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['cron', 'Custom (cron)']].map(([k, l]) => h('option', { value: k, selected: c.kind === k }, l)))),
    h('div', { class: 'form-grid' }, parts), next);
    refresh();
  };
  drawCad();
  const internal = new Set(RC.meta.internal_emails);
  const extNote = h('div', { class: 'small' });
  const checkExt = () => { const ext = `${v.recipients},${v.cc}`.split(/[,;\s]+/).filter(e => e && !internal.has(e.toLowerCase())); extNote.replaceChildren(ext.length ? h('span', { style: { color: 'var(--warn)' } }, `Outside the company: ${ext.join(', ')}`) : ''); };
  checkExt();
  const body = h('div', { class: 'col', style: { gap: '12px' } },
    cad,
    custField && !report?.customer ? h('label', { class: 'field' }, 'Customer (blank = all customers)', customerInput(type ? type.spec : report.spec, v.customer, x => { v.customer = x; }, false)) : null,
    h('label', { class: 'field' }, 'To', h('input', { value: v.recipients, placeholder: 'name@company.com, team@company.com', oninput: e => { v.recipients = e.target.value; checkExt(); } })),
    h('label', { class: 'field' }, 'Cc', h('input', { value: v.cc || '', oninput: e => { v.cc = e.target.value; checkExt(); } })), extNote,
    h('label', { class: 'field' }, 'Subject (optional; {{date}} and {{customer}} are filled in)', h('input', { value: v.subject || '', placeholder: report?.name, oninput: e => { v.subject = e.target.value; } })),
    h('label', { class: 'field' }, 'Message (optional)', h('textarea', { rows: 3, value: v.message || '', oninput: e => { v.message = e.target.value; } })),
    h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, 'Attach'), Object.entries(FMT_LABELS).map(([k, l]) => h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: v.formats.includes(k), onchange: e => { v.formats = e.target.checked ? [...v.formats, k] : v.formats.filter(x => x !== k); } }), l))),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!v.skip_empty, onchange: e => { v.skip_empty = e.target.checked; } }), "Don't send when the report has no rows"),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: v.enabled !== false, onchange: e => { v.enabled = e.target.checked; } }), 'Active'),
    report && report.audit_mode === 'block' ? h('div', { class: 'callout info' }, 'This report holds back when critical data is missing. Instead of sending, it emails you the rows to fix.') : null);
  modal(s.id ? 'Edit schedule' : `Schedule "${report?.name || 'report'}"`, body, { wide: true, actions: [
    { label: 'Cancel', onClick: c => c() },
    { label: s.id ? 'Save' : 'Create schedule', primary: true, onClick: async c => {
      const payload = { report_id: v.report_id, cadence: v.cadence, recipients: v.recipients, cc: v.cc, subject: v.subject, message: v.message, formats: v.formats, skip_empty: v.skip_empty, enabled: v.enabled, customer: v.customer };
      await tryApi(() => (s.id ? api('PUT', `/api/rc/schedules/${s.id}`, payload) : api('POST', '/api/rc/schedules', payload)), s.id ? 'Schedule saved' : 'Schedule created');
      c(); route(); } }] });
}

// ------------------------------------------------------------------ shared links
async function linksForReport(body, d) {
  const list = (await api('GET', '/api/rc/shares')).filter(s => s.report_id === d.id);
  body.append(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'small muted' }, 'Anyone with the link can view and download until it expires or you turn it off. No sign-in needed.'), h('span', { class: 'spacer' }),
    h('button', { class: 'primary sm', onclick: () => shareModal(d) }, '+ Create link')));
  body.append(shareTable(list, false));
}
async function sharesCard() { return shareTable(await api('GET', '/api/rc/shares'), true); }
function shareTable(list, showReport) {
  if (!list.length) return h('div', { class: 'empty' }, 'No shared links.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, [...(showReport ? ['Report'] : []), 'Label', 'Data', 'Expires', 'Views', 'Created', ''].map(x => h('th', null, x)))),
    h('tbody', null, list.map(s => h('tr', { style: s.active ? {} : { opacity: 0.55 } },
      showReport ? h('td', null, h('a', { href: `#/reporting/${s.report_id}` }, s.report_name)) : null,
      h('td', null, s.label || '—', s.customer ? h('div', { class: 'small muted' }, s.customer) : null),
      h('td', { class: 'small' }, s.mode === 'live' ? 'Live (re-runs on each visit)' : 'Snapshot', h('div', { class: 'faint' }, s.formats.map(f => FMT_LABELS[f]).join(', '))),
      h('td', { class: 'small' }, s.revoked_at ? h('span', { class: 'badge' }, 'turned off') : s.active ? fdate(s.expires_at.slice(0, 10)) : h('span', { class: 'badge' }, 'expired')),
      h('td', { class: 'small num' }, s.views, s.last_viewed_at ? h('div', { class: 'faint' }, fdatetime(s.last_viewed_at)) : null),
      h('td', { class: 'small' }, s.created_by_name || '', h('div', { class: 'faint' }, fdatetime(s.created_at))),
      h('td', { class: 'right' }, s.active ? h('button', { class: 'sm danger', onclick: async () => { if (await confirmBox('Turn this link off? Anyone who has it loses access straight away.', 'Turn off')) { await tryApi(() => api('DELETE', `/api/rc/shares/${s.id}`), 'Link turned off'); route(); } } }, 'Turn off') : null))))));
}
function shareModal(d) {
  const type = d.type_id ? RC.meta.reports.find(r => r.id === d.type_id) : null;
  const spec = type ? type.spec : d.spec;
  const v = { label: d.name, customer: d.customer || RC.customerPick || '', mode: 'snapshot', expires_days: 30, formats: ['xlsx', 'csv', 'pdf'] };
  const body = h('div', { class: 'col', style: { gap: '12px' } },
    h('label', { class: 'field' }, 'Title shown on the page', h('input', { value: v.label, oninput: e => { v.label = e.target.value; } })),
    spec.customer_field && !d.customer ? h('label', { class: 'field' }, 'Customer (blank = all customers)', customerInput(spec, v.customer, x => { v.customer = x; }, false)) : null,
    h('label', { class: 'field' }, 'Data', h('select', { onchange: e => { v.mode = e.target.value; } }, h('option', { value: 'snapshot' }, 'Snapshot: frozen as of now'), h('option', { value: 'live' }, 'Live: up to date on every visit'))),
    h('label', { class: 'field' }, 'Expires after', h('select', { onchange: e => { v.expires_days = Number(e.target.value); } }, [1, 7, 14, 30, 60, 90, 180, 365].map(n => h('option', { value: n, selected: n === 30 }, `${n} day${n > 1 ? 's' : ''}`)))),
    h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, 'Downloads'), Object.entries(FMT_LABELS).map(([k, l]) => h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: v.formats.includes(k), onchange: e => { v.formats = e.target.checked ? [...v.formats, k] : v.formats.filter(x => x !== k); } }), l))));
  modal('Share outside the company', body, { actions: [
    { label: 'Cancel', onClick: c => c() },
    { label: 'Create link', primary: true, onClick: async c => {
      const out = await tryApi(() => api('POST', '/api/rc/shares', { report_id: d.id, ...v }));
      c();
      const input = h('input', { value: out.url, readonly: true, style: { width: '100%' }, onfocus: e => e.target.select() });
      modal('Link ready', h('div', { class: 'col' }, h('p', { style: { margin: 0 } }, `Copy it now: for security it is only shown once. It expires ${fdate(out.expires_at.slice(0, 10))}.`), input,
        out.audit && !out.audit.passed ? h('div', { class: 'callout warn' }, `Data audit: ${out.audit.summary}`) : null),
        { actions: [{ label: 'Copy', primary: true, onClick: async c2 => { try { await navigator.clipboard.writeText(out.url); toast('Copied'); } catch { input.select(); } c2(); route(); } }], onClose: () => route() });
    } }] });
}

// ------------------------------------------------------------------ activity & data settings
async function activityCard() {
  const runs = await api('GET', '/api/rc/runs');
  if (!runs.length) return h('div', { class: 'empty' }, 'Nothing has run yet.');
  const what = { export: 'Exported', export_customers: 'Exported per customer', audit: 'Audited', schedule: 'Scheduled send', manual: 'Sent now', share: 'Shared', share_download: 'Downloaded from shared link' };
  return h('div', { class: 'table-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['When', 'Report', 'What', 'Who', 'Rows', 'Result'].map(x => h('th', null, x)))),
    h('tbody', null, runs.map(r => h('tr', null, h('td', { class: 'small' }, fdatetime(r.created_at)), h('td', null, r.report_id ? h('a', { href: `#/reporting/${r.report_id}` }, r.report_name || '(deleted)') : 'Unsaved report', r.customer ? h('div', { class: 'small muted' }, r.customer) : null),
      h('td', { class: 'small' }, what[r.trigger] || r.trigger, r.format ? ` · ${r.format}` : ''), h('td', { class: 'small' }, r.user_name || (r.trigger.startsWith('share') ? 'Outside viewer' : 'Scheduler')),
      h('td', { class: 'num small' }, r.rows ?? '—'),
      h('td', { class: 'small' }, h('span', { class: 'badge ' + ({ ok: 'ok', sent: 'ok', passed: 'ok', dry_run: 'blue', issues: 'warn', held: 'warn', partial: 'warn', failed: 'bad' }[r.status] || '') }, r.status), r.error ? h('div', { class: 'faint' }, r.error) : r.audit && !r.audit.passed ? h('div', { class: 'faint' }, r.audit.summary) : null))))));
}

async function dataSettingsCard() {
  const cfg = await api('GET', '/api/rc/settings');
  const pol = { tables: cfg.policy.tables || cfg.tables.filter(t => t.enabled).map(t => t.key), hidden: [...cfg.policy.hidden], unhidden: [...cfg.policy.unhidden], role_tables: { ...cfg.policy.role_tables } };
  const save = async () => { await tryApi(() => api('PUT', '/api/rc/settings', pol), 'Data settings saved'); route(); };
  const wrap = h('div', { class: 'col', style: { gap: '14px' } });
  wrap.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Database'), h('span', { class: 'spacer' }),
    h('button', { class: 'sm', onclick: async e => { e.target.disabled = true; e.target.textContent = 'Reading the database…'; try { const r = await tryApi(() => api('POST', '/api/rc/schema/refresh')); if (r) toast(`Found ${r.tables} tables${r.no_access ? `; ${r.no_access} more can't be read` : ''}`); } finally { route(); } } }, icon('refresh', 14), 'Re-read tables & fields'),
    h('button', { class: 'primary sm', onclick: save }, 'Save')),
    h('p', { class: 'small muted', style: { margin: 0 } }, `Connected through ${RC.meta.connection.via === 'settings' ? 'the connection saved under Settings' : 'REPORTING_DB_URL'}${cfg.db_user ? ` as the database user ${cfg.db_user}` : ''}. `,
      `Tables and fields were last read ${cfg.refreshed_at ? fdatetime(cfg.refreshed_at) : 'never'}, and are re-read every 6 hours. Report data itself is always read live when a report runs. `,
      'Every report runs as a read-only query with a time limit.'),
    cfg.error ? h('div', { class: 'callout warn', style: { marginTop: '10px' } }, `Couldn't read the database: ${cfg.error}`) : '',
    cfg.no_access.length ? h('div', { class: 'callout warn', style: { marginTop: '10px' } },
      h('div', null, h('b', null, `${cfg.no_access.length} table${cfg.no_access.length === 1 ? '' : 's'} can't be read by ${cfg.db_user || 'this database user'}: `), cfg.no_access.slice(0, 12).join(', '), cfg.no_access.length > 12 ? ` and ${cfg.no_access.length - 12} more` : '', '.'),
      h('div', { style: { marginTop: '6px' } }, 'To allow them, run this in the Supabase SQL editor, then click Re-read:'),
      h('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0', userSelect: 'all' } },
        [...new Set(cfg.no_access.map(k => k.split('.')[0]))].map(sc => `GRANT USAGE ON SCHEMA ${sc} TO ${cfg.db_user || 'reporting_ro'};\nGRANT SELECT ON ALL TABLES IN SCHEMA ${sc} TO ${cfg.db_user || 'reporting_ro'};`).join('\n'))) : ''));
  const tablesBox = h('div', { class: 'card' }, h('h2', null, 'Tables reports can use'), h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Untick a table to hide it from the Reporting Center. Open a table to hide individual fields; fields that look like SSNs, birth dates, passwords or bank details are hidden until you allow them.'));
  for (const t of cfg.tables) {
    const on = pol.tables.includes(t.key);
    const fields = h('div', { class: 'form-grid', style: { margin: '6px 0 10px 24px' } }, t.fields.map(f => h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: !f.hidden, onchange: e => {
        pol.hidden = pol.hidden.filter(x => x !== f.id); pol.unhidden = pol.unhidden.filter(x => x !== f.id);
        (e.target.checked ? pol.unhidden : pol.hidden).push(f.id);
      } }), `${f.label} `, h('span', { class: 'faint' }, KIND_LABEL[f.kind] || f.kind))));
    tablesBox.append(h('details', null, h('summary', null, h('label', { class: 'check', onclick: e => e.stopPropagation() },
      h('input', { type: 'checkbox', checked: on, onchange: e => { pol.tables = e.target.checked ? [...pol.tables, t.key] : pol.tables.filter(x => x !== t.key); } }),
      h('b', null, t.key), h('span', { class: 'small muted' }, ` ${t.view ? 'view · ' : ''}${rowsEst(t.est_rows)} · ${t.fields.length} fields · ${t.fields.filter(f => f.hidden).length} hidden`))), fields));
  }
  if (!cfg.tables.length) tablesBox.append(h('div', { class: 'empty' }, cfg.no_access.length ? 'No tables can be read yet. See the note above.' : 'No tables found. Check the connection, then re-read.'));
  else if (!pol.tables.length) tablesBox.append(h('div', { class: 'callout', style: { marginBottom: '8px' } }, 'None of these tables are ticked yet. Tick the ones reports should use and click Save.'));
  const roles = h('div', { class: 'card' }, h('h2', null, 'Table access by role'), h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Admins see every enabled table. A role set to "All enabled tables" sees everything ticked above. What each role can do is set under Users & roles.'));
  for (const r of cfg.roles) {
    const limited = Array.isArray(pol.role_tables[r.id]);
    const box = h('div', { class: 'row wrap', style: { margin: '4px 0 10px 24px' } });
    const draw = () => { box.replaceChildren(...(Array.isArray(pol.role_tables[r.id]) ? pol.tables.map(k => h('label', { class: 'check small' },
      h('input', { type: 'checkbox', checked: pol.role_tables[r.id].includes(k), onchange: e => { pol.role_tables[r.id] = e.target.checked ? [...pol.role_tables[r.id], k] : pol.role_tables[r.id].filter(x => x !== k); } }), k)) : [])); };
    roles.append(h('div', { class: 'row' }, h('b', { style: { minWidth: '140px' } }, r.name), h('select', { onchange: e => { if (e.target.value === 'all') delete pol.role_tables[r.id]; else pol.role_tables[r.id] = []; draw(); } },
      h('option', { value: 'all', selected: !limited }, 'All enabled tables'), h('option', { value: 'some', selected: limited }, 'Only these tables'))), box);
    draw();
  }
  wrap.append(tablesBox, roles);
  return wrap;
}

window.ADMIN_VIEWS = Object.assign(window.ADMIN_VIEWS || {}, { reporting: viewReporting });
