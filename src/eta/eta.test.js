// Run: node src/eta/eta.test.js   (or: npm run test:eta)
// No database or network needed — tests the pure ETA logic only.
import assert from 'node:assert/strict';
import {
  DEFAULTS, normaliseStops, segmentKey, expectedLegSeconds,
  detectArrival, computeEtas, learnLeg,
} from './etaCalculator.js';
import { groupIntoStops } from '../routes/stopOrdering.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ~111m per 0.001° latitude. Stops laid out northward from Tirur-ish coords.
const BASE = { lat: 10.9, lng: 75.92 };
const north = (m) => ({ lat: BASE.lat + m / 111_320, lng: BASE.lng });

console.log('ETA calculator');

test('groups students within 50m into one stop', () => {
  const stops = groupIntoStops([
    { id: 'a', ...north(0) },
    { id: 'b', ...north(30) },   // sibling next door
    { id: 'c', ...north(400) },
  ]);
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[0].ids, ['a', 'b']);
});

test('old-format stop_sequence (student_id) still works', () => {
  const s = normaliseStops([{ sequence: 0, student_id: 'x', lat: 1, lng: 2 }, { sequence: 1, student_id: null, lat: 1, lng: 3 }]);
  assert.deepEqual(s[0].student_ids, ['x']);
  assert.deepEqual(s[1].student_ids, []);
});

const stops = normaliseStops([
  { sequence: 0, student_ids: ['s0'], ...north(0), baseline_leg_seconds: null },
  { sequence: 1, student_ids: ['s1'], ...north(1000), baseline_leg_seconds: 180 },
  { sequence: 2, student_ids: ['s2'], ...north(2000), baseline_leg_seconds: 180 },
  { sequence: 3, student_ids: [], ...north(3000), baseline_leg_seconds: 180 }, // school
]);
const now = new Date('2026-09-28T02:00:00Z');

test('leg time = Mapbox baseline + boarding time', () => {
  assert.equal(expectedLegSeconds(stops, 2, new Map()), 180 + DEFAULTS.dwellSeconds);
});

test('learned time overrides Mapbox baseline', () => {
  const learned = new Map([[segmentKey(stops[1], stops[2]), { avg_seconds: 400 }]]);
  assert.equal(expectedLegSeconds(stops, 2, learned), 400);
});

test('ETA subtracts time already spent on the current leg', () => {
  const anchor = { index: 0, at: new Date(now - 60_000) }; // left stop 0 a minute ago
  const etas = computeEtas({ stops, visited: { 0: 'x' }, anchor, bus: north(300), now, learned: new Map() });
  assert.equal(Math.round(etas.get(1)), 225 - 60);
  assert.equal(Math.round(etas.get(2)), 165 + 225);
  assert.equal(etas.has(3), false, 'school is never a notification target');
});

test('bus running late falls back to distance estimate', () => {
  const anchor = { index: 0, at: new Date(now - 20 * 60_000) }; // stuck 20 min
  const etas = computeEtas({ stops, visited: { 0: 'x' }, anchor, bus: north(500), now, learned: new Map() });
  const expected = (500 * DEFAULTS.roadFactor) / (DEFAULTS.avgSpeedKmh / 3.6);
  assert.ok(Math.abs(etas.get(1) - expected) < 5);
});

test('stop skipped by driver (behind the anchor) still gets an ETA', () => {
  const anchor = { index: 2, at: now };
  const etas = computeEtas({ stops, visited: { 0: 'x', 2: 'x' }, anchor, bus: north(2000), now, learned: new Map() });
  assert.ok(etas.has(1));
  assert.ok(etas.get(1) > 0);
});

test('arrival detected only within 100m, nearest stop wins', () => {
  assert.equal(detectArrival(stops, {}, north(950)), 1);
  assert.equal(detectArrival(stops, {}, north(850)), null);
  assert.equal(detectArrival(stops, { 1: 'x' }, north(990)), null);
});

