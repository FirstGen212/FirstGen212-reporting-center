const test = require('node:test');
const assert = require('node:assert');
process.env.DB_PATH = require('path').join(require('os').tmpdir(), `rc-test-${process.pid}.db`);
const Q = require('../server/reportQuery');

const table = { schema: 'public', name: 'census_snapshot_history', columns: [
  { name: 'airtable_id', type: 'text', kind: 'text' },
  { name: 'captured_at', type: 'timestamp with time zone', kind: 'date' },
  { name: 'fields', type: 'jsonb', kind: 'json', json_fields: [
    { path: 'company.0.label', kind: 'text' }, { path: 'fgpAmount', kind: 'number' }, { path: 'ssn', kind: 'text' }] },
] };
const base = { table: 'public.census_snapshot_history', columns: [{ field: 'fields.company.0.label' }, { field: 'fields.fgpAmount', agg: 'sum' }] };

test('values are bound as parameters, never written into the SQL', () => {
  const q = Q.compile({ ...base, filters: [{ field: 'fields.company.0.label', op: 'eq', value: "x'; DROP TABLE users; --" }] }, { table });
  assert.ok(!q.sql.includes('DROP TABLE'));
  assert.deepStrictEqual(q.params, ["x'; DROP TABLE users; --"]);
});
test('aggregates group by the other columns', () => {
  const q = Q.compile(base, { table });
  assert.match(q.sql, /GROUP BY 1/);
  assert.match(q.sql, /sum\(/);
});
test('unknown fields and unsafe JSON paths are refused', () => {
  assert.throws(() => Q.compile({ ...base, columns: [{ field: 'nope' }] }, { table }), /not a field/);
  assert.throws(() => Q.compile({ ...base, columns: [{ field: "fields.a'b" }] }, { table }), /not a field/);
});
test('sensitive-looking fields are hidden until an admin allows them', () => {
  assert.throws(() => Q.compile({ ...base, columns: [{ field: 'fields.ssn' }] }, { table, policy: {} }), /restricted/);
  assert.doesNotThrow(() => Q.compile({ ...base, columns: [{ field: 'fields.ssn' }] }, { table, policy: { unhidden: ['fields.ssn'] } }));
});
test('newest row per record as of a date', () => {
  const q = Q.compile({ ...base, latest: { key: 'airtable_id', order: 'captured_at', as_of: '2026-09-30' } }, { table });
  assert.match(q.sql, /DISTINCT ON \(t0\."airtable_id"\)/);
  assert.deepStrictEqual(q.params, ['2026-09-30']);
});

const directory = { schema: 'public', name: 'census_company_directory', key: 'public.census_company_directory', columns: [
  { name: 'id', type: 'integer', kind: 'number' }, { name: 'airtable_id', type: 'text', kind: 'text' }, { name: 'csm', type: 'text', kind: 'text' }] };
const lookup = key => ({ 'public.census_snapshot_history': table, 'public.census_company_directory': directory })[key] || (() => { throw new Error('no table ' + key); })();
const joined = { ...base, joins: [{ id: 'j1', table: 'public.census_company_directory', on: { left: 'fields.company.0.id', right: 'airtable_id' }, keep_unmatched: true }],
  columns: [{ field: 'fields.company.0.label' }, { field: 'j1:csm' }], filters: [{ field: 'j1:csm', op: 'eq', value: 'Ann' }] };
test('fields from a linked table', () => {
  const q = Q.compile(joined, { lookup });
  assert.match(q.sql, /LEFT JOIN "public"\."census_company_directory" j1 ON \(t\."fields" #>> '\{company,0,id\}'\) = j1\."airtable_id"/);
  assert.match(q.sql, /SELECT \(t\."fields" #>> '\{company,0,label\}'\) AS "c0", j1\."csm" AS "c1"/);
  assert.match(q.sql, /lower\(j1\."csm"\) = lower\(\$1\)/);
  assert.strictEqual(q.columns[1].label, 'Csm');
});
test('linked tables: only matching rows, and errors for unknown links', () => {
  const q = Q.compile({ ...joined, joins: [{ ...joined.joins[0], keep_unmatched: false }] }, { lookup });
  assert.match(q.sql, / JOIN "public"\."census_company_directory" j1/);
  assert.doesNotMatch(q.sql, /LEFT JOIN/);
  assert.throws(() => Q.compile({ ...joined, columns: [{ field: 'j2:csm' }] }, { lookup }), /isn't linked/);
  assert.throws(() => Q.compile({ ...joined, joins: [{ ...joined.joins[0], on: { left: 'j1:csm', right: 'csm' } }] }, { lookup }), /listed before/);
  assert.throws(() => Q.compile({ ...joined, columns: [{ field: 'j1:ssn' }] }, { lookup }), /not a field/);
});
test('locked rules always apply, even when filters match "any"', () => {
  const q = Q.compile({ ...base, match: 'any', filters: [{ field: 'fields.firstName', op: 'eq', value: 'a' }, { field: 'fields.firstName', op: 'eq', value: 'b' }],
    locked: [{ field: 'fields.firstName', op: 'in', value: 'Active, On leave' }] }, { table });
  assert.match(q.sql, /WHERE \(lower\(.*\) = lower\(\$1\) OR lower\(.*\) = lower\(\$2\)\) AND lower\(.*\) = ANY\(\$3::text\[\]\)/);
  assert.deepStrictEqual(q.params.slice(0, 3), ['a', 'b', ['active', 'on leave']]);
});
