import { supabase } from '../db/supabaseClient.js';
import { setTripState } from './tripStateWorker.js';

/**
 * Ends trips whose bus has gone silent. A trip left "running" after the GPS
 * device died, or after the driver forgot to tap End, would otherwise show
 * "Running" (and a route on the dashboard map) for hours.
 *
 * "Silent" = no GPS ping and no trip start for SILENT_TRIP_MINUTES.
 * Runs every few minutes, and once shortly after startup (which also cleans
 * up a trip left over from the previous evening).
 */

const SILENT_MINUTES = Number(process.env.SILENT_TRIP_MINUTES || 60);
const SWEEP_EVERY_MS = 5 * 60 * 1000;

export async function closeSilentTrips() {
  const { data: running, error } = await supabase
    .from('trip_state')
    .select('bus_id, started_at')
    .eq('status', 'IN_PROGRESS');
  if (error) {
    console.error('[sweeper] could not load running trips:', error.message);
    return;
  }
  if (!running?.length) return;

  const { data: positions } = await supabase
    .from('bus_live_position')
    .select('bus_id, recorded_at')
    .in('bus_id', running.map((r) => r.bus_id));
  const lastPing = new Map((positions || []).map((p) => [p.bus_id, new Date(p.recorded_at).getTime()]));

  const cutoff = Date.now() - SILENT_MINUTES * 60 * 1000;
  for (const trip of running) {
    const started = trip.started_at ? new Date(trip.started_at).getTime() : 0;
    const lastSeen = Math.max(lastPing.get(trip.bus_id) || 0, started);
    if (lastSeen < cutoff) {
      console.log(`[sweeper] ending silent trip for bus ${trip.bus_id} (no signal for ${SILENT_MINUTES}+ min)`);
      try {
        await setTripState(trip.bus_id, 'COMPLETED', 'auto-silent');
      } catch (err) {
        console.error('[sweeper] failed to end trip:', err.message);
      }
    }
  }
}

export function startTripSweeper() {
  setTimeout(() => closeSilentTrips().catch((e) => console.error('[sweeper]', e.message)), 30 * 1000);
  setInterval(() => closeSilentTrips().catch((e) => console.error('[sweeper]', e.message)), SWEEP_EVERY_MS);
  console.log(`[sweeper] closing trips silent for ${SILENT_MINUTES}+ min, checked every 5 min.`);
}
