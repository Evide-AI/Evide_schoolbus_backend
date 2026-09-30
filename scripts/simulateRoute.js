// Drives a simulated GT06 device along a bus's SAVED route, at a realistic
// speed, pausing at every stop — for testing ETA / "arriving in ~10 min"
// notification timing end to end.
//
//   node scripts/simulateRoute.js                        # "TEST BUS 01", today's route type
//   node scripts/simulateRoute.js --bus-name "TEST BUS 02"
//   node scripts/simulateRoute.js --student "Student Test"  # that student's bus
//   node scripts/simulateRoute.js --bus <bus uuid>
//   node scripts/simulateRoute.js --type pickup          # force pickup or drop
//   node scripts/simulateRoute.js --speed 25             # cruise km/h (default 25)
//   node scripts/simulateRoute.js --dwell 45             # seconds stopped at each stop
//   node scripts/simulateRoute.js --from-stop 3          # start partway along the route
//
// Needs the backend running (npm start) and SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY in .env. The bus must have gt06_device_imei set.
//
// Timing is real time: a 30-minute route takes 30 minutes. That's deliberate —
// the ETA worker measures elapsed wall-clock time, so speeding the clock up
// would make every alert look late or early.

import 'dotenv/config';
import net from 'node:net';
import { createClient } from '@supabase/supabase-js';
import crc16 from '../src/gt06/crc16.js';
import { decodePolyline, cumulative, pointAt, haversine, bearing } from './lib/polyline.js';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const HOST = process.env.SIM_HOST || 'localhost';
const PORT = Number(process.env.SIM_PORT || 5023);
const PING_SECONDS = 10; // same as a real device
const SPEED_KMH = Number(arg('--speed') || 25);
const DWELL_SECONDS = Number(arg('--dwell') || 45);
const FROM_STOP = Number(arg('--from-stop') || 0);
const ANCHOR_NAME = arg('--student');
const BUS_NAME = arg('--bus-name') || 'TEST BUS 01';
const TZ = 'Asia/Kolkata';
const PICKUP_CUTOFF_HOUR = Number(process.env.PICKUP_CUTOFF_HOUR || 12);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- GT06 packets (same format as simulateGt06Device.js) ----------

function buildPacket(protocolNumber, content, serial) {
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial & 0xffff, 0);
  const body = Buffer.concat([
    Buffer.from([content.length + 1 + 2 + 2]),
    Buffer.from([protocolNumber]),
    content,
    serialBuf,
  ]);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crc16(body), 0);
  return Buffer.concat([Buffer.from([0x78, 0x78]), body, crcBuf, Buffer.from([0x0d, 0x0a])]);
}

function loginPacket(imei, serial) {
  const digits = imei.padStart(16, '0');
  const bcd = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) bcd[i] = (parseInt(digits[i * 2], 10) << 4) | parseInt(digits[i * 2 + 1], 10);
  return buildPacket(0x01, bcd, serial);
}

function locationPacket({ lat, lng, speedKmh, course }, serial) {
  const now = new Date();
  const c = Buffer.alloc(26);
  c[0] = now.getUTCFullYear() - 2000;
  c[1] = now.getUTCMonth() + 1;
  c[2] = now.getUTCDate();
  c[3] = now.getUTCHours();
  c[4] = now.getUTCMinutes();
  c[5] = now.getUTCSeconds();
  c[6] = 0xcf; // satellite info (same dummy value as simulateGt06Device.js)
  c.writeUInt32BE(Math.round(Math.abs(lat) * 1800000), 7);
  c.writeUInt32BE(Math.round(Math.abs(lng) * 1800000), 11);
  c[15] = Math.max(0, Math.min(255, Math.round(speedKmh)));
  // Course/status: bit12 GPS positioned, bit11 west longitude, bit10 north latitude.
  let cs = Math.round(course) & 0x3ff;
  cs |= 1 << 12;
  if (lng < 0) cs |= 1 << 11;
  if (lat >= 0) cs |= 1 << 10;
  c.writeUInt16BE(cs, 16);
  c.writeUInt16BE(0x04c8, 18); // mcc (dummy)
  c[20] = 0x01;                 // mnc (dummy)
  c.writeUInt16BE(0x1234, 21);  // lac (dummy)
  c.writeUIntBE(0x56789a, 23, 3); // cellId (dummy)
  return buildPacket(0x12, c, serial);
}

// ---------- load bus + route ----------

