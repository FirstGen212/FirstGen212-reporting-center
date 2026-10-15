/* Report builder: search fields across every table, click to add, drag to order, live preview, export.
   Tables link themselves when a field from another table is added; when they can't, the field isn't added and
   the panel says why. Filters, settings, required data, schedules and links sit in tabs under the preview. */
'use strict';

// Editor UI state that survives redraws of one report (search text, open tables, which column is being edited).
const ED = { key: null, q: '', open: new Set(), edit: null, tab: 'preview', err: null, drag: null };

// Which (table, field) a column id points at, so the field list can show what's already in the report.
function rcRef(spec, id) {
  const m = /^(j\d{1,2}):(.+)$/.exec(String(id || ''));
  if (!m) return { table: spec.table, field: String(id || '') };
  const j = (spec.joins || []).find(x => x.id === m[1]);
  return { table: j?.table, field: m[2] };
}
// Linked tables that nothing uses any more are dropped, so removing a field undoes the link it brought in.
function rcPrune(d) {
  const s = d.spec;
  for (;;) {
    const used = new Set();
    const mark = id => { const m = /^(j\d{1,2}):/.exec(String(id || '')); if (m) used.add(m[1]); };
    s.columns.forEach(c => mark(c.field)); s.filters.forEach(f => mark(f.field)); (s.locked || []).forEach(f => mark(f.field)); d.required.forEach(r => mark(r.field)); mark(s.customer_field);
    (s.joins || []).forEach(j => { mark(j.on?.left); });
    const before = s.joins.length;
    s.joins = s.joins.filter(j => used.has(j.id));
    if (s.joins.length === before) break;
  }
  if (!s.columns.length && !s.filters.length && !(s.locked || []).length && !s.joins.length && !d.required.length) { s.latest = null; s.customer_field = null; }
}
function rcMoveCol(s, from, to) {
  if (from === to || from == null || to == null) return;
  const order = s.columns.map((_, i) => i);
  const [c] = s.columns.splice(from, 1); s.columns.splice(to, 0, c);
  const [o] = order.splice(from, 1); order.splice(to, 0, o);
  s.sort = s.sort.map(x => ({ ...x, col: order.indexOf(x.col) })).filter(x => x.col >= 0);
}

