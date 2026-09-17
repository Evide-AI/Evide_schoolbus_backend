// Simulates a real GT06 device: connects to your running server over TCP,
// sends a real login packet, then a stream of GPS location packets that
// move from a "home" point toward a "school" point, then sit still at the
// school — enough to exercise the full pipeline including the trip
// auto-start/auto-end logic, not just raw ingestion.
//
// Usage:
//   node scripts/simulateGt06Device.js
//
// Before running: register a bus in Supabase with gt06_device_imei matching
// IMEI below (is_active = true), and make sure its school has latitude/
// longitude set matching SCHOOL below (or edit SCHOOL to match your real
// test data).

import net from 'node:net';
import crc16 from '../src/gt06/crc16.js';

const HOST = process.env.SIM_HOST || 'localhost';
const PORT = Number(process.env.SIM_PORT || 5023);
const IMEI = process.env.SIM_IMEI || '864404031234567'; // must match a bus's gt06_device_imei in Supabase
const PING_INTERVAL_MS = 5000; // send a position every 5 seconds

// Edit these to match real coordinates from your test data.
const HOME = { lat: 10.950, lng: 76.020 };   // "student home" / far from school
const SCHOOL = { lat: 10.965, lng: 76.040 }; // must match your school's lat/lng in Supabase

const MOVE_DURATION_MS = 90 * 1000;   // ~90s of movement — enough to cross the 60s auto-start threshold
const STATIONARY_DURATION_MS = 200 * 1000; // ~200s stationary at school — enough to cross the 180s auto-end threshold

function buildPacket(protocolNumber, content, serial) {
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial & 0xffff, 0);
  const body = Buffer.concat([
    Buffer.from([content.length + 1 + 2 + 2]),
    Buffer.from([protocolNumber]),
    content,
    serialBuf,
  ]);
  const crc = crc16(body);
  const crcBuf = Buffer.alloc(2);
  crcBuf.writeUInt16BE(crc, 0);
  return Buffer.concat([Buffer.from([0x78, 0x78]), body, crcBuf, Buffer.from([0x0d, 0x0a])]);
}

function buildLoginPacket(imei, serial) {
  // IMEI as 8-byte BCD, left-padded with 0 to 16 digits.
  const digits = imei.padStart(16, '0');
  const bcd = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    const high = parseInt(digits[i * 2], 10);
    const low = parseInt(digits[i * 2 + 1], 10);
    bcd[i] = (high << 4) | low;
  }
  return buildPacket(0x01, bcd, serial);
}

function buildLocationPacket({ lat, lng, speedKmh, course }, serial) {
  const now = new Date();
  const content = Buffer.alloc(26);
  content[0] = now.getUTCFullYear() - 2000;
  content[1] = now.getUTCMonth() + 1;
  content[2] = now.getUTCDate();
  content[3] = now.getUTCHours();
  content[4] = now.getUTCMinutes();
  content[5] = now.getUTCSeconds();
  content[6] = 0xcf; // satellite info (dummy, plausible value)

  const isSouth = lat < 0;
  const isWest = lng < 0;
  const rawLat = Math.round(Math.abs(lat) * 60 * 30000);
  const rawLng = Math.round(Math.abs(lng) * 60 * 30000);
  content.writeUInt32BE(rawLat, 7);
  content.writeUInt32BE(rawLng, 11);
  content[15] = Math.max(0, Math.min(255, Math.round(speedKmh)));

  let courseStatus = Math.round(course) & 0x03ff; // bits 0-9: heading
  courseStatus |= 0x1000; // bit 12: GPS positioned (per decodeGt06Lat/Lon's expectations)
  if (!isSouth) courseStatus |= 0x0400; // bit 10 set = north (per your existing gt06.js)
  if (isWest) courseStatus |= 0x0800;   // bit 11 set = west
  content.writeUInt16BE(courseStatus, 16);

  content.writeUInt16BE(0x04c8, 18); // mcc (dummy)
  content[20] = 0x01;                 // mnc (dummy)
  content.writeUInt16BE(0x1234, 21);  // lac (dummy)
  content.writeUIntBE(0x56789a, 23, 3); // cellId (dummy)

  return buildPacket(0x12, content, serial);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

console.log(`[SIM] Connecting to ${HOST}:${PORT} as IMEI ${IMEI}`);
console.log(`[SIM] Route: (${HOME.lat}, ${HOME.lng}) -> (${SCHOOL.lat}, ${SCHOOL.lng})`);
console.log(`[SIM] Reminder: a bus with gt06_device_imei='${IMEI}' (is_active=true) must exist in Supabase, and its school's lat/lng should match SCHOOL above for trip auto-detection to evaluate correctly.`);

const socket = net.createConnection(PORT, HOST, () => {
  console.log('[SIM] Connected. Sending login packet...');
  let serial = 1;
  socket.write(buildLoginPacket(IMEI, serial++));

  const startTime = Date.now();
  const course = bearingDegrees(HOME.lat, HOME.lng, SCHOOL.lat, SCHOOL.lng);
  const totalDistance = haversineMeters(HOME.lat, HOME.lng, SCHOOL.lat, SCHOOL.lng);
  console.log(`[SIM] Straight-line distance to school: ${totalDistance.toFixed(0)}m, bearing ${course.toFixed(0)}°`);

  const interval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    let position, speedKmh;

    if (elapsed < MOVE_DURATION_MS) {
      const t = elapsed / MOVE_DURATION_MS;
      position = { lat: lerp(HOME.lat, SCHOOL.lat, t), lng: lerp(HOME.lng, SCHOOL.lng, t) };
      speedKmh = 25; // steady cruise speed, above the 5km/h movement threshold
    } else if (elapsed < MOVE_DURATION_MS + STATIONARY_DURATION_MS) {
      position = SCHOOL;
      speedKmh = 0;
    } else {
      console.log('[SIM] Simulation complete (moved to school, then sat stationary). Closing connection.');
      clearInterval(interval);
      socket.end();
      return;
    }

    const packet = buildLocationPacket({ ...position, speedKmh, course }, serial++);
    socket.write(packet);
    console.log(`[SIM] Sent position: (${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}) @ ${speedKmh}km/h [t+${(elapsed / 1000).toFixed(0)}s]`);
  }, PING_INTERVAL_MS);

  socket.on('close', () => clearInterval(interval));
});

socket.on('data', (data) => {
  console.log(`[SIM] Received from server (likely an ACK): ${data.toString('hex')}`);
});

socket.on('error', (err) => {
  console.error('[SIM] Connection error:', err.message);
  console.error('[SIM] Is your server running (npm start) and listening on this host/port?');
});

socket.on('close', () => {
  console.log('[SIM] Connection closed.');
});

process.on('SIGINT', () => {
  console.log('\n[SIM] Interrupted — closing connection.');
  socket.end();
  process.exit(0);
});
