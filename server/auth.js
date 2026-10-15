// Password hashing (scrypt), signed session cookies, and login throttling.
const crypto = require('crypto');
const { get, run, getSetting, setSetting } = require('./db');

const MIN_PASSWORD = 10;
const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !pw) return false;
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  try {
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(hashHex, 'hex');
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  } catch { return false; } // a malformed stored hash is a failed login, not a 500
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}
function setPassword(userId, pw) {
  run("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?", hashPassword(pw), userId);
}

// ---- sessions: cookie = "<userId>.<issuedAt>.<hmac(userId|issuedAt|passwordChangedAt)>"
// Changing a password signs out old sessions, and a token stops working SESSION_DAYS after it was issued
// even if someone copied it out of a browser (the cookie's own Max-Age only binds well-behaved browsers).
const SECRET = process.env.SESSION_SECRET || getSetting('session_secret', null) || (() => { const s = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', s); return s; })();
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
const mac = (u, iat) => crypto.createHmac('sha256', SECRET).update(`${u.id}|${iat}|${u.password_changed_at || ''}`).digest('hex');
const sessionToken = u => { const iat = Date.now(); return `${u.id}.${iat}.${mac(u, iat)}`; };
function userFromToken(token) {
  if (!token) return null;
  const [id, iat, sig] = String(token).split('.');
  if (!sig || !/^\d+$/.test(iat || '')) return null;
  const age = Date.now() - Number(iat);
  if (age < -60e3 || age > SESSION_DAYS * 86400e3) return null;
  const u = get('SELECT * FROM users WHERE id = ? AND active = 1', Number(id));
  if (!u) return null;
  const expected = mac(u, iat);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? u : null;
}
function sessionCookie(req, value, maxAge = SESSION_DAYS * 86400) {
  const secure = req.secure ? '; Secure' : '';
  return `rc_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---- throttle: 8 failed attempts per email+IP per 15 minutes
const failures = new Map();
function throttled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(key); return false; }
  return f.count >= 8;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
const clearFailures = key => failures.delete(key);

// ---- bootstrap: ADMIN_EMAIL + ADMIN_PASSWORD env vars guarantee an admin can always sign in (also serves as recovery)
function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) return;
  const err = validatePassword(pw);
  if (err) { console.warn(`[auth] ADMIN_PASSWORD ignored: ${err}`); return; }
  let u = get('SELECT * FROM users WHERE lower(email) = ?', email);
  if (!u) {
    const role = get("SELECT id FROM roles WHERE json_extract(perms, '$.is_admin') = 1 ORDER BY id LIMIT 1");
    const id = Number(run('INSERT INTO users(name, email, role_id, title) VALUES(?,?,?,?)', email.split('@')[0], email, role?.id || null, 'Admin').lastInsertRowid);
    u = get('SELECT * FROM users WHERE id = ?', id);
  }
  if (!verifyPassword(pw, u.password_hash)) { setPassword(u.id, pw); console.log(`[auth] Admin password set for ${email}`); }
  if (!u.active) run('UPDATE users SET active = 1 WHERE id = ?', u.id);
}

module.exports = { DEMO_MODE, MIN_PASSWORD, hashPassword, verifyPassword, validatePassword, setPassword, sessionToken, userFromToken,
  sessionCookie, throttled, recordFailure, clearFailures, bootstrapAdmin };
