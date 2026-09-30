import { supabase } from '../db/supabaseClient.js';
import { getQueue, JOBS } from '../queue/queue.js';
import { getDistanceToNextStopInMeters } from '../utils/geoUtils.js';
import { currentWindowForBus, getSchoolSettings, serviceDate } from '../utils/schoolHours.js';

// Tunable thresholds — expect to adjust these after your first real field
// test, per the roadmap's open items. These are reasonable starting points,
// not measured values.
//
// Hysteresis pattern borrowed from the existing Evide backend's stop-arrival
// logic: the "you've left" radius is deliberately larger than the "you've
// arrived" radius, so GPS jitter right at the boundary doesn't flicker the
// trip state back and forth.
const MOVEMENT_SPEED_THRESHOLD_KMH = 5;
const STATIONARY_SPEED_THRESHOLD_KMH = 1;
const SUSTAINED_SECONDS_TO_CONFIRM = 60;
const STATIONARY_SECONDS_TO_END_TRIP = 180;
const ARRIVAL_RADIUS_METERS = 100;   // must be within this to count as "at school/garage"
const DEPARTURE_RADIUS_METERS = 150; // must exceed this to count as "left" — always > ARRIVAL_RADIUS_METERS

// Simple in-memory tracking of "how long has this bus been moving/stationary".
// Fine for a single-process V1 deployment; if you ever run multiple backend
// instances, move this state into a table (e.g. a few columns on trip_state).
const movementTimers = new Map(); // bus_id -> { state: 'moving'|'stationary', since: Date }

async function getTripState(busId) {
  const { data } = await supabase.from('trip_state').select('*').eq('bus_id', busId).maybeSingle();
  return data || { bus_id: busId, status: 'NOT_STARTED' };
}

/**
 * Keeps trip_history in step with trip_state: one open row while a trip runs,
 * closed when it ends. Never throws — history is a convenience and must not
 * break starting or ending a trip.
 */
async function recordTripHistory(busId, status, triggeredBy) {
  try {
    const now = new Date();
    const { data: open } = await supabase
      .from('trip_history')
      .select('id, started_at')
      .eq('bus_id', busId)
      .is('ended_at', null);

    if (status === 'IN_PROGRESS') {
      const today = serviceDate(now);
      const current = (open || []).find((r) => serviceDate(new Date(r.started_at)) === today);
      // Already have an open trip today (e.g. Start tapped twice): keep it.
      const stale = (open || []).filter((r) => r !== current);
      if (stale.length) {
        await supabase.from('trip_history')
          .update({ ended_at: now.toISOString(), ended_by: 'superseded' })
          .in('id', stale.map((r) => r.id));
      }
      if (current) return;

      const settings = await getSchoolSettings(busId);
      if (!settings.school_id) return;
      const { error } = await supabase.from('trip_history').insert({
        bus_id: busId,
        school_id: settings.school_id,
        service_date: today,
        route_type: (await currentWindowForBus(busId, now)) || 'other',
        started_at: now.toISOString(),
        started_by: triggeredBy,
      });
      if (error) console.error('[trip] history insert failed:', error.message);
    } else if (open?.length) {
      const { error } = await supabase.from('trip_history')
        .update({ ended_at: now.toISOString(), ended_by: triggeredBy })
        .in('id', open.map((r) => r.id));
      if (error) console.error('[trip] history close failed:', error.message);
    }
  } catch (err) {
    console.error('[trip] history error:', err.message);
  }
}

async function setTripState(busId, status, triggeredBy) {
  const now = new Date().toISOString();
  const update = { bus_id: busId, status, triggered_by: triggeredBy, updated_at: now };
  if (status === 'IN_PROGRESS') update.started_at = now;
  if (status === 'COMPLETED') update.ended_at = now;

  await supabase.from('trip_state').upsert(update, { onConflict: 'bus_id' });
  await recordTripHistory(busId, status, triggeredBy);

  // Mirror the trip into buses.status so the parent app (which can read
  // buses but not trip_state) can show Running / Not running.
  // A bus marked 'maintenance' is left alone.
  const busStatus = status === 'IN_PROGRESS' ? 'running' : 'not_running';
  const { error: busErr } = await supabase
    .from('buses')
    .update({ status: busStatus })
    .eq('id', busId)
    .neq('status', 'maintenance');
  if (busErr) console.error('[trip] failed to sync buses.status:', busErr.message);

  // Only "bus started" goes to the whole bus, and only during school hours.
  // "Reached school / reached stop" are now sent per student by
  // tripEventsWorker.js, so the old bus-wide BUS_REACHED is no longer sent.
  if (status === 'IN_PROGRESS' && (await currentWindowForBus(busId))) {
    const queue = await getQueue();
    await queue.send(JOBS.DISPATCH_NOTIFICATION, {
      type: 'BUS_STARTED',
      busId,
      triggeredBy,
    });
  }
}

async function distanceToBase(busId, lat, lng) {
  const { data: bus } = await supabase.from('buses').select('school_id').eq('id', busId).maybeSingle();
  if (!bus) return null;
  const { data: school } = await supabase
    .from('schools')
    .select('latitude, longitude')
    .eq('id', bus.school_id)
    .maybeSingle();
  if (!school || school.latitude == null) return null;

  return getDistanceToNextStopInMeters({ lat, lon: lng }, { lat: school.latitude, lon: school.longitude });
}

/**
 * Call this for every GPS ping. Manual driver/conductor taps should call
 * setTripState(...) directly instead and can ignore this function entirely —
 * this is only the automatic backstop for when nobody taps the button.
 */
export async function evaluateTripState({ busId, latitude, longitude, speedKmh }) {
  const trip = await getTripState(busId);

  // A trip left running from an earlier day (nobody tapped End, bus never came
  // back to school) would keep showing "Running". Close it quietly.
  if (trip.status === 'IN_PROGRESS' && trip.started_at) {
    const day = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (day(new Date(trip.started_at)) !== day(new Date())) {
      await setTripState(busId, 'COMPLETED', 'auto-expire');
      return;
    }
  }

  const distance = await distanceToBase(busId, latitude, longitude);
  if (distance === null) return; // school has no coordinates set yet — can't evaluate

  const now = new Date();
  const timer = movementTimers.get(busId);
  const isAtBase = distance <= ARRIVAL_RADIUS_METERS;
  const hasLeftBase = distance > DEPARTURE_RADIUS_METERS;

  if (trip.status !== 'IN_PROGRESS' && hasLeftBase && speedKmh >= MOVEMENT_SPEED_THRESHOLD_KMH) {
    if (!timer || timer.state !== 'moving') {
      movementTimers.set(busId, { state: 'moving', since: now });
    } else if ((now - timer.since) / 1000 >= SUSTAINED_SECONDS_TO_CONFIRM) {
      await setTripState(busId, 'IN_PROGRESS', 'auto');
      movementTimers.delete(busId);
    }
    return;
  }

  if (trip.status === 'IN_PROGRESS' && isAtBase && speedKmh <= STATIONARY_SPEED_THRESHOLD_KMH) {
    if (!timer || timer.state !== 'stationary') {
      movementTimers.set(busId, { state: 'stationary', since: now });
    } else if ((now - timer.since) / 1000 >= STATIONARY_SECONDS_TO_END_TRIP) {
      await setTripState(busId, 'COMPLETED', 'auto');
      movementTimers.delete(busId);
    }
    return;
  }

  // Conditions not met to keep advancing the timer — reset it.
  if (timer) movementTimers.delete(busId);
}

export { setTripState, getTripState };
