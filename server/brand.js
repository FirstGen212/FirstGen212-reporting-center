// Who reports are from: the company name and logo shown on PDFs, shared pages and emails.
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./db');

const DEFAULT_LOGO = path.join(__dirname, 'assets', 'logo.png');
function logoFor() {
  const data = getSetting('company', {}).logo || null;
  if (data === 'none') return null;
  if (data && /^data:image\/png;base64,/.test(data)) return Buffer.from(data.split(',')[1], 'base64');
  try { return fs.readFileSync(DEFAULT_LOGO); } catch { return null; }
}
function brandFor() {
  const c = getSetting('company', {});
  return { name: c.name || 'First Gen', has_logo: !!logoFor() };
}
module.exports = { brandFor, logoFor };
