import { supabase } from '../db/supabaseClient.js';
import { getSchoolSettings, activeWindow, serviceDate } from '../utils/schoolHours.js';

/**
 * Per-student trip events, driven by every GPS ping while a trip is running
 * inside school hours (see utils/schoolHours.js).
 *
 * Morning pickup:   waiting -> reached -> picked_up -> at_school
 *                                     \-> absent (marked absent after the bus reached the stop)
 * Evening drop:     waiting -> reached -> dropped
 *
 * Notifications (each sent once per student per trip, parents of that child only):
 *   REACHED_STOP    bus within 100 m of the stop (pickup or drop point)
 *   STUDENT_ABSENT  driver/conductor marked the child absent after the bus reached the stop
 *   REACHED_SCHOOL  bus within 100 m of the school with the child on board (morning)
 * ("Bus arriving in ~10 min" lives in etaWorker.js; attendance-marked entries
 *  come from the attendance trigger.)
 *
 * The stage is also written to student_trip_status so the parent app knows
 * what the yellow line should connect.
 */

const REACH_RADIUS_M = Number(process.env.REACH_RADIUS_METERS || 100);
const LEAVE_RADIUS_M = Number(process.env.LEAVE_RADIUS_METERS || 150);
const SCHOOL_RADIUS_M = Number(process.env.SCHOOL_RADIUS_METERS || 100);
const ATTENDANCE_TTL_MS = Number(process.env.ATTENDANCE_TTL_MS || 8000);
const ROSTER_TTL_MS = 5 * 60 * 1000;
const TRIP_TTL_MS = 15 * 1000;

const ctxByBus = new Map();   // busId -> context (see buildContext)
const tripCache = new Map();  // busId -> { at, running }
const lastPoint = new Map();  // busId -> { lat, lng }

// ---------- geometry ----------

function metersBetween(lat1, lng1, lat2, lng2) {
  const r = 6371000;
  const x = ((lng2 - lng1) * Math.PI / 180) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * r;
}