async function viewReportEditor(view, arg) {
  if (arg === 'new' || arg === 'new-type') { if (!RC.draft || RC.draft.id || RC.draft._new !== arg) { RC.draft = { ...blankDraft(arg === 'new-type' ? 'type' : 'report'), _new: arg }; RC.result = null; RC.audit = null; } }
  else if (!RC.draft || String(RC.draft.id) !== String(arg)) { RC.draft = await api('GET', `/api/rc/reports/${arg}`); RC.result = null; RC.audit = null; }
  const d = RC.draft;
  d.spec.joins = d.spec.joins || [];
  const key = String(d.id || d._new);
  if (ED.key !== key) Object.assign(ED, { key, q: '', open: new Set(), edit: null, tab: 'preview', err: null });
  if (!(d.can_edit && RC.meta.caps.build) && ['filters', 'settings'].includes(ED.tab)) ED.tab = 'preview';
  const type = d.type_id ? RC.meta.reports.find(r => r.id === d.type_id) : null;
  const spec = type ? type.spec : d.spec;
  const editable = d.can_edit && RC.meta.caps.build;
  const isNew = !d.id;

  // ---- header: name, export buttons, save
  const exportNow = fmt => (isNew
    ? rcDownload('POST', '/api/rc/export', { name: d.name || 'Report', spec, required: type ? type.required : d.required, audit_mode: d.audit_mode, format: fmt, customer: runCustomer(d) })
    : rcDownload('GET', `/api/rc/reports/${d.id}/export?format=${fmt}${d.customer ? '' : RC.customerPick ? '&customer=' + encodeURIComponent(RC.customerPick) : ''}`));
  const title = editable && !type
    ? h('input', { class: 'rc-title', value: d.name, placeholder: d.kind === 'type' ? 'Name this report type' : 'Name this report', 'aria-label': 'Report name', oninput: e => { d.name = e.target.value; } })
    : h('h1', { class: 'rc-title-ro' }, d.name);
  view.append(h('div', { class: 'rc-head' },
    h('div', { class: 'col', style: { gap: '2px', minWidth: 0, flex: '1 1 260px' } },
      h('a', { href: '#/reporting', class: 'small' }, '← All reports'), title,
      h('span', { class: 'small muted' }, type ? `Customer report from the "${type.name}" type` : d.kind === 'type' ? 'Report type: a template for customer reports' : '')),
    h('div', { class: 'row wrap rc-actions' },
      h('span', { class: 'small muted' }, 'Export'),
      h('div', { class: 'rc-btn-group' }, Object.entries(FMT_LABELS).map(([k, l]) => h('button', { disabled: !spec.columns?.length, onclick: () => exportNow(k), title: `Download as ${l}` }, icon('download', 14), l))),
      editable ? h('button', { class: 'primary', onclick: saveReport }, isNew ? 'Save report' : 'Save changes') : null)));
  view.append(connectionNote());

  if (type) {   // a customer report: its shape comes from the type, so only the customer and the results matter here
    view.append(h('div', { class: 'card', style: { marginBottom: '14px' } },
      h('div', { class: 'row wrap' }, h('b', null, 'Customer'), customerInput(type.spec, d.customer, v => { d.customer = v; RC.result = null; route(); }, !editable),
        h('span', { class: 'spacer' }), h('a', { class: 'btn', href: `#/reporting/${type.id}` }, `Edit the "${type.name}" type`))));
    const box = h('div');
    view.append(box);
    drawTabs(box, d, spec, { editable: false, type });
    return;
  }

  const fieldsBox = h('div', { class: 'card rc-fields' });
  const colsBox = h('div', { class: 'card rc-cols' });
  const tabsBox = h('div');
  const redraw = {
    fields: () => fieldsBox.replaceChildren(...fieldsPanel(d, editable, redraw)),
    cols: () => colsBox.replaceChildren(...columnsBar(d, editable, redraw)),
    tabs: () => { tabsBox.replaceChildren(); drawTabs(tabsBox, d, spec, { editable, redraw }); },
    all() { this.fields(); this.cols(); this.tabs(); },
    changed() { RC.result = null; RC.audit = null; this.fields(); this.cols(); this.tabs(); },
  };
  const main = h('div', { class: 'col', style: { gap: '14px', minWidth: 0 } }, colsBox, tabsBox);
  view.append(editable ? h('div', { class: 'rc-builder' }, fieldsBox, main) : main);
  if (!editable) redraw.fields = () => {};
  redraw.all();
}

