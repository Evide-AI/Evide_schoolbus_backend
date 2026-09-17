import { supabase } from '../db/supabaseClient.js';
import { getQueue, JOBS } from '../queue/queue.js';
import { getDistanceToNextStopInMeters } from '../utils/geoUtils.js';

// Fire an alarm when the bus comes within this distance of a student's stop.
const ALARM_RADIUS_METERS = 500;

// Don't re-fire the same student's alarm more than once per this window
// (prevents spamming while the bus lingers near the stop). Keyed per
// student+stop-type+day in memory. For a single-process MVP this is fine;
// move to a table if you ever run multiple backend instances.
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const lastAlarmAt = new Map(); // key: `${studentId}:${type}` -> timestamp

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Cache of bus_id -> students (with pickup/drop coords), refreshed periodically
// so we're not hitting the DB for the roster on every single GPS ping.
const rosterCache = new Map(); // bus_id -> { students, fetchedAt }
const ROSTER_TTL_MS = 60 * 1000;

async function getRoster(busId) {
  const cached = rosterCache.get(busId);
  if (cached && Date.now() - cached.fetchedAt < ROSTER_TTL_MS) {
    return cached.students;
  }
  const { data, error } = await supabase
    .from('students')
    .select('id, full_name, pickup_lat, pickup_lng, drop_lat, drop_lng')
    .eq('bus_id', busId);
  if (error) {
    console.error(`[Proximity] roster load failed for bus ${busId}:`, error.message);
    return cached?.students || [];
  }
  rosterCache.set(busId, { students: data || [], fetchedAt: Date.now() });
  return data || [];
}

/**
 * Call for every GPS ping. Checks the bus against each student's pickup and
 * drop point; when within ALARM_RADIUS_METERS (and past cooldown), enqueues a
 * proximity-alarm notification for that student's parents.
 *
 * Which point matters depends on the trip: in the morning the pickup point,
 * in the afternoon the drop point. For the MVP we check BOTH — a bus only
 * gets near a student's pickup OR drop point at the relevant time anyway, so
 * checking both is simplest and correct in practice. Refine with trip
 * direction later if needed.
 */
export async function checkProximityAlarms({ busId, latitude, longitude }) {
  const students = await getRoster(busId);
  if (students.length === 0) return;

  const dayKey = todayKey();
  const queue = await getQueue();

  for (const s of students) {
    for (const type of ['pickup', 'drop']) {
      const lat = type === 'pickup' ? s.pickup_lat : s.drop_lat;
      const lng = type === 'pickup' ? s.pickup_lng : s.drop_lng;
      if (lat == null || lng == null) continue;

      const dist = getDistanceToNextStopInMeters(
        { lat: latitude, lon: longitude },
        { lat, lon: lng }
      );
      if (dist == null || dist > ALARM_RADIUS_METERS) continue;

      const key = `${s.id}:${type}:${dayKey}`;
      const last = lastAlarmAt.get(key) || 0;
      if (Date.now() - last < COOLDOWN_MS) continue;

      lastAlarmAt.set(key, Date.now());
      await queue.send(JOBS.DISPATCH_NOTIFICATION, {
        type: 'PROXIMITY_ALARM',
        studentId: s.id,
        busId,
        stopType: type,
        distanceMeters: Math.round(dist),
        title: 'Bus is approaching',
        body: `The bus is about ${Math.round(dist)}m from ${s.full_name}'s ${type} point.`,
      });
      console.log(`[Proximity] ALARM queued: ${s.full_name} ${type} (${Math.round(dist)}m)`);
    }
  }
}