// Distance from point p to the segment a->b (metres, flat-earth is fine at this scale).
function metersToSegment(p, a, b) {
  const lat0 = p.lat;
  const k = Math.cos(lat0 * Math.PI / 180);
  const toXY = (q) => ({ x: (q.lng * Math.PI / 180) * k * 6371000, y: (q.lat * Math.PI / 180) * 6371000 });
  const P = toXY(p), A = toXY(a), B = toXY(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

// ---------- loaders ----------

async function getTrip(busId) {
  const hit = tripCache.get(busId);
  if (hit && Date.now() - hit.at < TRIP_TTL_MS) return hit;
  const { data } = await supabase.from('trip_state').select('status, started_at').eq('bus_id', busId).maybeSingle();
  const running = data?.status === 'IN_PROGRESS'
    && (!data.started_at || serviceDate(new Date(data.started_at)) === serviceDate());
  const startedMs = data?.started_at ? new Date(data.started_at).getTime() : 0;
  const entry = { at: Date.now(), running, startedMs };
  tripCache.set(busId, entry);
  return entry;
}

async function buildContext(busId, type, today, settings, previous, tripStartedMs) {
  const [latF, lngF] = type === 'pickup' ? ['pickup_lat', 'pickup_lng'] : ['drop_lat', 'drop_lng'];
  const [{ data: students, error }, { data: bus }] = await Promise.all([
    supabase.from('students').select(`id, full_name, ${latF}, ${lngF}`).eq('bus_id', busId),
    supabase.from('buses').select('bus_number').eq('id', busId).maybeSingle(),
  ]);
  if (error) {
    console.error(`[TripEvents] roster load failed for bus ${busId}:`, error.message);
    return previous || null;
  }

  // A new trip (different started_at) starts every student from 'waiting'
  // again, so a re-run on the same day never inherits the last run's stages.
  const ctx = previous && previous.day === today && previous.type === type
      && previous.tripStartedMs === tripStartedMs
    ? previous
    : { day: today, type, tripStartedMs, students: new Map(), attendance: { at: 0, map: new Map() }, loaded: false };

  // Resume from the database after a restart.
  let saved = new Map();
  if (!ctx.loaded) {
    const { data: rows } = await supabase
      .from('student_trip_status')
      .select('student_id, stage, reached_at, updated_at')
      .eq('bus_id', busId).eq('service_date', today).eq('route_type', type);
    // Only resume rows written during the current trip. Older rows belong to
    // an earlier run today and are overwritten with 'waiting' below.
    saved = new Map((rows || [])
      .filter((r) => !tripStartedMs || new Date(r.updated_at).getTime() >= tripStartedMs)
      .map((r) => [r.student_id, r]));
  }

  const fresh = [];
  for (const s of students || []) {
    if (ctx.students.has(s.id)) {
      Object.assign(ctx.students.get(s.id), { name: s.full_name, lat: s[latF], lng: s[lngF] });
      continue;
    }
    const row = saved.get(s.id);
    ctx.students.set(s.id, {
      id: s.id,
      name: s.full_name,
      lat: s[latF],
      lng: s[lngF],
      stage: row?.stage || 'waiting',
      reachedAt: row?.reached_at ? new Date(row.reached_at) : null,
      inferred: false,
    });
    if (!row) fresh.push(s.id);
  }
  ctx.busNumber = bus?.bus_number || 'The bus';
  ctx.loadedAt = Date.now();
  ctx.loaded = true;
  ctx.schoolId = settings.school_id;

  if (fresh.length) {
    // Rows exist from the start of the trip so the parent app always has a stage to read.
    await persist(busId, ctx, fresh.map((id) => ctx.students.get(id)));
  }
  return ctx;
}

async function getAttendance(ctx, busId, today) {
  if (Date.now() - ctx.attendance.at < ATTENDANCE_TTL_MS) return ctx.attendance.map;
  const { data, error } = await supabase
    .from('attendance')
    .select('student_id, present, marked_at')
    .eq('bus_id', busId)
    .eq('date', today);
  if (error) {
    console.error('[TripEvents] attendance load failed:', error.message);
    ctx.attendance.at = Date.now();
    return ctx.attendance.map;
  }
  ctx.attendance = {
    at: Date.now(),
    map: new Map((data || []).map((a) => [a.student_id, { present: a.present, markedAt: a.marked_at ? new Date(a.marked_at) : null }])),
  };
  return ctx.attendance.map;
}

async function persist(busId, ctx, changed) {
  if (!changed.length) return;
  const { error } = await supabase.from('student_trip_status').upsert(
    changed.map((s) => ({
      student_id: s.id,
      service_date: ctx.day,
      route_type: ctx.type,
      bus_id: busId,
      stage: s.stage,
      reached_at: s.reachedAt ? s.reachedAt.toISOString() : null,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: 'student_id,service_date,route_type' }
  );
  if (error) console.error('[TripEvents] stage save failed:', error.message);
}

// ---------- notifications ----------

/**
 * Sends one notification for this student and kind, once per trip. The unique
 * key on notification_log is the guard, so a restart or a repeated ping can't
 * send it twice. The row in `notifications` feeds the parent inbox, and the
 * database trigger on that table queues the push.
 */
async function notifyOnce(busId, ctx, student, kind, title, body) {
  const { data: claimed, error } = await supabase
    .from('notification_log')
    .upsert(
      [{ student_id: student.id, bus_id: busId, service_date: ctx.day, route_type: ctx.type, kind }],
      { onConflict: 'student_id,service_date,route_type,kind', ignoreDuplicates: true }
    )
    .select('student_id');
  if (error) {
    console.error(`[TripEvents] ${kind} claim failed:`, error.message);
    return;
  }
  if (!claimed?.length) return; // already sent for this trip

  const { error: insErr } = await supabase.from('notifications').insert({
    school_id: ctx.schoolId,
    bus_id: busId,
    student_id: student.id,
    category: kind,
    title,
    body,
    sender_type: 'system',
  });
  if (insErr) console.error(`[TripEvents] ${kind} insert failed:`, insErr.message);
  else console.log(`[TripEvents] ${kind} sent for student ${student.id}`);
}

const firstName = (s) => (s.name || 'Your child').split(' ')[0];

// ---------- main entry, called for every GPS ping ----------

export async function checkTripEvents({ busId, latitude, longitude }) {
  if (latitude == null || longitude == null) return;
  const now = new Date();
  const today = serviceDate(now);

  const prev = lastPoint.get(busId) || null;
  const bus = { lat: latitude, lng: longitude };
  lastPoint.set(busId, bus);

  const trip = await getTrip(busId);
  if (!trip.running) return;
  const settings = await getSchoolSettings(busId);
  const type = activeWindow(settings, now);
  if (!type) return; // outside school hours: no events, no notifications

  let ctx = ctxByBus.get(busId);
  if (!ctx || ctx.day !== today || ctx.type !== type || ctx.tripStartedMs !== trip.startedMs
      || Date.now() - ctx.loadedAt > ROSTER_TTL_MS) {
    ctx = await buildContext(busId, type, today, settings, ctx, trip.startedMs);
    if (!ctx) return;
    ctxByBus.set(busId, ctx);
  }

  const attendanceOn = settings.attendance_enabled !== false;
  const attendance = attendanceOn ? await getAttendance(ctx, busId, today) : new Map();
  const changed = [];
  const busNo = ctx.busNumber;

  const atSchool = settings.latitude != null && settings.longitude != null
    && metersBetween(latitude, longitude, settings.latitude, settings.longitude) <= SCHOOL_RADIUS_M;

  for (const s of ctx.students.values()) {
    const before = s.stage;
    const att = attendance.get(s.id);
    const hasStop = s.lat != null && s.lng != null;

    // Two passes so a fast bus can go waiting -> reached -> picked_up on one ping.
    for (let pass = 0; pass < 2; pass++) {
      const startStage = s.stage;
      const d = hasStop ? metersBetween(latitude, longitude, s.lat, s.lng) : Infinity;
      const closest = hasStop && prev
        ? Math.min(d, metersToSegment({ lat: s.lat, lng: s.lng }, prev, bus))
        : d;

      if (type === 'pickup') {
        if (s.stage === 'waiting') {
          if (hasStop && closest <= REACH_RADIUS_M) {
            s.stage = 'reached';
            s.reachedAt = now;
            await notifyOnce(busId, ctx, s, 'REACHED_STOP',
              `Bus reached ${firstName(s)}'s stop`,
              `${busNo} has reached ${firstName(s)}'s pickup point.`);
          } else if (!hasStop && att?.present === true) {
            // No stop coordinates to measure against: trust the attendance mark.
            // With a stop, "present" is only used once the bus has reached it,
            // so the yellow line keeps leading to the stop until then.
            s.stage = 'picked_up';
            s.inferred = false;
          }
        } else if (s.stage === 'reached' || (s.stage === 'picked_up' && s.inferred)) {
          const markedAbsentAfter = att?.present === false && att.markedAt && s.reachedAt && att.markedAt >= s.reachedAt;
          if (markedAbsentAfter) {
            s.stage = 'absent';
            await notifyOnce(busId, ctx, s, 'STUDENT_ABSENT',
              `${firstName(s)} was marked absent`,
              `${busNo} reached ${firstName(s)}'s pickup point, but ${firstName(s)} was marked absent today.`);
          } else if (att?.present === true) {
            s.stage = 'picked_up';
            s.inferred = false;
          } else if (s.stage === 'reached' && d > LEAVE_RADIUS_M) {
            // Bus has driven off and nobody marked the child absent: on board.
            s.stage = 'picked_up';
            s.inferred = true;
          }
        } else if (s.stage === 'absent') {
          if (att?.present === true) { s.stage = 'picked_up'; s.inferred = false; } // marked present after all
        }

        if (s.stage === 'picked_up' && atSchool) {
          s.stage = 'at_school';
          await notifyOnce(busId, ctx, s, 'REACHED_SCHOOL',
            `${firstName(s)} reached school`,
            `${busNo} has reached school with ${firstName(s)} on board.`);
        }
      } else {
        // Evening drop
        if (attendanceOn && att?.present === false && s.stage === 'waiting') {
          s.stage = 'absent'; // wasn't on the bus today
        } else if (s.stage === 'absent' && att?.present === true) {
          s.stage = 'waiting';
        } else if (s.stage === 'waiting' && hasStop && closest <= REACH_RADIUS_M) {
          s.stage = 'reached';
          s.reachedAt = now;
          await notifyOnce(busId, ctx, s, 'REACHED_STOP',
            `Bus reached ${firstName(s)}'s drop point`,
            `${busNo} has reached ${firstName(s)}'s drop point.`);
        } else if (s.stage === 'reached' && d > LEAVE_RADIUS_M) {
          s.stage = 'dropped';
        }
      }
      if (s.stage === startStage) break;
    }

    if (s.stage !== before) changed.push(s);
  }

  await persist(busId, ctx, changed);
}
