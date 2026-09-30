import { supabase } from '../db/supabaseClient.js';
import { getQueue, JOBS } from '../queue/queue.js';
import { getDistanceToNextStopInMeters } from '../utils/geoUtils.js';
import { currentWindowForBus } from '../utils/schoolHours.js';
import {
  DEFAULTS,
  normaliseStops,
  segmentKey,
  expectedLegSeconds,
  detectArrival,
  computeEtas,
  learnLeg,
} from '../eta/etaCalculator.js';

/**
 * "Bus arriving in ~10 minutes" notifications. Replaces proximityWorker.js.
 *
 * On every GPS ping (every 10s):
 *   1. Work out today's route (pickup before PICKUP_CUTOFF_HOUR IST, else drop).
 *   2. If the bus has reached a stop, record it and learn that leg's real time.
 *   3. Compute an ETA for every student stop not yet reached.
 *   4. Alert parents when ETA <= ETA_ALERT_SECONDS, or as a safety net when the
 *      bus is within FALLBACK_RADIUS_METERS — once per student per trip.
 *
 * DB reads are cached (route 5 min, roster 60s, trip state 15s), so a normal
 * ping does no DB queries at all. Writes happen only when a stop is reached
 * or an alert is sent.
 */

const ETA_ALERT_SECONDS = Number(process.env.ETA_ALERT_SECONDS || 600);
const FALLBACK_RADIUS_METERS = Number(process.env.FALLBACK_RADIUS_METERS || 500);
const PICKUP_CUTOFF_HOUR = Number(process.env.PICKUP_CUTOFF_HOUR || 12);
// Only alert while a trip is running (driver tapped Start, or auto-detected).
// Stops false alerts when a bus moves on a holiday or for maintenance.
const REQUIRE_TRIP_IN_PROGRESS = process.env.REQUIRE_TRIP_IN_PROGRESS !== 'false';
const MAX_LEG_SECONDS_TO_LEARN = 30 * 60;
const TZ = 'Asia/Kolkata';

// ---------- time helpers (IST) ----------

function serviceDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function routeTypeFor(d = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(d));
  return hour < PICKUP_CUTOFF_HOUR ? 'pickup' : 'drop';
}

function clockTime(d) {
  return d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
}

// ---------- caches ----------

function ttlCache(ttlMs) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      return e && Date.now() - e.at < ttlMs ? e.v : undefined;
    },
    set(k, v) { m.set(k, { v, at: Date.now() }); },
    delete(k) { m.delete(k); },
  };
}

const routeCache = ttlCache(5 * 60 * 1000);   // `${busId}:${type}` -> { stops, ordered, learned }
const rosterCache = ttlCache(60 * 1000);      // `${busId}:${type}` -> roster
const tripCache = ttlCache(15 * 1000);        // busId -> boolean running

// Per-day state, cleared when the IST date changes.
let currentDay = null;
const progressByKey = new Map(); // `${busId}:${type}` -> { visited, anchor }
const alerted = new Set();       // `${type}:${studentId}` already notified today

function rollDay(today) {
  if (currentDay === today) return;
  currentDay = today;
  progressByKey.clear();
  alerted.clear();
}

// ---------- loaders ----------

async function isTripRunning(busId) {
  const cached = tripCache.get(busId);
  if (cached !== undefined) return cached;
  const { data } = await supabase.from('trip_state').select('status, started_at').eq('bus_id', busId).maybeSingle();
  const running = data?.status === 'IN_PROGRESS'
    && (!data.started_at || serviceDate(new Date(data.started_at)) === serviceDate());
  tripCache.set(busId, running);
  return running;
}

async function loadLearned(busId, type) {
  const { data, error } = await supabase
    .from('route_segment_stats')
    .select('segment_key, avg_seconds, samples')
    .eq('bus_id', busId)
    .eq('route_type', type);
  if (error) console.error('[ETA] segment stats load failed:', error.message);
  return new Map((data || []).map((r) => [r.segment_key, r]));
}