// ---------------------------------------------------------------- left: every field in every table
function fieldsPanel(d, editable, redraw) {
  const s = d.spec;
  const inReport = new Set(s.columns.map(c => { const r = rcRef(s, c.field); return `${r.table}|${r.field}`; }));
  const used = new Set([s.table, ...s.joins.map(j => j.table)].filter(Boolean));
  const empty = !s.columns.length && !s.filters.length;
  const list = h('div', { class: 'rc-flist' });

  const toggle = async (t, f) => {
    if (!editable) return;
    ED.err = null;
    if (inReport.has(`${t.key}|${f.id}`)) {
      s.columns = s.columns.filter(c => { const r = rcRef(s, c.field); return !(r.table === t.key && r.field === f.id); });
      s.sort = s.sort.filter(x => s.columns[x.col]);
      rcPrune(d);
    } else {
      try { s.columns.push({ field: await rcPlaceField(d, t.key, f.id) }); }
      catch (e) { ED.err = { table: t.key, msg: e.message }; toast(e.message, 'err'); redraw.fields(); return; }
    }
    redraw.changed();
  };
  const item = (t, f) => {
    const on = inReport.has(`${t.key}|${f.id}`);
    return h('button', { type: 'button', class: 'rc-fitem' + (on ? ' on' : ''), disabled: !editable, title: on ? 'Remove from the report' : `Add ${f.label}`, onclick: () => toggle(t, f) },
      h('span', { class: 'rc-tick' }, on ? '✓' : '+'), h('span', { class: 'rc-fname' }, f.label), h('span', { class: 'rc-fkind' }, KIND_LABEL[f.kind] || f.kind));
  };
  const errNote = t => (ED.err?.table === t.key ? h('div', { class: 'callout warn small', style: { margin: '4px 0 6px' } }, ED.err.msg) : null);
  const tables = [...RC.meta.tables].sort((a, b) => (used.has(b.key) - used.has(a.key)) || a.name.localeCompare(b.name));

  const draw = () => {
    const words = ED.q.toLowerCase().split(/\s+/).filter(Boolean);
    list.replaceChildren();
    let shown = 0;
    for (const t of tables) {
      if (words.length) {
        const tName = t.name.toLowerCase();
        const hits = t.fields.filter(f => { const hay = `${f.label} ${f.id} ${tName}`.toLowerCase(); return words.every(w => hay.includes(w)); });
        if (!hits.length || shown > 400) continue;
        shown += hits.length;
        list.append(h('div', { class: 'rc-tgroup' }, h('div', { class: 'rc-thead static' }, tLabel(t), used.has(t.key) ? h('span', { class: 'badge ok' }, 'in report') : null), errNote(t),
          hits.slice(0, 60).map(f => item(t, f)), hits.length > 60 ? h('div', { class: 'small faint', style: { padding: '2px 8px' } }, `${hits.length - 60} more: keep typing to narrow it down`) : null));
      } else {
        const open = ED.open.has(t.key);
        const count = t.fields.filter(f => inReport.has(`${t.key}|${f.id}`)).length;
        list.append(h('div', { class: 'rc-tgroup' },
          h('button', { type: 'button', class: 'rc-thead', 'aria-expanded': String(open), onclick: () => { open ? ED.open.delete(t.key) : ED.open.add(t.key); draw(); } },
            h('span', { class: 'rc-caret' }, open ? '▾' : '▸'), h('span', { class: 'rc-fname' }, tLabel(t)),
            count ? h('span', { class: 'badge ok' }, `${count} added`) : h('span', { class: 'rc-fkind' }, `${t.fields.length}`)),
          errNote(t), open ? t.fields.map(f => item(t, f)) : null));
      }
    }
    if (!list.childElementCount) list.append(h('div', { class: 'empty small' }, words.length ? 'No fields match. Fields that look sensitive (birth dates, SSNs, bank details) stay hidden until an admin allows them under Reports › Data settings › Hidden fields.' : 'No tables are available yet. An admin can enable them under Data settings.'));
  };
  const search = h('input', { type: 'search', class: 'rc-fsearch', placeholder: 'Search fields in every table…', value: ED.q, 'aria-label': 'Search fields',
    oninput: debounce(e => { ED.q = e.target.value; draw(); }, 120) });
  draw();
  return [
    h('div', { class: 'rc-fhead' }, h('h2', null, 'Fields'), h('span', { class: 'small muted' }, empty ? 'Click a field to add it. The first one picks the main table.' : 'Click to add or remove. Fields from other tables link in automatically.')),
    search, list];
}

