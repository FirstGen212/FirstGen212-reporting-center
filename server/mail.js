// Email delivery. Every message is written to the outbox. In dry-run mode (the default), or until SMTP is set up,
// messages are logged there and not sent, so schedules can be tried safely.
const nodemailer = require('nodemailer');
const { run, getSetting } = require('./db');

function config() {
  const c = getSetting('email', {});
  return {
    mode: process.env.DELIVERY_MODE || c.delivery_mode || 'dry_run',
    host: process.env.SMTP_HOST || c.smtp_host, port: Number(process.env.SMTP_PORT || c.smtp_port || 587),
    user: process.env.SMTP_USER || c.smtp_user, pass: process.env.SMTP_PASS || c.smtp_pass,
    from: process.env.EMAIL_FROM || c.email_from || 'Reporting Center <reports@example.com>',
  };
}
const publicStatus = () => { const c = config(); return { mode: c.mode, configured: !!c.host, from: c.from, host: c.host || null, port: c.port, user: c.user || null, env: ['DELIVERY_MODE', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'].filter(k => process.env[k]) }; };

function logOutbox(row) {
  return Number(run(`INSERT INTO outbox(channel, kind, to_addr, cc, bcc, subject, body, attachments, status, error, meta) VALUES('email',?,?,?,?,?,?,?,?,?,?)`,
    row.kind, row.to || null, row.cc || null, row.bcc || null, row.subject || null, row.body || null,
    row.attachments ? JSON.stringify(row.attachments) : null, row.status, row.error || null, row.meta ? JSON.stringify(row.meta) : null).lastInsertRowid);
}
let transporter = null, transporterKey = '';
function mailer(c) {
  const key = JSON.stringify([c.host, c.port, c.user, c.pass]);
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: c.user ? { user: c.user, pass: c.pass } : undefined });
    transporterKey = key;
  }
  return transporter;
}
/** Returns the outbox row id; its status is sent, dry_run, skipped or failed. */
async function sendEmail({ to, cc, bcc, subject, html, text, attachments, kind = 'notification', meta, replyTo }) {
  const c = config();
  const list = v => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map(s => s.trim()).filter(Boolean);
  const row = { kind, to: list(to).join(', '), cc: list(cc).join(', '), bcc: list(bcc).join(', '), subject, body: html || text,
    attachments: (attachments || []).map(a => ({ filename: a.filename, size: a.content?.length })), meta };
  if (!row.to) return logOutbox({ ...row, status: 'skipped', error: 'No recipient address' });
  if (c.mode !== 'live' || !c.host) return logOutbox({ ...row, status: 'dry_run' });
  try {
    await mailer(c).sendMail({ from: c.from, to: row.to, cc: row.cc || undefined, bcc: row.bcc || undefined, replyTo, subject, html, text, attachments });
    return logOutbox({ ...row, status: 'sent' });
  } catch (e) { return logOutbox({ ...row, status: 'failed', error: e.message }); }
}

module.exports = { sendEmail, publicStatus, config };
