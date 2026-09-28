import { getDistanceToNextStopInMeters } from '../utils/geoUtils.js';

/**
 * Pure ETA logic — no database, no network — so it can be unit-tested
 * (see eta.test.js). etaWorker.js feeds it data and acts on the result.
 *
 * A "stop" here is one entry of routes.stop_sequence:
 *   { sequence, student_ids: [...], lat, lng, baseline_leg_seconds }
 * baseline_leg_seconds = Mapbox's driving time from the PREVIOUS stop to this
 * one (no boarding time). The SCHOOL waypoint has student_ids = [].
 */

export const DEFAULTS = {
  avgSpeedKmh: 20,        // typical school-bus speed on Kerala roads, incl. junctions
  maxSpeedKmh: 45,        // physical lower bound: bus can't be faster than this on average
  roadFactor: 1.4,        // road distance is ~1.4x straight-line distance
  dwellSeconds: 45,       // boarding/alighting time at each student stop
  learningRate: 0.3,      // how fast learned times follow new trips (0..1)
  outlierFactor: 3,       // ignore a leg that took >3x or <1/3 of the expected time
  arrivalRadiusMeters: 100, // bus within this of a stop = "reached it" (10s pings at ≤36 km/h always land inside)
};

const toKmhToMps = (kmh) => (kmh * 1000) / 3600;

function dist(a, b) {
  return getDistanceToNextStopInMeters({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
}

/** Stable key for the road between two stops (survives route regeneration). */
export function segmentKey(from, to) {
  const r = (n) => Number(n).toFixed(4);
  return `${r(from.lat)},${r(from.lng)}>${r(to.lat)},${r(to.lng)}`;
}

/** Normalises old-format stops ({student_id}) and new ones ({student_ids}). */
export function normaliseStops(stopSequence) {
  return (stopSequence || []).map((s, i) => ({
    sequence: s.sequence ?? i,
    lat: s.lat,
    lng: s.lng,
    student_ids: s.student_ids || (s.student_id ? [s.student_id] : []),
    baseline_leg_seconds: s.baseline_leg_seconds ?? null,
  }));
}

/** Rough driving time from a point to a stop using straight-line distance. */
export function distanceEstimateSeconds(from, to, opts = DEFAULTS) {
  const d = dist(from, to);
  if (d == null) return null;
  return (d * opts.roadFactor) / toKmhToMps(opts.avgSpeedKmh);
}

/**
 * Expected seconds from reaching stop k-1 to reaching stop k (boarding time
 * at k-1 included). Priority: learned average > Mapbox baseline + dwell >
 * distance estimate + dwell.
 */
export function expectedLegSeconds(stops, k, learned, opts = DEFAULTS) {
  const prev = stops[k - 1];
  const cur = stops[k];
  const l = learned?.get(segmentKey(prev, cur));
  if (l && l.avg_seconds > 0) return l.avg_seconds;

  const dwell = prev.student_ids.length > 0 ? opts.dwellSeconds : 0;
  if (cur.baseline_leg_seconds != null) return cur.baseline_leg_seconds + dwell;
  return distanceEstimateSeconds(prev, cur, opts) + dwell;
}

/**
 * Returns the index of the nearest not-yet-reached stop within the arrival
 * radius, or null. Uses GPS position, not the planned order, so a driver who
 * swaps two stops is still tracked correctly.
 */
export function detectArrival(stops, visited, bus, opts = DEFAULTS) {
  let best = null;
  let bestD = Infinity;
  stops.forEach((s, i) => {
    if (visited[i] != null) return;
    const d = dist(bus, s);
    if (d != null && d <= opts.arrivalRadiusMeters && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * ETA in seconds for every not-yet-reached student stop.
 *
 * - Stops AFTER the last stop reached: follow the planned order, summing
 *   expected leg times. For the leg currently being driven, subtract the
 *   time already spent on it (but never go below what's physically possible).
 * - Stops BEFORE the last stop reached (driver skipped or reordered): no
 *   reliable sequence, so use a distance-based estimate.
 * - ordered=false (no generated route yet): distance-based estimate for all.
 *
 * @returns {Map<number, number>} stop index -> eta seconds
 */
export function computeEtas({ stops, visited, anchor, bus, now, learned, ordered = true, opts = DEFAULTS }) {
  const etas = new Map();
  const isTarget = (i) => stops[i].student_ids.length > 0 && visited[i] == null;

  if (!ordered) {
    stops.forEach((s, i) => {
      if (isTarget(i)) etas.set(i, distanceEstimateSeconds(bus, s, opts));
    });
    return etas;
  }

  const a = anchor ? anchor.index : -1;

  // Out-of-order leftovers behind the anchor.
  for (let i = 0; i <= a; i++) {
    if (isTarget(i)) etas.set(i, distanceEstimateSeconds(bus, stops[i], opts));
  }

  const next = a + 1;
  if (next >= stops.length) return etas;

  // Time to reach the next planned stop.
  const direct = distanceEstimateSeconds(bus, stops[next], opts);
  const fastest = (dist(bus, stops[next]) ?? 0) / toKmhToMps(opts.maxSpeedKmh);
  let t;
  if (anchor) {
    const elapsed = (now - anchor.at) / 1000;
    const left = expectedLegSeconds(stops, next, learned, opts) - elapsed;
    // Running late (expected time used up) -> fall back to distance estimate.
    t = left > 0 ? Math.max(left, fastest) : direct;
  } else {
    t = direct; // trip just started, no stop reached yet
  }

  if (isTarget(next)) etas.set(next, t);
  for (let k = next + 1; k < stops.length; k++) {
    t += expectedLegSeconds(stops, k, learned, opts);
    if (isTarget(k)) etas.set(k, t);
  }
  return etas;
}

/**
 * New learned average after a real leg time, or null if the sample is an
 * outlier (breakdown, fuel stop, GPS gap) and should be ignored.
 */
export function learnLeg(previousAvg, actualSeconds, opts = DEFAULTS) {
  if (!(actualSeconds > 0)) return null;
  if (previousAvg > 0) {
    const ratio = actualSeconds / previousAvg;
    if (ratio > opts.outlierFactor || ratio < 1 / opts.outlierFactor) return null;
    return previousAvg + opts.learningRate * (actualSeconds - previousAvg);
  }
  return actualSeconds;
}