// ---------------------------------------------------------------- top right: the columns, in order
function columnsBar(d, editable, redraw) {
  const s = d.spec, scope = rcScope(s);
  const out = [h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h2', { style: { margin: 0 } }, 'Columns'),
    h('span', { class: 'small muted' }, s.columns.length ? (editable ? 'Drag to reorder. Click a column to rename, summarise or sort it.' : '') : ''),
    h('span', { class: 'spacer' }),
    editable && s.columns.length ? h('button', { class: 'sm ghost', onclick: () => { s.columns.push({ field: '*', agg: 'count' }); redraw.changed(); } }, '+ Count of rows') : null,
    editable && s.columns.length ? h('button', { class: 'sm ghost', onclick: async () => { if (await confirmBox('Remove every column, filter and linked table?', 'Clear')) { s.columns = []; s.filters = []; s.locked = []; s.sort = []; d.required = []; rcPrune(d); ED.edit = null; redraw.changed(); } } }, 'Clear') : null)];
  if (!s.columns.length) { out.push(h('div', { class: 'rc-drop-empty' }, 'Search for a field on the left and click it to start.')); return out; }

  const strip = h('div', { class: 'rc-chips' });
  s.columns.forEach((c, i) => {
    const f = c.field === '*' ? null : rcField(scope, c.field);
    const name = c.label || (c.field === '*' ? 'Count of rows' : (c.agg ? `${AGG_LABELS[c.agg]} of ` : '') + (f?.short || f?.label || c.field));
    const srt = s.sort.find(x => x.col === i);
    const chip = h('div', { class: 'rc-chip' + (ED.edit === i ? ' sel' : '') + (f || c.field === '*' ? '' : ' bad'), draggable: editable ? 'true' : null, tabindex: '0',
      title: f?.join ? f.label : (f?.label || ''),
      onclick: () => { ED.edit = ED.edit === i ? null : i; redraw.cols(); },
      onkeydown: e => { if (!editable) return; if (e.key === 'ArrowLeft' && i) { rcMoveCol(s, i, i - 1); ED.edit = i - 1; redraw.changed(); } if (e.key === 'ArrowRight' && i < s.columns.length - 1) { rcMoveCol(s, i, i + 1); ED.edit = i + 1; redraw.changed(); } },
      ondragstart: e => { ED.drag = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); chip.classList.add('dragging'); },
      ondragend: () => chip.classList.remove('dragging'),
      ondragover: e => { if (ED.drag == null) return; e.preventDefault(); chip.classList.add('over'); },
      ondragleave: () => chip.classList.remove('over'),
      ondrop: e => { e.preventDefault(); chip.classList.remove('over'); const from = ED.drag; ED.drag = null; if (from == null || from === i) return; rcMoveCol(s, from, i); ED.edit = null; redraw.changed(); } },
      editable ? h('span', { class: 'rc-grip', 'aria-hidden': 'true' }, '⠿') : null,
      h('span', { class: 'rc-chip-name' }, name),
      f?.join ? h('span', { class: 'rc-chip-from' }, f.group) : null,
      srt ? h('span', { class: 'rc-chip-from' }, srt.dir === 'desc' ? '↓' : '↑') : null,
      editable ? h('button', { class: 'rc-chip-x', 'aria-label': `Remove ${name}`, onclick: e => { e.stopPropagation(); s.columns.splice(i, 1); s.sort = s.sort.filter(x => x.col !== i).map(x => ({ ...x, col: x.col > i ? x.col - 1 : x.col })); rcPrune(d); ED.edit = null; redraw.changed(); } }, '×') : null);
    strip.append(chip);
  });
  out.push(strip);

  const i = ED.edit, c = s.columns[i];
  if (c && editable) {
    const f = c.field === '*' ? null : rcField(scope, c.field);
    const aggs = c.field === '*' ? ['count'] : ['', 'count', 'count_distinct', ...(f?.kind === 'number' ? ['sum', 'avg'] : []), ...(['number', 'date', 'text'].includes(f?.kind) ? ['min', 'max'] : [])];
    const srt = s.sort.find(x => x.col === i);
    out.push(h('div', { class: 'rc-coledit' },
      h('label', { class: 'field' }, 'Column name', h('input', { value: c.label || '', placeholder: f?.label || 'Count of rows', oninput: debounce(e => { c.label = e.target.value || undefined; RC.result = null; redraw.cols(); redraw.tabs(); }, 400) })),
      h('label', { class: 'field' }, 'Show', h('select', { disabled: c.field === '*', onchange: e => { c.agg = e.target.value || undefined; redraw.changed(); } }, aggs.map(a => h('option', { value: a, selected: (c.agg || '') === a }, a ? AGG_LABELS[a] : 'Each value')))),
      h('label', { class: 'field' }, 'Sort', h('select', { onchange: e => { s.sort = s.sort.filter(x => x.col !== i); if (e.target.value) s.sort.unshift({ col: i, dir: e.target.value }); s.sort = s.sort.slice(0, 3); redraw.changed(); } },
        h('option', { value: '' }, 'Not sorted'), h('option', { value: 'asc', selected: srt?.dir === 'asc' }, 'A→Z / low→high'), h('option', { value: 'desc', selected: srt?.dir === 'desc' }, 'Z→A / high→low'))),
      h('div', { class: 'row', style: { alignSelf: 'end', gap: '4px' } },
        h('button', { class: 'sm', disabled: !i, onclick: () => { rcMoveCol(s, i, i - 1); ED.edit = i - 1; redraw.changed(); } }, '← Move'),
        h('button', { class: 'sm', disabled: i >= s.columns.length - 1, onclick: () => { rcMoveCol(s, i, i + 1); ED.edit = i + 1; redraw.changed(); } }, 'Move →'),
        h('button', { class: 'sm', onclick: () => { ED.edit = null; redraw.cols(); } }, 'Done')),
      c.agg ? h('div', { class: 'small muted', style: { gridColumn: '1 / -1' } }, 'When a column is summarised, the other columns become the groups (one row per combination).') : null));
  }
  return out;
}