test('learning moves toward real time, ignores breakdowns', () => {
  assert.equal(learnLeg(200, 300), 230);
  assert.equal(learnLeg(200, 900), null); // 4.5x — outlier
  assert.equal(learnLeg(null, 250), 250);
});

// ------------------------------------------------------------------
// Simulated trip: 8 stops 800m apart, bus drives 18 km/h (slower than the
// 20 km/h default) and waits 60s at each stop. Mapbox baseline is optimistic
// (assumes 25 km/h). Check when the alert fires vs the real arrival time,
// first with no history, then after 5 trips of learning.
// ------------------------------------------------------------------
console.log('\nSimulated trip (10s GPS pings)');

function simulate(learned) {
  const n = 8, gap = 800, speed = 18 / 3.6, dwell = 60, mapboxSpeed = 25 / 3.6;
  const route = normaliseStops(Array.from({ length: n }, (_, i) => ({
    sequence: i, student_ids: [`s${i}`], ...north(i * gap),
    baseline_leg_seconds: i === 0 ? null : gap / mapboxSpeed,
  })));

  // Real timeline: bus starts 1500m before stop 0.
  const arriveAt = [];
  let t = 1500 / speed;
  for (let i = 0; i < n; i++) { arriveAt.push(t); t += dwell + gap / speed; }
  const posAt = (sec) => {
    let m = -1500, clock = 0;
    for (let i = 0; i < n; i++) {
      const drive = (i === 0 ? 1500 : gap) / speed;
      if (sec < clock + drive) return north(m + (sec - clock) * speed);
      clock += drive; m += i === 0 ? 1500 : gap;
      if (sec < clock + dwell) return north(m);
      clock += dwell;
    }
    return north(m);
  };

  const start = Date.parse('2026-09-28T01:30:00Z');
  const visited = {};
  let anchor = null;
  const firedAt = {};
  const legs = [];
  for (let sec = 0; sec < t; sec += 10) {
    const bus = posAt(sec);
    const nowD = new Date(start + sec * 1000);
    const hit = detectArrival(route, visited, bus);
    if (hit != null) {
      if (anchor && hit === anchor.index + 1) legs.push([anchor.index, hit, (nowD - anchor.at) / 1000]);
      visited[hit] = 'x';
      anchor = { index: hit, at: nowD };
    }
    const etas = computeEtas({ stops: route, visited, anchor, bus, now: nowD, learned });
    for (const [i, eta] of etas) {
      if (firedAt[i] == null && eta <= 600) firedAt[i] = sec;
    }
  }
  // Learn from this trip's real legs.
  for (const [a, b, s] of legs) {
    const key = segmentKey(route[a], route[b]);
    const prev = learned.get(key)?.avg_seconds ?? expectedLegSeconds(route, b, learned);
    const next = learnLeg(prev, s);
    if (next != null) learned.set(key, { avg_seconds: next });
  }
  // Minutes of warning each parent actually got (stops whose true arrival is >10 min in).
  return route.map((_, i) => i).filter((i) => arriveAt[i] > 660 && firedAt[i] != null)
    .map((i) => (arriveAt[i] - firedAt[i]) / 60);
}

const learned = new Map();
const fmt = (w) => w.map((m) => m.toFixed(1)).join(', ');
const trip1 = simulate(learned);
console.log(`  Trip 1 (no history)  — minutes of warning: ${fmt(trip1)}`);
for (let i = 0; i < 4; i++) simulate(learned);
const trip6 = simulate(learned);
console.log(`  Trip 6 (learned)     — minutes of warning: ${fmt(trip6)}`);

test('after learning, every parent gets 9–11 minutes of warning', () => {
  trip6.forEach((m) => assert.ok(m >= 9 && m <= 11, `got ${m.toFixed(1)} min`));
});

console.log(`\n${passed} tests passed`);