async function loadBusAndRoute() {
  let busId = arg('--bus');
  if (!busId && !ANCHOR_NAME) {
    const { data, error } = await db.from('buses').select('id').eq('bus_number', BUS_NAME).limit(2);
    if (error) throw error;
    if (!data?.length) throw new Error(`No bus named "${BUS_NAME}". Run seedTestParents.js first, or use --bus <uuid>.`);
    if (data.length > 1) throw new Error(`More than one bus named "${BUS_NAME}". Use --bus <uuid>.`);
    busId = data[0].id;
  }
  if (!busId) {
    const { data, error } = await db.from('students').select('bus_id').ilike('full_name', ANCHOR_NAME).limit(2);
    if (error) throw error;
    if (!data?.length) throw new Error(`No student named "${ANCHOR_NAME}". Use --bus <uuid>.`);
    if (data.length > 1) throw new Error(`More than one "${ANCHOR_NAME}". Use --bus <uuid>.`);
    busId = data[0].bus_id;
  }
  const { data: bus, error: busErr } = await db
    .from('buses')
    .select('id, bus_number, gt06_device_imei, is_active')
    .eq('id', busId)
    .single();
  if (busErr || !bus) throw new Error(`Bus ${busId} not found.`);
  if (!bus.gt06_device_imei) throw new Error(`Bus ${bus.bus_number} has no gt06_device_imei — set one (any 15 digits) for the simulator.`);

  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
  const type = arg('--type') || (hour < PICKUP_CUTOFF_HOUR ? 'pickup' : 'drop');

  const { data: route, error: routeErr } = await db
    .from('routes')
    .select('polyline, stop_sequence')
    .eq('bus_id', busId)
    .eq('route_type', type)
    .single();
  if (routeErr || !route?.polyline) throw new Error(`No ${type} route for this bus. Run the seed script or generate the route first.`);

  const { data: students } = await db.from('students').select('id, full_name').eq('bus_id', busId);
  const names = new Map((students || []).map((s) => [s.id, s.full_name]));

  return { bus, type, route, names };
}

// Distance along the path of the vertex nearest each stop.
function stopPositions(path, cum, stops) {
  return stops.map((s) => {
    let best = 0, bestD = Infinity;
    path.forEach((p, i) => {
      const d = haversine(p, s);
      if (d < bestD) { bestD = d; best = i; }
    });
    return cum[best];
  });
}

// ---------- run ----------

async function main() {
  const { bus, type, route, names } = await loadBusAndRoute();
  const path = decodePolyline(route.polyline);
  const cum = cumulative(path);
  const total = cum[cum.length - 1];
  const stops = route.stop_sequence;
  const at = stopPositions(path, cum, stops);

  const label = (s) => {
    const ids = s.student_ids?.length ? s.student_ids : s.student_id ? [s.student_id] : [];
    return ids.length ? ids.map((id) => names.get(id) || id).join(' + ') : 'SCHOOL';
  };

  const mps = (SPEED_KMH * 1000) / 3600;
  const eta = (total - (at[FROM_STOP] || 0)) / mps + DWELL_SECONDS * (stops.length - 1 - FROM_STOP);
  console.log(`[SIM] Bus ${bus.bus_number} (IMEI ${bus.gt06_device_imei}) — ${type} route, ${(total / 1000).toFixed(1)} km, ${stops.length} stops`);
  console.log(`[SIM] ${SPEED_KMH} km/h, ${DWELL_SECONDS}s per stop, ~${Math.round(eta / 60)} min to finish. Ctrl+C to stop.`);
  if (process.env.REQUIRE_TRIP_IN_PROGRESS !== 'false') {
    console.log('[SIM] Alerts only fire while the trip is IN_PROGRESS: tap Start in the driver app, or let auto-start kick in after ~60s of movement.');
  }

  let pos = at[FROM_STOP] || 0;
  let nextStop = FROM_STOP;
  let dwellLeft = 0;
  let finished = false;
  let stationaryLeft = 200; // sit at the end long enough for auto-end (180s)

  const socket = net.createConnection(PORT, HOST, () => {
    let serial = 1;
    socket.write(loginPacket(bus.gt06_device_imei, serial++));
    const started = Date.now();

    const tick = () => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      let speed = 0;

      if (!finished && dwellLeft <= 0) {
        // Move toward the next stop.
        const target = at[nextStop] ?? total;
        const step = mps * PING_SECONDS;
        if (pos + step >= target) {
          pos = target;
          const s = stops[nextStop];
          console.log(`[SIM] t+${fmt(elapsed)}  ✔ Reached stop ${nextStop}: ${label(s)}`);
          if (nextStop >= stops.length - 1) {
            finished = true;
          } else {
            dwellLeft = DWELL_SECONDS;
            nextStop++;
          }
        } else {
          pos += step;
          speed = SPEED_KMH;
        }
      } else if (dwellLeft > 0) {
        dwellLeft -= PING_SECONDS;
      } else if (finished) {
        stationaryLeft -= PING_SECONDS;
        if (stationaryLeft <= 0) {
          console.log('[SIM] Route complete and parked at the end. Closing.');
          socket.end();
          return;
        }
      }

      const here = pointAt(path, cum, pos);
      const ahead = pointAt(path, cum, Math.min(total, pos + 30));
      socket.write(locationPacket({ ...here, speedKmh: speed, course: bearing(here, ahead) }, serial++));
      if (speed > 0 && elapsed % 60 < PING_SECONDS) {
        const next = stops[nextStop];
        const left = Math.max(0, (at[nextStop] ?? total) - pos);
        console.log(`[SIM] t+${fmt(elapsed)}  driving — ${Math.round(left)} m to stop ${nextStop} (${label(next)})`);
      }
      timer = setTimeout(tick, PING_SECONDS * 1000);
    };
    let timer = setTimeout(tick, 1000);
    socket.on('close', () => clearTimeout(timer));
  });

  socket.on('error', (err) => {
    console.error('[SIM] Connection error:', err.message, '— is the backend running (npm start)?');
    process.exit(1);
  });
  socket.on('close', () => process.exit(0));
  process.on('SIGINT', () => {
    console.log('\n[SIM] Stopped.');
    socket.end();
  });
}

const fmt = (sec) => `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;

main().catch((err) => {
  console.error('[SIM] Failed:', err.message);
  process.exit(1);
});