// ---------------------------------------------------------------- bottom right: preview and everything else
function drawTabs(box, d, spec, { editable, type = null, redraw = null }) {
  const s = spec;
  const nFilters = (s.filters || []).length;
  const tabs = [['preview', 'Preview'], ...(type ? [] : [['filters', nFilters ? `Filters (${nFilters})` : 'Filters'], ['settings', 'Settings']]),
    ['audit', 'Required data & audit'], ...(d.id ? [['schedules', 'Schedules'], ...(RC.meta.caps.share ? [['links', 'Shared links']] : [])] : [])];
  if (!tabs.some(t => t[0] === ED.tab)) ED.tab = 'preview';
  const body = h('div');
  const go = k => { ED.tab = k; box.replaceChildren(); drawTabs(box, d, spec, { editable, type, redraw }); };
  box.append(h('div', { class: 'card' }, h('div', { class: 'tabs', style: { marginTop: 0, marginBottom: '12px' } }, tabs.map(([k, l]) => h('button', { class: ED.tab === k ? 'on' : '', onclick: () => go(k) }, l))), body));
  const again = () => { if (redraw) redraw.changed(); else route(); };
  if (ED.tab === 'preview') livePreview(body, d, spec);
  if (ED.tab === 'filters') filtersTab(body, d, editable, again);
  if (ED.tab === 'settings') settingsTab(body, d, editable, again);
  if (ED.tab === 'audit') { if (!type || type.spec.locked?.length) body.append(lockedCard(type || d, editable && !type, again)); if (!type) body.append(auditRulesCard(d, editable)); const a = h('div', { style: { marginTop: '12px' } }); body.append(a); auditPane(a, d, spec); }
  if (ED.tab === 'schedules') schedulesForReport(body, d);
  if (ED.tab === 'links') linksForReport(body, d);
}

let previewSeq = 0;
function livePreview(body, d, spec) {
  if (!spec.columns?.length) { body.append(h('div', { class: 'empty' }, 'Your report will appear here as you add fields.')); return; }
  if (!RC.result) {
    body.append(h('div', { class: 'empty' }, 'Loading a preview…'));
    const seq = ++previewSeq;
    api('POST', '/api/rc/preview', { spec, customer: runCustomer(d), limit: 200 })
      .then(r => r, e => ({ error: e.message }))
      .then(r => { if (seq !== previewSeq || !body.isConnected) return; RC.result = r; body.replaceChildren(); previewPane(body, d, spec); });
    return;
  }
  previewPane(body, d, spec);
}

// One condition row (field, operator, value), shared by filters and locked rules. Text and number fields get a
// "Pick" list of the values actually in the data, so you can tick the ones you want instead of typing them.
function condRow(d, list, i, dis, again) {
  const flt = list[i], f = rcField(rcScope(d.spec), flt.field);
  const ops = RC.meta.ops[f?.kind] || RC.meta.ops.text;
  if (!ops.includes(flt.op)) flt.op = ops[0];
  const ph = f?.kind === 'date' ? (['last_days', 'next_days'].includes(flt.op) ? 'days' : 'YYYY-MM-DD') : ['in', 'not_in'].includes(flt.op) ? 'a, b, c' : 'value';
  const valIn = k => h('input', { value: flt[k] ?? '', disabled: dis, placeholder: ph, onchange: e => { flt[k] = e.target.value; again(); } });
  const pickable = ['text', 'number', 'list'].includes(f?.kind) && ['eq', 'neq', 'in', 'not_in'].includes(flt.op);
  return h('div', { class: 'rc-row rc-cond' },
    h('span', { class: 'rc-filter-field', title: f?.label || flt.field }, f?.label || flt.field),
    h('select', { disabled: dis, onchange: e => { flt.op = e.target.value; again(); } }, ops.map(o => h('option', { value: o, selected: flt.op === o }, OP_LABELS[o] || o))),
    NO_VALUE.includes(flt.op) ? h('span') : h('span', { class: 'row rc-val' }, valIn('value'), flt.op === 'between' ? valIn('value2') : null, pickable && !dis ? valuePicker(d, flt, again) : null),
    dis ? null : h('button', { class: 'ghost sm', 'aria-label': 'Remove', onclick: () => { list.splice(i, 1); rcPrune(d); again(); } }, icon('x', 14)));
}