/** Loads the roster: students on this bus, their stop coords, parents, bus number. */
async function getRoster(busId, type) {
  const key = `${busId}:${type}`;
  const cached = rosterCache.get(key);
  if (cached) return cached;

  const [latF, lngF] = type === 'pickup' ? ['pickup_lat', 'pickup_lng'] : ['drop_lat', 'drop_lng'];
  const [{ data: students, error }, { data: bus }] = await Promise.all([
    supabase.from('students').select(`id, full_name, ${latF}, ${lngF}`).eq('bus_id', busId),
    supabase.from('buses').select('bus_number').eq('id', busId).maybeSingle(),
  ]);
  if (error) {
    console.error(`[ETA] roster load failed for bus ${busId}:`, error.message);
    return null;
  }

  const ids = (students || []).map((s) => s.id);
  const parentsOf = new Map();
  let absent = new Set();
  if (ids.length > 0) {
    const { data: links } = await supabase
      .from('parent_student_links')
      .select('student_id, parent_user_id')
      .in('student_id', ids);
    for (const l of links || []) {
      if (!parentsOf.has(l.student_id)) parentsOf.set(l.student_id, []);
      parentsOf.get(l.student_id).push(l.parent_user_id);
    }
    // Drop trip only: a student marked absent today isn't on the bus.
    if (type === 'drop') {
      const { data: att } = await supabase
        .from('attendance')
        .select('student_id')
        .eq('date', serviceDate())
        .eq('present', false)
        .in('student_id', ids);
      absent = new Set((att || []).map((a) => a.student_id));
    }
  }

  const roster = {
    busNumber: bus?.bus_number || 'The bus',
    students: new Map((students || []).map((s) => [s.id, { ...s, lat: s[latF], lng: s[lngF] }])),
    parentsOf,
    absent,
  };
  rosterCache.set(key, roster);
  return roster;
}

/**
 * The stops for this trip. Uses the generated route when there is one;
 * otherwise falls back to one unordered stop per student (distance-based
 * ETAs only), so alerts still work before a route is generated.
 */
async function getStops(busId, type, roster) {
  const key = `${busId}:${type}`;
  const cached = routeCache.get(key);
  if (cached) return cached;

  const { data: route } = await supabase
    .from('routes')
    .select('stop_sequence')
    .eq('bus_id', busId)
    .eq('route_type', type)
    .maybeSingle();

  let result;
  if (route?.stop_sequence?.length) {
    result = {
      stops: normaliseStops(route.stop_sequence),
      ordered: true,
      learned: await loadLearned(busId, type),
    };
  } else {
    const stops = [...roster.students.values()]
      .filter((s) => s.lat != null && s.lng != null)
      .map((s, i) => ({ sequence: i, lat: s.lat, lng: s.lng, student_ids: [s.id], baseline_leg_seconds: null }));
    result = { stops, ordered: false, learned: new Map() };
  }
  routeCache.set(key, result);
  return result;
}

async function getProgress(busId, type, today) {
  const key = `${busId}:${type}`;
  if (progressByKey.has(key)) return progressByKey.get(key);

  const { data } = await supabase
    .from('trip_progress')
    .select('visited, anchor_index, anchor_at')
    .eq('bus_id', busId)
    .eq('service_date', today)
    .eq('route_type', type)
    .maybeSingle();

  const progress = {
    visited: data?.visited || {},
    anchor: data?.anchor_index != null ? { index: data.anchor_index, at: new Date(data.anchor_at) } : null,
  };
  progressByKey.set(key, progress);
  return progress;
}

// ---------- writers ----------

async function saveProgress(busId, type, today, progress) {
  const { error } = await supabase.from('trip_progress').upsert(
    {
      bus_id: busId,
      service_date: today,
      route_type: type,
      visited: progress.visited,
      anchor_index: progress.anchor?.index ?? null,
      anchor_at: progress.anchor?.at?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'bus_id,service_date,route_type' }
  );
  if (error) console.error('[ETA] saving trip progress failed:', error.message);
}

/** Learns the real time of the leg just driven, if it was the planned next stop. */
async function recordLeg(busId, type, route, fromIdx, toIdx, seconds) {
  if (!route.ordered || toIdx !== fromIdx + 1 || seconds > MAX_LEG_SECONDS_TO_LEARN) return;

  const { stops, learned } = route;
  // Don't learn the leg leaving school on a drop trip: it includes waiting
  // at school while children board, which isn't road time.
  if (stops[fromIdx].student_ids.length === 0) return;
  const key = segmentKey(stops[fromIdx], stops[toIdx]);
  const prev = learned.get(key);
  const prevAvg = prev?.avg_seconds ?? expectedLegSeconds(stops, toIdx, learned);
  const next = learnLeg(prevAvg, seconds);
  if (next == null) {
    console.log(`[ETA] bus ${busId}: ignored outlier leg ${fromIdx}->${toIdx} (${Math.round(seconds)}s vs ~${Math.round(prevAvg)}s)`);
    return;
  }

  const row = { segment_key: key, avg_seconds: next, samples: (prev?.samples || 0) + 1 };
  learned.set(key, row);
  const { error } = await supabase.from('route_segment_stats').upsert(
    { bus_id: busId, route_type: type, ...row, updated_at: new Date().toISOString() },
    { onConflict: 'bus_id,route_type,segment_key' }
  );
  if (error) console.error('[ETA] saving segment stats failed:', error.message);
}

/**
 * Claims the alert in notification_log (the unique key makes this safe even
 * across restarts), then queues one push per parent. Siblings at the same
 * stop are combined into a single notification for their shared parent.
 */
