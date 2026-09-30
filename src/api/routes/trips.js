import express from 'express';
import { setTripState, getTripState } from '../../workers/tripStateWorker.js';
import { supabase } from '../../db/supabaseClient.js';

const router = express.Router();

// Manual override — always wins immediately over the auto-detection.
// Called by the Driver/Conductor app when someone taps "Start Trip" / "End Trip".
// Only the driver/conductor assigned to this bus (or management of its school)
// may start or end its trip. The caller's Supabase access token is checked.
async function requireBusStaff(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'sign in required' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'invalid session' });

    const { busId } = req.params;
    const { data: driver } = await supabase
      .from('drivers').select('id, role').eq('auth_user_id', user.id).eq('bus_id', busId).eq('is_active', true).maybeSingle();
    if (driver) { req.staff = { role: driver.role || 'driver', id: driver.id }; return next(); }

    const { data: bus } = await supabase.from('buses').select('school_id').eq('id', busId).maybeSingle();
    const { data: mgr } = bus
      ? await supabase.from('management_users').select('id').eq('auth_user_id', user.id).eq('school_id', bus.school_id).maybeSingle()
      : { data: null };
    if (mgr) { req.staff = { role: 'management', id: mgr.id }; return next(); }

    return res.status(403).json({ error: 'not allowed for this bus' });
  } catch (err) {
    console.error('[API] auth check failed:', err.message);
    return res.status(500).json({ error: 'internal error' });
  }
}

router.post('/:busId/toggle', requireBusStaff, async (req, res) => {
  const { busId } = req.params;
  const { action, triggeredBy } = req.body; // action: 'start' | 'end', triggeredBy: 'driver' | 'conductor'

  if (!['start', 'end'].includes(action)) {
    return res.status(400).json({ error: "action must be 'start' or 'end'" });
  }

  try {
    await setTripState(busId, action === 'start' ? 'IN_PROGRESS' : 'COMPLETED', triggeredBy || req.staff?.role || 'unknown');
    res.json({ ok: true });
  } catch (err) {
    console.error('[API] trip toggle failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/:busId', async (req, res) => {
  const state = await getTripState(req.params.busId);
  res.json(state);
});

export default router;