// A dropdown of a field's distinct values (most common first) with tick boxes. Ticking more than one turns
// "is" into "is any of" and "is not" into "is none of".
function valuePicker(d, flt, again) {
  const s = d.spec, wrap = h('div', { class: 'rc-finder rc-pick' });
  const box = h('div', { class: 'rc-finder-list rc-pick-list hidden' });
  const chosen = () => new Set(String(flt.value ?? '').split(',').map(x => x.trim()).filter(Boolean));
  const q = h('input', { type: 'search', placeholder: 'Search values…', oninput: debounce(() => load(), 300) });
  const items = h('div');
  let seq = 0;
  const load = async () => {
    const my = ++seq;
    items.replaceChildren(h('div', { class: 'small muted', style: { padding: '8px 10px' } }, 'Loading values…'));
    let vals;
    try { vals = await api('POST', '/api/rc/values', { table: s.table, field: flt.field, latest: s.latest, joins: s.joins || [], q: q.value || undefined }); }
    catch (e) { if (my === seq) items.replaceChildren(h('div', { class: 'callout warn small' }, e.message)); return; }
    if (my !== seq) return;
    const have = chosen();
    const extra = [...have].filter(v => !vals.some(x => String(x.value).toLowerCase() === v.toLowerCase())).map(v => ({ value: v, count: null }));
    const all = [...extra, ...vals];
    items.replaceChildren(...all.map(x => {
      const v = String(x.value);
      const cb = h('input', { type: 'checkbox', checked: [...have].some(c => c.toLowerCase() === v.toLowerCase()), onchange: () => {
        const set = chosen();
        const hit = [...set].find(c => c.toLowerCase() === v.toLowerCase());
        if (cb.checked && !hit) set.add(v); if (!cb.checked && hit) set.delete(hit);
        const many = set.size > 1;
        if (many && flt.op === 'eq') flt.op = 'in'; if (many && flt.op === 'neq') flt.op = 'not_in';
        if (!many && flt.op === 'in') flt.op = 'eq'; if (!many && flt.op === 'not_in') flt.op = 'neq';
        flt.value = [...set].join(', ');
        btn.textContent = label(); changed = true;
      } });
      return h('label', { class: 'rc-pick-item' }, cb, h('span', null, v), x.count != null ? h('span', { class: 'faint small' }, x.count.toLocaleString()) : null);
    }));
    if (!all.length) items.append(h('div', { class: 'small muted', style: { padding: '8px 10px' } }, 'No values found.'));
  };
  let changed = false;
  const label = () => { const n = chosen().size; return n ? `${n} picked ▾` : 'Pick ▾'; };
  const close = () => { box.classList.add('hidden'); document.removeEventListener('mousedown', outside); if (changed) { changed = false; again(); } };
  const outside = e => { if (!wrap.contains(e.target)) close(); };
  const btn = h('button', { type: 'button', class: 'sm', title: 'Pick from the values in the data', onclick: () => {
    if (!box.classList.contains('hidden')) return close();
    box.classList.remove('hidden'); document.addEventListener('mousedown', outside); load(); q.focus();
  } }, label());
  box.append(h('div', { style: { padding: '6px' } }, q), items, h('div', { class: 'row', style: { padding: '6px', justifyContent: 'flex-end' } }, h('button', { type: 'button', class: 'sm primary', onclick: close }, 'Done')));
  wrap.append(btn, box);
  return wrap;
}