async function sendArrivingAlerts({ busId, type, today, roster, studentIds, etaSeconds, now }) {
  const candidates = studentIds.filter((id) => !alerted.has(`${type}:${id}`) && !roster.absent.has(id));
  if (candidates.length === 0) return;

  const { data: claimed, error } = await supabase
    .from('notification_log')
    .upsert(
      candidates.map((id) => ({
        student_id: id,
        bus_id: busId,
        service_date: today,
        route_type: type,
        kind: 'ARRIVING_SOON',
        eta_seconds: Math.round(etaSeconds),
      })),
      { onConflict: 'student_id,service_date,route_type,kind', ignoreDuplicates: true }
    )
    .select('student_id');
  if (error) {
    console.error('[ETA] notification_log claim failed (will retry next ping):', error.message);
    return;
  }

  // Everything in candidates is now either claimed by us or already sent before.
  candidates.forEach((id) => alerted.add(`${type}:${id}`));
  if (!claimed?.length) return;

  // Group claimed students by parent so siblings share one notification.
  const byParent = new Map();
  for (const { student_id } of claimed) {
    for (const parentId of roster.parentsOf.get(student_id) || []) {
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(student_id);
    }
  }

  const minutes = Math.max(1, Math.round(etaSeconds / 60));
  const at = clockTime(new Date(now.getTime() + etaSeconds * 1000));
  const point = type === 'pickup' ? 'pickup' : 'drop';
  const queue = await getQueue();

  for (const [parentId, ids] of byParent) {
    const names = ids.map((id) => roster.students.get(id)?.full_name?.split(' ')[0] || 'your child');
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0];
    await queue.send(JOBS.DISPATCH_NOTIFICATION, {
      type: 'PROXIMITY_ALARM', // keeps the alarm sound channel in the parent app
      parentUserIds: [parentId],
      studentIds: ids,
      busId,
      title: `Bus arriving in about ${minutes} min`,
      body: `${roster.busNumber} will reach ${who}'s ${point} point in about ${minutes} minutes (around ${at}).`,
    });
  }
  console.log(`[ETA] bus ${busId}: alert queued for ${claimed.length} student(s), ETA ${minutes} min`);
}

// ---------- main entry, called for every GPS ping ----------

export async function checkArrivalEtas({ busId, latitude, longitude }) {
  if (latitude == null || longitude == null) return;
  const now = new Date();
  const today = serviceDate(now);
  rollDay(today);

  if (REQUIRE_TRIP_IN_PROGRESS && !(await isTripRunning(busId))) return;

  // Only inside the school's morning / evening windows; the window also says
  // whether this is the pickup or the drop run.
  const type = await currentWindowForBus(busId, now);
  if (!type) return;
  const roster = await getRoster(busId, type);
  if (!roster || roster.students.size === 0) return;

  const route = await getStops(busId, type, roster);
  if (route.stops.length === 0) return;

  const progress = await getProgress(busId, type, today);
  const bus = { lat: latitude, lng: longitude };

  // 1. Did the bus just reach a stop?
  const reached = detectArrival(route.stops, progress.visited, bus);
  if (reached != null) {
    if (progress.anchor) {
      const seconds = (now - progress.anchor.at) / 1000;
      await recordLeg(busId, type, route, progress.anchor.index, reached, seconds);
    }
    progress.visited[reached] = now.toISOString();
    progress.anchor = { index: reached, at: now };
    await saveProgress(busId, type, today, progress);
    // A student stop that's been reached no longer needs an alert.
    route.stops[reached].student_ids.forEach((id) => alerted.add(`${type}:${id}`));
  }

  // 2. ETAs for every remaining student stop, and alerts when due.
  const etas = computeEtas({
    stops: route.stops,
    visited: progress.visited,
    anchor: progress.anchor,
    bus,
    now,
    learned: route.learned,
    ordered: route.ordered,
    opts: DEFAULTS,
  });

  for (const [idx, eta] of etas) {
    const stop = route.stops[idx];
    const distance = getDistanceToNextStopInMeters({ lat: latitude, lon: longitude }, { lat: stop.lat, lon: stop.lng });
    const due = eta <= ETA_ALERT_SECONDS || (distance != null && distance <= FALLBACK_RADIUS_METERS);
    if (!due) continue;
    await sendArrivingAlerts({ busId, type, today, roster, studentIds: stop.student_ids, etaSeconds: eta, now });
  }
}

/** Call after a route is regenerated so the next ping uses the new stops. */
export function invalidateBusCache(busId) {
  for (const type of ['pickup', 'drop']) {
    routeCache.delete(`${busId}:${type}`);
    rosterCache.delete(`${busId}:${type}`);
  }
}
