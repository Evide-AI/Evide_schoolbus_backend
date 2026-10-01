import express from 'express';
import crypto from 'node:crypto';
import { supabase } from '../../db/supabaseClient.js';

/**
 * Super admin actions that need the Supabase service key: creating and
 * resetting school logins. Every route checks the caller's Supabase session
 * and that the account is listed in super_admins. Reading and the rest of the
 * admin panel go straight to Supabase under the super admin's own login.
 */

const router = express.Router();
const ROLES = ['principal', 'transport_incharge', 'staff'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireSuperAdmin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid session' });

    const { data: admin } = await supabase
      .from('super_admins').select('auth_user_id').eq('auth_user_id', user.id).maybeSingle();
    if (!admin) return res.status(403).json({ error: 'Not allowed' });

    req.admin = { id: user.id, email: user.email };
    next();
  } catch (err) {
    console.error('[admin] auth check failed:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
}
router.use(requireSuperAdmin);

// 12 characters, no look-alikes (0/O, 1/l/I).
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 12 }, () => chars[crypto.randomInt(chars.length)]).join('');
}

async function audit(req, action, targetType, targetId, details) {
  const { error } = await supabase.from('admin_audit').insert({
    admin_user_id: req.admin.id,
    admin_email: req.admin.email,
    action,
    target_type: targetType,
    target_id: String(targetId),
    details: details || null,
  });
  if (error) console.error('[admin] audit failed:', error.message);
}

// List a school's dashboard logins, with their sign-in emails.
router.post('/schools/:schoolId/logins/list', async (req, res) => {
  const { data: rows, error } = await supabase
    .from('management_users')
    .select('id, auth_user_id, full_name, role, created_at')
    .eq('school_id', req.params.schoolId)
    .order('created_at');
  if (error) return res.status(500).json({ error: error.message });

  const logins = [];
  for (const r of rows || []) {
    const { data } = await supabase.auth.admin.getUserById(r.auth_user_id);
    logins.push({
      id: r.id,
      full_name: r.full_name,
      role: r.role,
      email: data?.user?.email || null,
      last_sign_in_at: data?.user?.last_sign_in_at || null,
    });
  }
  res.json({ ok: true, logins });
});

// Create a dashboard login (email + password) for a school.
router.post('/schools/:schoolId/logins', async (req, res) => {
  const { schoolId } = req.params;
  const email = String(req.body?.email || '').trim().toLowerCase();
  const fullName = String(req.body?.full_name || '').trim();
  const role = req.body?.role;
  const password = String(req.body?.password || '').length >= 8 ? String(req.body.password) : tempPassword();

  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!fullName) return res.status(400).json({ error: 'Enter the person\'s name' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a role' });

  const { data: school } = await supabase.from('schools').select('id, name').eq('id', schoolId).maybeSingle();
  if (!school) return res.status(404).json({ error: 'School not found' });

  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    const exists = /already|registered|exists/i.test(error.message);
    return res.status(exists ? 409 : 400).json({ error: exists ? 'That email already has an account' : error.message });
  }

  const { data: row, error: insErr } = await supabase
    .from('management_users')
    .insert({ school_id: schoolId, auth_user_id: created.user.id, full_name: fullName, role })
    .select('id')
    .single();
  if (insErr) {
    await supabase.auth.admin.deleteUser(created.user.id); // don't leave a login with no access rows
    return res.status(500).json({ error: insErr.message });
  }

  await audit(req, 'login.create', 'school', schoolId, { email, role, school: school.name });
  res.json({ ok: true, id: row.id, email, password });
});

// Set a new temporary password for a school login.
router.post('/logins/:id/reset-password', async (req, res) => {
  const { data: row } = await supabase
    .from('management_users').select('id, auth_user_id, school_id').eq('id', req.params.id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'Login not found' });

  const password = tempPassword();
  const { error } = await supabase.auth.admin.updateUserById(row.auth_user_id, { password });
  if (error) return res.status(500).json({ error: error.message });

  const { data } = await supabase.auth.admin.getUserById(row.auth_user_id);
  await audit(req, 'login.reset', 'school', row.school_id, { email: data?.user?.email });
  res.json({ ok: true, email: data?.user?.email || null, password });
});

// Remove a school login: no more access to that school's dashboard.
router.post('/logins/:id/remove', async (req, res) => {
  const { data: row } = await supabase
    .from('management_users').select('id, auth_user_id, school_id, full_name').eq('id', req.params.id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'Login not found' });

  const { error } = await supabase.from('management_users').delete().eq('id', row.id);
  if (error) return res.status(500).json({ error: error.message });

  // Delete the sign-in itself too, unless it is a super admin's account.
  const { data: isAdmin } = await supabase
    .from('super_admins').select('auth_user_id').eq('auth_user_id', row.auth_user_id).maybeSingle();
  if (!isAdmin) await supabase.auth.admin.deleteUser(row.auth_user_id);

  await audit(req, 'login.remove', 'school', row.school_id, { name: row.full_name });
  res.json({ ok: true });
});

export default router;
