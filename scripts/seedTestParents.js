// Seeds a TEST BUS (with a test driver login) in the same school as an
// existing student (default: "Student Test"), plus 10 test students and their
// parent logins on that bus — for testing notification privacy and timing.
//
//   node scripts/seedTestParents.js                      # create / top up
//   node scripts/seedTestParents.js --start 10.95,76.02  # start the route farther out
//   node scripts/seedTestParents.js --bus-name "TEST BUS 02"
//   node scripts/seedTestParents.js --student "Student Test"  # which school to use
//   node scripts/seedTestParents.js --bus <bus uuid>     # use an existing bus instead
//   node scripts/seedTestParents.js --clean              # remove everything this script made
//
// Stops are placed ON the road path from the start point to school, in order,
// so the generated route drives past each one and ETA alerts fire at realistic
// times. Siblings share one stop. By default the path starts at the anchor
// student's pickup point; use --start to make the route longer (a 20–40 min
// route is best for testing "arriving in ~10 min" alerts).
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and MAPBOX_ACCESS_TOKEN in .env
// (same as the backend).
// Safe to run twice: existing test students and logins are reused, not duplicated.

import 'dotenv/config';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { fetchRoadRoute } from '../src/routes/mapboxClient.js';
import { generateRouteForBus } from '../src/routes/routeGenerator.js';
import { decodePolyline, cumulative, pointAt, haversine } from './lib/polyline.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const CLEAN = args.includes('--clean');
const ANCHOR_NAME = arg('--student') || 'Student Test';
const BUS_OVERRIDE = arg('--bus');
const BUS_NAME = arg('--bus-name') || 'TEST BUS 01';
const TEST_IMEI = '999000000000001'; // fake GT06 IMEI for the simulator
const DRIVER = { name: 'Test Driver', phone: '9000000100' };
const driverEmail = (d) => `91${d}@driver.evide.in`; // same mapping as the driver app's login
const START = (() => {
  const v = arg('--start');
  if (!v) return null;
  const [lat, lng] = v.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('--start must be "lat,lng"');
  return { lat, lng };
})();
const ETA_ALERT_SECONDS = Number(process.env.ETA_ALERT_SECONDS || 600);
const DWELL_SECONDS = 45; // matches DEFAULTS.dwellSeconds in etaCalculator

const PASSWORD = 'Test@1234';
const ADMISSION_PREFIX = 'TEST-';
const EMAIL_DOMAIN = 'evide.test'; // hidden helper email; parents log in by phone

// 10 students, 9 parents. Parent 1 has two children (siblings).
const PLAN = [
  { parent: 1, phone: '9000000001', students: ['Test Aysha Nasrin', 'Test Adil Nasrin'] },
  { parent: 2, phone: '9000000002', students: ['Test Fathima Rinsha'] },
  { parent: 3, phone: '9000000003', students: ['Test Muhammed Shamil'] },
  { parent: 4, phone: '9000000004', students: ['Test Anagha Krishna'] },
  { parent: 5, phone: '9000000005', students: ['Test Hana Sherin'] },
  { parent: 6, phone: '9000000006', students: ['Test Arjun Das'] },
  { parent: 7, phone: '9000000007', students: ['Test Nihal Rahman'] },
  { parent: 8, phone: '9000000008', students: ['Test Diya Mariam'] },
  { parent: 9, phone: '9000000009', students: ['Test Sidharth Menon'] },
];

const fallbackEmail = (n) => `test.parent${String(n).padStart(2, '0')}@${EMAIL_DOMAIN}`;

// ---------- helpers ----------

async function findAuthUserByEmail(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function listTestAuthUsers() {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users.filter((u) =>
      u.email?.endsWith(`@${EMAIL_DOMAIN}`)
      || (u.user_metadata?.test_account === true && u.user_metadata?.role === 'parent')));
    if (data.users.length < 200) break;
  }
  return out;
}

