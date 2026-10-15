// The business timezone: schedules run and "today" is computed here.
const { getSetting } = require('./db');
const tz = () => process.env.TIMEZONE || getSetting('timezone', 'America/New_York');
const todayISO = (zone = tz()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
module.exports = { tz, todayISO };
