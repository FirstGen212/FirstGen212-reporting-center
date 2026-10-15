const test = require('node:test');
const assert = require('node:assert');
const cron = require('../server/reportCron');

const at = iso => Date.parse(iso);
test('weekday mornings in New York, across a weekend', () => {
  const runs = cron.nextRuns('0 8 * * 1-5', 'America/New_York', 3, at('2026-10-16T13:00:00Z')).map(d => d.toISOString());
  assert.deepStrictEqual(runs, ['2026-10-19T12:00:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-21T12:00:00.000Z']);
});
test('last day of the month, through the end of daylight saving time', () => {
  const runs = cron.nextRuns('30 7 L * *', 'America/New_York', 3, at('2026-10-15T00:00:00Z')).map(d => d.toISOString());
  assert.deepStrictEqual(runs, ['2026-10-31T11:30:00.000Z', '2026-11-30T12:30:00.000Z', '2026-12-31T12:30:00.000Z']);
});
test('cadences become cron expressions', () => {
  assert.strictEqual(cron.cadenceToCron({ kind: 'weekly', days: [4, 1], time: '07:15' }), '15 7 * * 1,4');
  assert.strictEqual(cron.cadenceToCron({ kind: 'quarterly', day: 'L', time: '09:00' }), '0 9 L 1,4,7,10 *');
  assert.strictEqual(cron.cadenceToCron({ kind: 'hourly', every: 4 }), '0 */4 * * *');
});
test('bad expressions are explained', () => {
  assert.match(cron.validate('61 * * * *'), /out of range/);
  assert.match(cron.validate('0 8 * *'), /five fields/);
  assert.strictEqual(cron.validate('0 8 * * MON-FRI'), null);
});
