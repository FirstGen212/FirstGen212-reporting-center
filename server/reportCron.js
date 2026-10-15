// Cron expressions for scheduled reports, evaluated in the business timezone.
// Five fields: minute hour day-of-month month day-of-week. Supports * , - / and names (JAN, MON), plus L in the
// day-of-month field for "last day of the month". As in standard cron, when both day fields are restricted a day
// matching either one runs.
const NAMES = {
  month: { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 },
  dow: { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 },
};
const RANGES = [['minute', 0, 59], ['hour', 0, 23], ['dom', 1, 31], ['month', 1, 12], ['dow', 0, 7]];

function parseField(src, [name, lo, hi]) {
  const out = new Set();
  let last = false;
  for (const part of String(src).toUpperCase().split(',')) {
    if (name === 'dom' && part === 'L') { last = true; continue; }
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new Error(`"${part}" is not valid in the ${name} field`);
    const step = m[2] ? Number(m[2]) : 1;
    if (!step) throw new Error(`Step must be at least 1 in the ${name} field`);
    let a, b;
    const val = s => {
      const n = NAMES[name]?.[s] ?? (/^\d+$/.test(s) ? Number(s) : NaN);
      if (Number.isNaN(n) || n < lo || n > hi) throw new Error(`"${s}" is out of range for the ${name} field (${lo}-${hi})`);
      return n;
    };
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { const [x, y] = m[1].split('-'); a = val(x); b = val(y); if (a > b) throw new Error(`Range ${m[1]} runs backwards`); }
    else { a = val(m[1]); b = m[2] ? hi : a; }
    for (let i = a; i <= b; i += step) out.add(name === 'dow' && i === 7 ? 0 : i);
  }
  return { set: out, last, any: String(src) === '*' };
}

function parse(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs five fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, RANGES[i]));
  return { minute, hour, dom, month, dow };
}
function validate(expr) { try { parse(expr); return null; } catch (e) { return e.message; } }

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function dayMatches(c, y, m, d) {
  if (!c.month.set.has(m)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = c.dom.set.has(d) || (c.dom.last && d === daysIn(y, m));
  const dowOk = c.dow.set.has(dow);
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowOk;
  if (c.dow.any) return domOk;
  return domOk || dowOk;
}

// Wall-clock parts of an instant in a timezone, and the instant for a wall-clock time there.
const fmtCache = new Map();
function partsAt(t, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); fmtCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
const offsetAt = (t, tz) => { const p = partsAt(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(t / 60000) * 60000; };
function instantOf(y, m, d, h, mi, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const guess = wall - offsetAt(wall, tz);
  return wall - offsetAt(guess, tz);
}

/** The next run strictly after `after` (ms), as a Date; null if nothing matches within ~5 years. */
function nextRun(expr, tz = 'America/New_York', after = Date.now()) {
  const c = parse(expr);
  const now = partsAt(after, tz);
  const hours = [...c.hour.set].sort((a, b) => a - b), mins = [...c.minute.set].sort((a, b) => a - b);
  let y = now.y, m = now.m, d = now.d;
  for (let i = 0; i < 366 * 5; i++) {
    if (dayMatches(c, y, m, d)) {
      const today = i === 0;
      for (const h of hours) {
        if (today && h < now.h) continue;
        for (const mi of mins) {
          if (today && h === now.h && mi <= now.mi) continue;
          const t = instantOf(y, m, d, h, mi, tz);
          if (t > after) return new Date(t);
        }
      }
    }
    d++;
    if (d > daysIn(y, m)) { d = 1; m++; if (m > 12) { m = 1; y++; } }
  }
  return null;
}
function nextRuns(expr, tz, n = 5, after = Date.now()) {
  const out = [];
  let t = after;
  for (let i = 0; i < n; i++) { const r = nextRun(expr, tz, t); if (!r) break; out.push(r); t = r.getTime(); }
  return out;
}

// The cadence picker in the UI is stored alongside the cron it produces, so the screen can show it the same way.
//   { kind: 'daily', time: '08:00', weekdays_only: true }
//   { kind: 'weekly', time: '08:00', days: [1, 4] }
//   { kind: 'monthly', time: '08:00', day: 1 | 'L' }
//   { kind: 'quarterly', time: '08:00', day: 1 | 'L' }
//   { kind: 'hourly', every: 4, minute: 0 }
//   { kind: 'cron', cron: '0 8 * * 1-5' }
function cadenceToCron(c = {}) {
  const [hh, mm] = String(c.time || '08:00').split(':').map(n => Math.max(0, Number(n) || 0));
  const day = c.day === 'L' ? 'L' : Math.min(31, Math.max(1, Number(c.day) || 1));
  switch (c.kind) {
    case 'daily': return `${mm} ${hh} * * ${c.weekdays_only ? '1-5' : '*'}`;
    case 'weekly': { const days = (c.days || []).map(Number).filter(n => n >= 0 && n <= 6); return `${mm} ${hh} * * ${days.length ? [...new Set(days)].sort().join(',') : '1'}`; }
    case 'monthly': return `${mm} ${hh} ${day} * *`;
    case 'quarterly': return `${mm} ${hh} ${day} 1,4,7,10 *`;
    case 'hourly': { const every = Math.min(23, Math.max(1, Number(c.every) || 1)); return `${Math.min(59, Number(c.minute) || 0)} ${every === 1 ? '*' : '*/' + every} * * *`; }
    case 'cron': return String(c.cron || '').trim();
    default: throw new Error('Pick how often the report should go out');
  }
}
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const time12 = t => { const [h, m] = String(t || '08:00').split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const ord = n => (n === 'L' ? 'last day' : n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'));
function describeCadence(c = {}) {
  switch (c.kind) {
    case 'daily': return `${c.weekdays_only ? 'Weekdays' : 'Every day'} at ${time12(c.time)}`;
    case 'weekly': return `Every ${(c.days || [1]).map(d => DAY[d]).join(', ')} at ${time12(c.time)}`;
    case 'monthly': return `Monthly on the ${ord(c.day === 'L' ? 'L' : Number(c.day) || 1)} at ${time12(c.time)}`;
    case 'quarterly': return `Quarterly (Jan/Apr/Jul/Oct) on the ${ord(c.day === 'L' ? 'L' : Number(c.day) || 1)} at ${time12(c.time)}`;
    case 'hourly': return Number(c.every) > 1 ? `Every ${c.every} hours` : 'Every hour';
    case 'cron': return `Custom: ${c.cron}`;
    default: return '';
  }
}

module.exports = { parse, validate, nextRun, nextRuns, cadenceToCron, describeCadence };
