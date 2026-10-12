import { supabase } from '../db/supabaseClient.js';
import { getQueue, JOBS } from '../queue/queue.js';
import { serviceDate } from '../utils/schoolHours.js';

/**
 * "Bus checked empty": the last link in the chain of custody.
 *
 * After every school trip (pickup or drop) the driver or conductor walks to
 * the back of the bus and taps "Bus checked empty" in the driver app. If
 * nobody does within EMPTY_CHECK_MINUTES of the trip ending, a child may
 * still be on the parked bus, so:
 *   - a row goes into bus_safety_alerts (school dashboard, live)
 *   - a push goes to that bus's driver and conductor phones
 *
 * Parents are never told: this is an internal safety check, and a false
 * alarm to a parent would cause panic.
 *
 * Only trips that ended in the last LOOKBACK_HOURS are considered, so the
 * first run after deploying doesn't alert on old trips.
 */

const EMPTY_CHECK_MINUTES = Number(process.env.EMPTY_CHECK_MINUTES || 10);
const LOOKBACK_HOURS = 3;
const SWEEP_EVERY_MS = 60 * 1000;

let missingColumnsWarned = false;

/** Marks the bus's current (or most recent, today) trip as checked empty. */
export async function recordEmptyCheck(busId, checkedBy) {
  const now = new Date();
  const today = serviceDate(now);
  const { data: trips, error } = await supabase
    .from('trip_history')
    .select('id, route_type, started_at, ended_at, empty_checked_at')
    .eq('bus_id', busId)
    .eq('service_date', today)
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const trip = trips?.[0];
  if (!trip) return { ok: false, reason: 'no_trip_today' };

  if (!trip.empty_checked_at) {
    const { error: upErr } = await supabase
      .from('trip_history')
      .update({ empty_checked_at: now.toISOString(), empty_checked_by: checkedBy })
      .eq('id', trip.id);
    if (upErr) throw new Error(upErr.message);
  }

  // A late check still clears the open alert on the dashboard.
  await supabase
    .from('bus_safety_alerts')
    .update({ resolved_at: now.toISOString(), resolved_by: checkedBy })
    .eq('trip_id', trip.id)
    .is('resolved_at', null);

  console.log(`[empty-check] bus ${busId} trip ${trip.id} checked empty by ${checkedBy}`);
  return {
    ok: true,
    tripId: trip.id,
    checkedAt: trip.empty_checked_at || now.toISOString(),
  };
}

/** Status for the driver app: should the "Bus checked empty" button show? */
export async function emptyCheckStatus(busId) {
  const today = serviceDate();
  const { data: trips } = await supabase
    .from('trip_history')
    .select('id, route_type, started_at, ended_at, empty_checked_at, empty_checked_by, empty_alert_at')
    .eq('bus_id', busId)
    .eq('service_date', today)
    .order('started_at', { ascending: false })
    .limit(1);
  const trip = trips?.[0];
  if (!trip) return { trip: null, needsCheck: false };
  return {
    trip,
    needsCheck: trip.route_type !== 'other' && !trip.empty_checked_at,
  };
}

async function busHasStudents(busId) {
  const { count } = await supabase
    .from('students')
    .select('id', { count: 'exact', head: true })
    .eq('bus_id', busId);
  return (count || 0) > 0;
}

export async function sweepMissedEmptyChecks() {
  const now = Date.now();
  const dueBefore = new Date(now - EMPTY_CHECK_MINUTES * 60 * 1000).toISOString();
  const notOlderThan = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: due, error } = await supabase
    .from('trip_history')
    .select('id, bus_id, school_id, route_type, ended_at, ended_by')
    .in('route_type', ['pickup', 'drop'])
    .is('empty_checked_at', null)
    .is('empty_alert_at', null)
    .not('ended_at', 'is', null)
    .lte('ended_at', dueBefore)
    .gte('ended_at', notOlderThan);
  if (error) {
    if (!missingColumnsWarned) {
      console.error('[empty-check] sweep failed (run migration_012_chain_of_custody.sql?):', error.message);
      missingColumnsWarned = true;
    }
    return;
  }

  for (const trip of due || []) {
    // A superseded row is a duplicate of a trip that is still running.
    if (trip.ended_by === 'superseded') continue;
    if (!(await busHasStudents(trip.bus_id))) continue;

    // Claim the alert so two sweeps (or a restart) can't send it twice.
    const { data: claimed } = await supabase
      .from('trip_history')
      .update({ empty_alert_at: new Date().toISOString() })
      .eq('id', trip.id)
      .is('empty_alert_at', null)
      .is('empty_checked_at', null)
      .select('id');
    if (!claimed?.length) continue;

    const { data: bus } = await supabase.from('buses').select('bus_number').eq('id', trip.bus_id).maybeSingle();
    const busNo = bus?.bus_number || 'A bus';
    const mins = Math.round((now - new Date(trip.ended_at).getTime()) / 60000);
    const title = `${busNo}: not checked empty`;
    const body = `${busNo} finished its ${trip.route_type === 'pickup' ? 'morning' : 'evening'} trip ${mins} min ago `
      + 'and nobody has confirmed the bus is empty. Please check that no child is still on board.';

    const { error: insErr } = await supabase.from('bus_safety_alerts').insert({
      school_id: trip.school_id,
      bus_id: trip.bus_id,
      trip_id: trip.id,
      kind: 'EMPTY_CHECK_MISSED',
      title,
      body,
    });
    if (insErr) console.error('[empty-check] alert insert failed:', insErr.message);

    try {
      const queue = await getQueue();
      await queue.send(JOBS.DISPATCH_NOTIFICATION, {
        type: 'EMPTY_CHECK_MISSED',
        audience: 'staff', // the bus's driver and conductor only, never parents
        busId: trip.bus_id,
        title,
        body,
      });
    } catch (err) {
      console.error('[empty-check] push queue failed:', err.message);
    }
    console.log(`[empty-check] ALERT bus ${trip.bus_id} trip ${trip.id}: not checked ${mins} min after trip end`);
  }
}

export function startEmptyCheckSweeper() {
  setInterval(() => sweepMissedEmptyChecks().catch((e) => console.error('[empty-check]', e.message)), SWEEP_EVERY_MS);
  console.log(`[empty-check] alerting if a bus is not checked empty within ${EMPTY_CHECK_MINUTES} min of a school trip ending.`);
}
