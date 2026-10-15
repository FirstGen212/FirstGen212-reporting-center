// Roles and capabilities. A role grants capabilities; a user can have per-person overrides on top.
const { get, J } = require('./db');

const ADMIN_CAPS = {
  view_reporting: 'Run and export reports',
  build_reports: 'Create and edit reports and report types',
  schedule_reports: 'Schedule reports to be emailed',
  share_reports: 'Share reports outside the company (expiring links, outside recipients)',
  manage_reporting_data: 'Choose which tables and fields reports can use',
  manage_users: 'Manage users, roles and app settings',
  view_audit: 'View the audit log and outbox',
};

function effectivePerms(user) {
  if (!user) return { is_admin: false, admin: {} };
  const role = user.role_id ? get('SELECT * FROM roles WHERE id = ?', user.role_id) : null;
  const rp = J(role?.perms, {}), up = J(user.overrides, {});
  const isAdmin = !!rp.is_admin;
  const admin = { ...(rp.admin || {}), ...(up.admin || {}) };
  if (isAdmin) for (const k of Object.keys(ADMIN_CAPS)) admin[k] = true;
  return { is_admin: isAdmin, role_name: role?.name || null, admin };
}
const can = (perms, cap) => !!perms && (perms.is_admin || !!perms.admin[cap]);

module.exports = { ADMIN_CAPS, effectivePerms, can };
