// Data audit: before a report goes out, check that the fields the export depends on are filled in and valid.
// A report (or its report type) lists its required fields with a rule and a severity:
//   { field: 'fields.employeeId', label: 'Employee ID', rule: 'required' | 'email' | 'phone' | 'date' | 'number'
//     | 'one_of' | 'regex' | 'min_length', arg: '...', severity: 'critical' | 'warning' }
// Critical problems can hold an export back (the report's audit mode is 'block'); warnings are listed only.
const { compile, normalizeRows, resolveField, fieldsOf } = require('./reportQuery');
const { readOnly } = require('./reportSource');

const AUDIT_MAX_ROWS = Number(process.env.REPORT_AUDIT_MAX_ROWS) || 50000;
const ISSUE_LIST_MAX = 2000;
const RULES = {
  required: 'Required',
  email: 'Valid email',
  phone: 'Valid phone number',
  date: 'Valid date',
  number: 'Number',
  one_of: 'One of a list',
  regex: 'Matches a pattern',
  min_length: 'Minimum length',
};

const blank = v => v == null || (typeof v === 'string' && (v.trim() === '' || v === '[]' || v === '{}' || v === 'null'));
function check(rule, v) {
  if (blank(v)) return 'missing';
  const s = String(v).trim();
  switch (rule.rule) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? null : 'invalid';
    case 'phone': return s.replace(/\D/g, '').length >= 10 && s.replace(/\D/g, '').length <= 15 ? null : 'invalid';
    case 'date': return /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(new Date(s.slice(0, 10) + 'T00:00:00Z')) ? null : 'invalid';
    case 'number': return typeof v === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(s) ? null : 'invalid';
    case 'one_of': { const ok = String(rule.arg || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean); return !ok.length || ok.includes(s.toLowerCase()) ? null : 'invalid'; }
    case 'regex': { try { return new RegExp(rule.arg || '.*').test(s) ? null : 'invalid'; } catch { return null; } }
    case 'min_length': return s.length >= (Number(rule.arg) || 0) ? null : 'invalid';
    default: return null;
  }
}

/**
 * Run the audit for a report definition. Returns per-rule counts, a per-customer breakdown, fill rates for every
 * column in the report, and the rows that need fixing (each with the values that identify it).
 */
async function audit(spec, required, { table, policy, customer = null, today } = {}) {
  const rules = (required || []).filter(r => r?.field).map(r => ({ ...r, rule: RULES[r.rule] ? r.rule : 'required', severity: r.severity === 'warning' ? 'warning' : 'critical' }));
  const known = fieldsOf(table);
  const named = Object.fromEntries((spec.columns || []).filter(c => c.field && c.label && !c.agg).map(c => [c.field, c.label]));
  const label = id => (id === '*' ? 'Count' : named[id] || resolveField(table, id, known).label);
  const reportFields = (spec.columns || []).filter(c => c.field && c.field !== '*' && !c.agg).map(c => c.field);
  const idFields = (spec.audit_ids?.length ? spec.audit_ids : reportFields.filter(f => f !== spec.customer_field && !rules.some(r => r.field === f)).slice(0, 2)).filter(Boolean);
  const fields = [...new Set([...(spec.customer_field ? [spec.customer_field] : []), ...idFields, ...rules.map(r => r.field), ...reportFields])];
  if (!fields.length) { const e = new Error('Add columns or required fields to audit'); e.status = 400; throw e; }

  const q = compile(spec, { table, policy, customer, today, limit: AUDIT_MAX_ROWS, forAudit: fields });
  const started = Date.now();
  const res = await readOnly(q.sql, q.params);
  const truncated = res.rows.length > q.cap;
  const rows = normalizeRows(res.rows.slice(0, q.cap), q.columns);
  const at = id => fields.indexOf(id);

  const perRule = rules.map(r => ({ field: r.field, label: r.label || label(r.field), rule: r.rule, rule_label: RULES[r.rule], arg: r.arg || null, severity: r.severity, missing: 0, invalid: 0 }));
  const byCustomer = new Map();
  const issues = [];
  let issueRows = 0, criticalRows = 0;
  for (const row of rows) {
    const problems = [];
    rules.forEach((r, i) => {
      const v = row[at(r.field)];
      const res = check(r, v);
      if (res) { perRule[i][res]++; problems.push({ label: perRule[i].label, rule: perRule[i].rule_label, severity: r.severity, kind: res, value: res === 'invalid' ? v : null }); }
    });
    const cust = spec.customer_field ? (row[at(spec.customer_field)] ?? '(no customer)') : null;
    if (cust != null) {
      const c = byCustomer.get(cust) || { customer: cust, rows: 0, issue_rows: 0, critical_rows: 0 };
      c.rows++; if (problems.length) c.issue_rows++; if (problems.some(p => p.severity === 'critical')) c.critical_rows++;
      byCustomer.set(cust, c);
    }
    if (!problems.length) continue;
    issueRows++;
    if (problems.some(p => p.severity === 'critical')) criticalRows++;
    if (issues.length < ISSUE_LIST_MAX) issues.push({ ids: idFields.map(f => ({ label: label(f), value: row[at(f)] })), customer: cust, problems });
  }
  const fill = reportFields.map(f => {
    const i = at(f); const filled = rows.filter(r => !blank(r[i])).length;
    return { field: f, label: label(f), filled, pct: rows.length ? Math.round((filled / rows.length) * 1000) / 10 : 100 };
  });
  for (const r of perRule) r.ok_pct = rows.length ? Math.round(((rows.length - r.missing - r.invalid) / rows.length) * 1000) / 10 : 100;
  return {
    checked_rows: rows.length, truncated, rows_with_issues: issueRows, critical_rows: criticalRows,
    passed: criticalRows === 0, has_rules: rules.length > 0, rules: perRule, fill,
    customers: [...byCustomer.values()].sort((a, b) => b.critical_rows - a.critical_rows || b.issue_rows - a.issue_rows || String(a.customer).localeCompare(String(b.customer))),
    issues, issues_truncated: issueRows > issues.length, id_labels: idFields.map(label), ms: Date.now() - started,
    at: new Date().toISOString(),
  };
}

/** A one-line summary for emails and run history. */
function summarize(a) {
  if (!a?.has_rules) return 'No required fields are set for this report.';
  if (!a.rows_with_issues) return `All ${a.checked_rows.toLocaleString()} rows have the required data.`;
  return `${a.rows_with_issues.toLocaleString()} of ${a.checked_rows.toLocaleString()} rows are missing or have invalid required data`
    + (a.critical_rows ? ` (${a.critical_rows.toLocaleString()} critical)` : ' (warnings only)') + '.';
}

/** The audit as a table of problems, one row per problem, for CSV/Excel export. */
function issuesTable(a) {
  const columns = [...(a.customers.length ? [{ label: 'Customer' }] : []), ...a.id_labels.map(l => ({ label: l })), { label: 'Field' }, { label: 'Check' }, { label: 'Problem' }, { label: 'Severity' }, { label: 'Current value' }]
    .map(c => ({ ...c, kind: 'text' }));
  const rows = [];
  for (const i of a.issues) for (const p of i.problems) rows.push([...(a.customers.length ? [i.customer] : []), ...i.ids.map(x => x.value), p.label, p.rule, p.kind === 'missing' ? 'Missing' : 'Invalid', p.severity, p.value]);
  return { columns, rows };
}

module.exports = { audit, summarize, issuesTable, RULES, AUDIT_MAX_ROWS };
