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