// The parent-login Edge Function isn't in the repos, so copy how REAL
// phone-login parents are set up: if their login email is built from their
// number (e.g. 91XXXXXXXXXX@something), test accounts use the same pattern.
async function detectParentEmailPattern() {
  const { data } = await db
    .from('parent_users')
    .select('phone, auth_user_id')
    .not('phone', 'is', null)
    .not('auth_user_id', 'is', null)
    .not('phone', 'like', '%900000000%')
    .limit(15);
  for (const r of data || []) {
    const { data: au } = await db.auth.admin.getUserById(r.auth_user_id);
    const email = au?.user?.email;
    const d = String(r.phone).replace(/\D/g, '').slice(-10);
    const m = email?.match(/^(.*?)(\d{10})@(.+)$/);
    if (m && m[2] === d && /^\+?\d*$/.test(m[1])) {
      return (digits) => `${m[1]}${digits}@${m[3]}`;
    }
  }
  return null;
}

// Match the phone format already used in parent_users so the parent-login
// function finds these numbers the same way it finds real ones.
function phoneFormatter(samplePhone) {
  if (!samplePhone) return (d) => `+91${d}`;
  const s = String(samplePhone).trim();
  if (s.startsWith('+91')) return (d) => `+91${d}`;
  if (s.startsWith('91') && s.length === 12) return (d) => `91${d}`;
  if (/^\d{10}$/.test(s)) return (d) => d;
  return (d) => `+91${d}`;
}

// Builds the road path the bus will drive (start -> [anchor] -> school) and
// returns one point per test stop, evenly spaced along it by distance.
async function stopsAlongRoad({ start, anchorPoint, school, count, firstAtStart = false }) {
  const waypoints = [start];
  if (anchorPoint && haversine(start, anchorPoint) > 50) waypoints.push(anchorPoint);
  waypoints.push(school);

  const { polyline, distanceMeters, durationSeconds } = await fetchRoadRoute(waypoints);
  const path = decodePolyline(polyline);
  const cum = cumulative(path);
  const total = cum[cum.length - 1];

  // Keep clear of the school gate, and of the anchor student's stop if they
  // ride this bus.
  const from = firstAtStart ? 0 : total * 0.08;
  const to = total * 0.92;
  const points = [];
  for (let i = 0; i < count; i++) {
    const m = count === 1 ? (from + to) / 2 : from + ((to - from) * i) / (count - 1);
    const p = pointAt(path, cum, m);
    points.push({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
  }
  return { points, distanceMeters, durationSeconds, spacing: (to - from) / Math.max(1, count - 1) };
}

const fmtMin = (sec) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

async function ensureTestBus(schoolId) {
  const { data: existing } = await db
    .from('buses')
    .select('id')
    .eq('school_id', schoolId)
    .eq('bus_number', BUS_NAME)
    .maybeSingle();
  if (existing) {
    console.log(`Using existing test bus "${BUS_NAME}"`);
    return existing.id;
  }
  // The IMEI is unique across all buses; bump it if another test bus has it.
  let imei = TEST_IMEI;
  for (let n = 1; n < 100; n++) {
    const { data: taken } = await db.from('buses').select('id').eq('gt06_device_imei', imei).maybeSingle();
    if (!taken) break;
    imei = `999000000000${String(n + 1).padStart(3, '0')}`;
  }
  const { data, error } = await db
    .from('buses')
    .insert({ school_id: schoolId, bus_number: BUS_NAME, gt06_device_imei: imei, seat_capacity: 40, status: 'not_running', is_active: true })
    .select('id')
    .single();
  if (error) throw new Error(`Creating bus: ${error.message}`);
  console.log(`Created test bus "${BUS_NAME}" (IMEI ${imei})`);
  return data.id;
}

async function ensureTestDriver(schoolId, busId) {
  const email = driverEmail(DRIVER.phone);
  let user = await findAuthUserByEmail(email);
  if (!user) {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { test_account: true, role: 'driver' },
    });
    if (error) throw new Error(`Driver login: ${error.message}`);
    user = data.user;
  } else {
    await db.auth.admin.updateUserById(user.id, { password: PASSWORD });
  }

  const { data: row } = await db.from('drivers').select('id').eq('auth_user_id', user.id).maybeSingle();
  if (row) {
    await db.from('drivers').update({ bus_id: busId, school_id: schoolId }).eq('id', row.id);
  } else {
    const { error } = await db.from('drivers').insert({
      school_id: schoolId,
      bus_id: busId,
      name: DRIVER.name,
      phone: `+91${DRIVER.phone}`,
      role: 'driver',
      auth_user_id: user.id,
    });
    if (error) throw new Error(`drivers row: ${error.message}`);
  }
}