// Adds a condition on any field (linking its table in if needed). Text fields start as "is any of" so values can be ticked.
function addCondPicker(d, list, again, placeholder) {
  return fieldFinder(d, async (tk, fid) => {
    let id;
    try { id = await rcPlaceField(d, tk, fid); } catch (e) { toast(e.message, 'err'); return; }
    const ops = RC.meta.ops[rcField(rcTable(tk), fid)?.kind] || RC.meta.ops.text;
    list.push({ field: id, op: ops.includes('in') ? 'in' : ops[0], value: '' }); again();
  }, { placeholder });
}

function filtersTab(body, d, editable, again) {
  const s = d.spec, dis = !editable;
  const rows = h('div', { class: 'col' });
  s.filters.forEach((_, i) => rows.append(condRow(d, s.filters, i, dis, again)));
  if (!s.filters.length) rows.append(h('div', { class: 'small muted' }, 'No filters: every row is included.'));
  body.append(...[
    s.filters.length > 1 ? h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'small muted' }, 'Rows must match'),
      h('select', { disabled: dis, class: 'sm', onchange: e => { s.match = e.target.value; again(); } }, h('option', { value: 'all', selected: s.match !== 'any' }, 'all filters'), h('option', { value: 'any', selected: s.match === 'any' }, 'any filter'))) : null,
    rows,
    dis ? null : h('div', { style: { marginTop: '10px' } }, addCondPicker(d, s.filters, again, '+ Add a filter: search fields…')),
    h('p', { class: 'small faint', style: { marginBottom: 0 } }, 'Values can use {{customer}} and {{today}}. Use Pick to choose from the values in the data.'),
    h('label', { class: 'field', style: { marginTop: '12px', maxWidth: '260px' } }, 'Row limit',
      h('input', { type: 'number', min: 1, disabled: dis, value: s.limit || '', placeholder: `all (max ${RC.meta.max_rows.toLocaleString()})`, onchange: e => { s.limit = Number(e.target.value) || null; again(); } }))].filter(x => x != null));
}

// Rules the report is locked to, e.g. "Employee status must be Active". Unlike filters, these always all apply,
// and customer reports made from a report type can't change them.
function lockedCard(d, editable, again) {
  const s = d.spec, dis = !editable;
  s.locked = s.locked || [];
  const rows = h('div', { class: 'col' });
  s.locked.forEach((_, i) => rows.append(condRow(d, s.locked, i, dis, again)));
  if (!s.locked.length) rows.append(h('div', { class: 'small muted' }, dis ? 'This report has no locked rules.' : 'No locked rules yet.'));
  return h('div', { class: 'card', style: { marginBottom: '12px' } }, ...[
    h('h2', null, 'Locked rules'),
    h('p', { class: 'small muted', style: { marginTop: 0 } }, 'Only rows that meet every rule here are ever in this report, its exports, emails and shared links. For example: Employee status must be Active.'),
    rows,
    dis ? null : h('div', { style: { marginTop: '8px' } }, addCondPicker(d, s.locked, again, '+ Lock a field: search fields…'))].filter(x => x != null));
}

