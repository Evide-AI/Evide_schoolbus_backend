import { supabase } from '../db/supabaseClient.js';

// Remembers every GT06 device that talks to the server (assigned to a bus or
// not), so the super admin panel can show "last connected" and list devices
// that are connecting but not yet assigned to any bus.
// Writes are throttled to one per device per minute.

const THROTTLE_MS = 60 * 1000;
const lastTouch = new Map();

export async function touchDevice(imei, ip) {
  if (!imei) return;
  const now = Date.now();
  if (now - (lastTouch.get(imei) || 0) < THROTTLE_MS) return;
  lastTouch.set(imei, now);

  const { error } = await supabase
    .from('gt06_devices')
    .upsert({ imei, last_seen: new Date(now).toISOString(), last_ip: ip || null }, { onConflict: 'imei' });
  if (error) console.error(`[GT06] could not record device ${imei}:`, error.message);
}