// ---------- clean ----------

async function clean() {
  const { data: students } = await db
    .from('students')
    .select('id')
    .like('admission_number', `${ADMISSION_PREFIX}%`);
  const studentIds = (students || []).map((s) => s.id);

  const authUsers = await listTestAuthUsers();
  const authIds = authUsers.map((u) => u.id);

  if (authIds.length) {
    const { data: parents } = await db.from('parent_users').select('id').in('auth_user_id', authIds);
    const parentIds = (parents || []).map((p) => p.id);
    if (parentIds.length) {
      await db.from('device_tokens').delete().in('parent_user_id', parentIds);
      await db.from('parent_users').delete().in('id', parentIds); // links cascade
    }
  }
  if (studentIds.length) {
    await db.from('notifications').delete().in('student_id', studentIds);
    await db.from('attendance').delete().in('student_id', studentIds);
    await db.from('students').delete().in('id', studentIds);
  }
  for (const u of authUsers) await db.auth.admin.deleteUser(u.id);

  // Test driver.
  const driverUser = await findAuthUserByEmail(driverEmail(DRIVER.phone));
  if (driverUser) {
    await db.from('device_tokens').delete().in(
      'driver_id',
      ((await db.from('drivers').select('id').eq('auth_user_id', driverUser.id)).data || []).map((d) => d.id),
    );
    await db.from('drivers').delete().eq('auth_user_id', driverUser.id);
    await db.auth.admin.deleteUser(driverUser.id);
  }

  // Test bus (only ones this script names; never touches real buses).
  const { data: buses } = await db.from('buses').select('id, bus_number').like('bus_number', 'TEST BUS%');
  for (const b of buses || []) {
    const { count } = await db.from('students').select('id', { count: 'exact', head: true }).eq('bus_id', b.id);
    if (count) {
      console.log(`Kept "${b.bus_number}": ${count} non-test student(s) still assigned.`);
      continue;
    }
    await db.from('notifications').delete().eq('bus_id', b.id);
    await db.from('attendance').delete().eq('bus_id', b.id);
    await db.from('drivers').update({ bus_id: null }).eq('bus_id', b.id);
    const { error } = await db.from('buses').delete().eq('id', b.id);
    console.log(error ? `Could not delete "${b.bus_number}": ${error.message}` : `Deleted bus "${b.bus_number}".`);
  }

  console.log(`Removed ${studentIds.length} test students and ${authUsers.length} test logins.`);
}

// ---------- seed ----------