function settingsTab(body, d, editable, again) {
  const s = d.spec, dis = !editable, scope = rcScope(s), base = rcTable(s.table);
  body.append(h('div', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Description', h('input', { value: d.description || '', disabled: dis, placeholder: 'What this report is for', oninput: e => { d.description = e.target.value; } })),
    h('label', { class: 'field' }, 'Visible to', h('select', { disabled: dis, onchange: e => { d.shared = e.target.value === '1'; } }, h('option', { value: '1', selected: d.shared }, 'Everyone with Reporting Center access'), h('option', { value: '0', selected: !d.shared }, 'Only me (and admins)'))),
    h('label', { class: 'field' }, 'Default file for emails and links', h('select', { disabled: dis, onchange: e => { d.default_format = e.target.value; } }, Object.entries(FMT_LABELS).map(([k, l]) => h('option', { value: k, selected: d.default_format === k }, l)))),
    h('label', { class: 'field' }, d.kind === 'type' ? 'Customer field (required for a type)' : 'Customer field (to run it per customer)',
      fieldSelect(scope, s.customer_field || '', v => { s.customer_field = v || null; again(); }, { disabled: dis, filter: f => f.kind === 'text' || f.kind === 'number', placeholder: 'None' }))));
  if (s.customer_field) body.append(h('div', { class: 'row', style: { marginTop: '10px' } }, h('span', { class: 'small muted' }, 'Preview and export for customer'),
    customerInput(s, RC.customerPick || '', v => { RC.customerPick = v; again(); }, false), h('span', { class: 'small faint' }, 'blank = all')));

  // where the data comes from
  body.append(h('h3', null, 'Tables'));
  if (!base || !s.columns.length) body.append(h('p', { class: 'small muted' }, 'The main table is the table of the first field you add.'));
  else {
    body.append(h('p', { class: 'small', style: { marginTop: 0 } }, 'Main table: ', h('b', null, tLabel(base)), h('span', { class: 'muted' }, ` · ${rowsEst(base.est_rows)}`)));
    const latestOn = !!s.latest;
    body.append(h('label', { class: 'check small' }, h('input', { type: 'checkbox', disabled: dis, checked: latestOn, onchange: e => {
      s.latest = e.target.checked ? { key: base.fields.find(f => /(^|_)id$/i.test(f.id) && !f.json && f.id !== 'id')?.id || base.fields[0]?.id || '', order: base.fields.find(f => f.kind === 'date' && !f.json)?.id || '', as_of: '' } : null; again(); } }),
      `Only the newest ${tLabel(base)} row for each record (for history / snapshot tables)`));
    if (latestOn) body.append(h('div', { class: 'rc-row', style: { margin: '6px 0 0 24px' } },
      h('span', { class: 'small muted' }, 'One row per'), fieldSelect(base, s.latest.key, v => { s.latest.key = v; again(); }, { disabled: dis }),
      h('span', { class: 'small muted' }, 'newest by'), fieldSelect(base, s.latest.order, v => { s.latest.order = v; again(); }, { disabled: dis, filter: f => f.kind === 'date' || f.kind === 'number' }),
      h('input', { value: s.latest.as_of || '', disabled: dis, placeholder: 'as of YYYY-MM-DD (blank = now)', onchange: e => { s.latest.as_of = e.target.value; again(); } })));
    s.joins.forEach((j, i) => {
      const t = rcTable(j.table);
      const before = rcScope({ ...s, joins: s.joins.slice(0, i) });
      body.append(h('div', { class: 'rc-join', style: { marginTop: '10px' } },
        h('div', null, h('b', null, tLabel(t) || j.table), h('span', { class: 'small muted' }, ' is linked where')),
        h('div', { class: 'rc-row' },
          fieldSelect(before, j.on.left, v => { j.on.left = v; again(); }, { disabled: dis, filter: f => f.kind === 'text' || f.kind === 'number' }),
          h('span', { class: 'small muted' }, 'matches'),
          fieldSelect(t, j.on.right, v => { j.on.right = v; again(); }, { disabled: dis, filter: f => f.kind === 'text' || f.kind === 'number' })),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', disabled: dis, checked: j.keep_unmatched !== false, onchange: e => { j.keep_unmatched = e.target.checked; again(); } }), `Keep rows that have no matching ${tLabel(t)} row`),
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', disabled: dis, checked: !!j.latest, onchange: e => {
          j.latest = e.target.checked ? { key: t?.fields.find(f => /(^|_)id$/i.test(f.id) && !f.json && f.id !== 'id')?.id || '', order: t?.fields.find(f => f.kind === 'date' && !f.json)?.id || '', as_of: '' } : null; again(); } }),
          `Use only the newest ${tLabel(t)} row for each record`),
        j.latest ? h('div', { class: 'rc-row' }, h('span', { class: 'small muted' }, 'One row per'), fieldSelect(t, j.latest.key, v => { j.latest.key = v; again(); }, { disabled: dis }),
          h('span', { class: 'small muted' }, 'newest by'), fieldSelect(t, j.latest.order, v => { j.latest.order = v; again(); }, { disabled: dis, filter: f => f.kind === 'date' || f.kind === 'number' })) : null));
    });
  }
  if (editable && d.id) body.append(h('div', { style: { marginTop: '18px', paddingTop: '12px', borderTop: '1px solid var(--line)' } }, h('button', { class: 'danger', onclick: deleteReport }, 'Delete this report')));
}