async function seed() {
  // 1. School (from the anchor student) and the bus to seed onto.
  let schoolId, busId, anchorPoint = null, onAnchorBus = false;
  if (BUS_OVERRIDE) {
    const { data: bus, error } = await db.from('buses').select('id, school_id').eq('id', BUS_OVERRIDE).single();
    if (error || !bus) throw new Error(`Bus ${BUS_OVERRIDE} not found.`);
    schoolId = bus.school_id;
    busId = bus.id;
  } else {
    const { data: anchors, error } = await db
      .from('students')
      .select('id, school_id, bus_id, pickup_lat, pickup_lng')
      .ilike('full_name', ANCHOR_NAME)
      .limit(2);
    if (error) throw error;
    if (!anchors?.length) throw new Error(`No student named "${ANCHOR_NAME}". Use --student "<name>" or --bus <uuid>.`);
    if (anchors.length > 1) throw new Error(`More than one "${ANCHOR_NAME}". Use --bus <uuid> instead.`);
    const a = anchors[0];
    schoolId = a.school_id;
    if (a.pickup_lat != null) anchorPoint = { lat: a.pickup_lat, lng: a.pickup_lng };
    busId = await ensureTestBus(schoolId);
    onAnchorBus = a.bus_id === busId;
  }

  // Test driver for this bus (to tap Start / mark attendance in the driver app).
  await ensureTestDriver(schoolId, busId);

  const { data: school } = await db.from('schools').select('name, latitude, longitude').eq('id', schoolId).single();
  const { data: bus } = await db.from('buses').select('bus_number').eq('id', busId).single();
  if (school?.latitude == null) throw new Error('School has no latitude/longitude set — needed to build the route.');
  const schoolPoint = { lat: school.latitude, lng: school.longitude };
  const start = START || anchorPoint;
  if (!start) throw new Error(`"${ANCHOR_NAME}" has no pickup location. Pass --start "lat,lng".`);
  console.log(`School: ${school?.name}  |  Bus: ${bus?.bus_number}`);

  // One stop per parent (siblings share a stop), placed along the road.
  const road = await stopsAlongRoad({
    start,
    anchorPoint: onAnchorBus ? anchorPoint : null,
    school: schoolPoint,
    count: PLAN.length,
    firstAtStart: !onAnchorBus, // new bus: first test stop IS the start point
  });
  console.log(`Road path to school: ${(road.distanceMeters / 1000).toFixed(1)} km, ~${Math.round(road.durationSeconds / 60)} min driving, stops ~${Math.round(road.spacing)} m apart\n`);
  if (road.durationSeconds < 20 * 60) {
    console.warn(`⚠  Route is only ~${Math.round(road.durationSeconds / 60)} min. With a ${ETA_ALERT_SECONDS / 60}-min alert, most parents will be alerted as soon as the trip starts.`);
    console.warn('   Pass --start "lat,lng" with a point farther from school (aim for 20–40 min) for a better timing test.\n');
  }

  // 2. Phone format used by existing parents.
  // parent-login matches parent_users.phone exactly as "+91XXXXXXXXXX".
  const fmt = (d) => `+91${d}`;
  const pattern = await detectParentEmailPattern();
  console.log(pattern
    ? `Parent logins will use the same format as real parents (e.g. ${pattern('XXXXXXXXXX')})`
    : 'No phone-based login format found on real parents; using test.parentNN@evide.test');

  const results = [];
  let studentIndex = 0;

  for (const [planIndex, p] of PLAN.entries()) {
    const spot = road.points[planIndex];
    const phone = fmt(p.phone);
    const email = pattern ? pattern(p.phone) : fallbackEmail(p.parent);

    // 3. Auth user: phone + password. Reuse the account already linked to
    //    this number (from an earlier run) and bring its email in line.
    let user = null;
    // Find the row from an earlier run whatever format it was saved in, and
    // put it back into the "+91XXXXXXXXXX" format parent-login expects.
    const { data: oldRows } = await db
      .from('parent_users')
      .select('id, phone, auth_user_id')
      .in('phone', [p.phone, `91${p.phone}`, `+91${p.phone}`, `+91 ${p.phone}`, `0${p.phone}`]);
    const existingParent = oldRows?.[0] || null;
    if (existingParent && existingParent.phone !== phone) {
      await db.from('parent_users').update({ phone }).eq('id', existingParent.id);
    }
    if (existingParent?.auth_user_id) {
      const { data: au } = await db.auth.admin.getUserById(existingParent.auth_user_id);
      user = au?.user || null;
    }
    if (!user) user = (await findAuthUserByEmail(email)) || (await findAuthUserByEmail(fallbackEmail(p.parent)));
    if (user) {
      const { error } = await db.auth.admin.updateUserById(user.id, {
        email,
        email_confirm: true,
        phone: `91${p.phone}`,
        phone_confirm: true,
        password: PASSWORD,
        user_metadata: { ...(user.user_metadata || {}), test_account: true, role: 'parent' },
        ban_duration: 'none',
      });
      if (error) throw new Error(`Updating login for ${phone}: ${error.message}`);
    } else {
      const { data, error } = await db.auth.admin.createUser({
        email,
        phone: `91${p.phone}`,
        password: PASSWORD,
        email_confirm: true,
        phone_confirm: true,
        user_metadata: { test_account: true, role: 'parent' },
      });
      if (error) throw new Error(`Auth user for ${phone}: ${error.message}`);
      user = data.user;
    }

    // 4. parent_users row.
    let { data: parentRow } = await db.from('parent_users').select('id').eq('auth_user_id', user.id).maybeSingle();
    if (!parentRow) {
      const { data, error } = await db
        .from('parent_users')
        .insert({ auth_user_id: user.id, phone })
        .select('id')
        .single();
      if (error) throw new Error(`parent_users for ${phone}: ${error.message}`);
      parentRow = data;
    }

    // 5. Students + links.
    const names = [];
    for (const fullName of p.students) {
      studentIndex++;
      const admission = `${ADMISSION_PREFIX}${String(studentIndex).padStart(3, '0')}`;

      const { data: student, error } = await db
        .from('students')
        .upsert(
          {
            school_id: schoolId,
            bus_id: busId,
            admission_number: admission,
            full_name: fullName,
            pickup_lat: spot.lat,
            pickup_lng: spot.lng,
            drop_lat: spot.lat,
            drop_lng: spot.lng,
          },
          { onConflict: 'school_id,admission_number' },
        )
        .select('id')
        .single();
      if (error) throw new Error(`Student ${fullName}: ${error.message}`);

      const { error: linkErr } = await db
        .from('parent_student_links')
        .upsert({ parent_user_id: parentRow.id, student_id: student.id }, { onConflict: 'parent_user_id,student_id' });
      if (linkErr) throw new Error(`Link for ${fullName}: ${linkErr.message}`);

      names.push(`${fullName} (${admission})`);
    }

    results.push({ phone: p.phone, password: PASSWORD, children: names.join(' + '), lat: spot.lat, lng: spot.lng });
  }

  // 6. Regenerate both routes so the new stops are in order with road timings.
  console.log('Regenerating pickup and drop routes...');
  for (const type of ['pickup', 'drop']) {
    const r = await generateRouteForBus(busId, type);
    console.log(`  ${type}: ${r.stopCount} stops, ${(r.distanceMeters / 1000).toFixed(1)} km, ~${Math.round(r.durationSeconds / 60)} min`);
  }

  // 7. Expected timeline for the pickup trip, measured from the first stop.
  const { data: route } = await db
    .from('routes')
    .select('stop_sequence')
    .eq('bus_id', busId)
    .eq('route_type', 'pickup')
    .single();

  const byStudent = new Map();
  const { data: names } = await db.from('students').select('id, full_name').eq('bus_id', busId);
  for (const n of names || []) byStudent.set(n.id, n.full_name);
  const phoneByName = new Map();
  for (const r of results) for (const c of r.children.split(' + ')) phoneByName.set(c.replace(/ \(.*\)$/, ''), r.phone);

  const timeline = [];
  let t = 0;
  for (const [i, stop] of (route?.stop_sequence || []).entries()) {
    if (i > 0) t += (stop.baseline_leg_seconds ?? 0) + DWELL_SECONDS;
    const ids = stop.student_ids?.length ? stop.student_ids : stop.student_id ? [stop.student_id] : [];
    if (!ids.length) {
      timeline.push({ stop: i, who: 'SCHOOL', arrives: fmtMin(t), alert: '—', phone: '' });
      continue;
    }
    const who = ids.map((id) => byStudent.get(id) || id).join(' + ');
    timeline.push({
      stop: i,
      who,
      arrives: fmtMin(t),
      alert: t <= ETA_ALERT_SECONDS ? 'at trip start' : fmtMin(t - ETA_ALERT_SECONDS),
      phone: phoneByName.get(who.split(' + ')[0]) || '(existing parent)',
    });
  }

  console.log(`\nBus: ${bus?.bus_number}   Driver app login: ${DRIVER.phone} / ${PASSWORD}`);
  console.log('\nParent logins:');
  console.table(results.map(({ phone, password, children }) => ({ phone, password, children })));
  console.log(`\nExpected pickup timeline (from when the bus leaves stop 0; alert = "arriving in ~${ETA_ALERT_SECONDS / 60} min"):`);
  console.table(timeline);

  const csv = [
    'phone,password,children,pickup_lat,pickup_lng',
    ...results.map((r) => `${r.phone},${r.password},"${r.children}",${r.lat},${r.lng}`),
  ].join('\n');
  fs.writeFileSync('test-parent-logins.csv', csv);
  console.log('\nSaved logins to test-parent-logins.csv');
  console.log('Next: node scripts/simulateRoute.js to drive the bus along this route.');
}

(CLEAN ? clean() : seed()).catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});