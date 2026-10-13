import { getQueue, JOBS } from '../queue/queue.js';
import { supabase } from '../db/supabaseClient.js';

// Firebase Admin is loaded lazily so the backend still runs (for GPS ingestion,
// trip state, etc.) even before you've added the service-account key. Push
// simply won't send until FIREBASE_SERVICE_ACCOUNT is configured.
let messaging = null;
let firebaseInitError = null;

async function getMessaging() {
  if (messaging) return messaging;
  if (firebaseInitError) return null;
  try {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      if (!raw) {
        firebaseInitError = 'FIREBASE_SERVICE_ACCOUNT not set';
        console.warn('[FCM] Firebase not configured — push notifications are disabled until you set FIREBASE_SERVICE_ACCOUNT.');
        return null;
      }
      // Accept either a path to the JSON file or the JSON string itself.
      let credentialJson;
      if (raw.trim().startsWith('{')) {
        credentialJson = JSON.parse(raw);
      } else {
        const fs = await import('node:fs');
        credentialJson = JSON.parse(fs.readFileSync(raw, 'utf8'));
      }
      admin.initializeApp({ credential: admin.credential.cert(credentialJson) });
    }
    messaging = admin.messaging();
    console.log('[FCM] Firebase Admin initialized — push notifications enabled.');
    return messaging;
  } catch (err) {
    firebaseInitError = err.message;
    console.error('[FCM] Firebase init failed:', err.message);
    return null;
  }
}

// Resolve who should receive a job, and their device tokens.
// job.audience: 'parents' | 'staff' | 'both' (defaults to parents).
// Staff = the drivers and conductors of the bus (or of the whole school).
async function tokensForNotification(job) {
  const audience = job.audience || 'parents';
  const wantsParents = audience !== 'staff';
  const wantsStaff = audience !== 'parents';
  const tokens = [];

  if (wantsParents) {
    let parentUserIds = [];

    if (job.parentUserIds?.length) {
      // Already resolved by the sender (ETA alerts group siblings per parent).
      parentUserIds = job.parentUserIds;
    } else if (job.studentId) {
      // Proximity alarm / student-specific: only that student's parents.
      const { data: links } = await supabase
        .from('parent_student_links')
        .select('parent_user_id')
        .eq('student_id', job.studentId);
      parentUserIds = (links || []).map((l) => l.parent_user_id);
    } else if (job.busId || job.schoolId) {
      // Bus-wide (or, with no bus, school-wide): every parent of the matching students.
      let q = supabase.from('students').select('id');
      q = job.busId ? q.eq('bus_id', job.busId) : q.eq('school_id', job.schoolId);
      const { data: students } = await q;
      const studentIds = (students || []).map((s) => s.id);
      if (studentIds.length > 0) {
        const { data: links } = await supabase
          .from('parent_student_links')
          .select('parent_user_id')
          .in('student_id', studentIds);
        parentUserIds = [...new Set((links || []).map((l) => l.parent_user_id))];
      }
    }

    if (parentUserIds.length > 0) {
      const { data } = await supabase
        .from('device_tokens')
        .select('fcm_token')
        .in('parent_user_id', parentUserIds);
      tokens.push(...(data || []).map((t) => t.fcm_token));
    }
  }

  if (wantsStaff && (job.busId || job.schoolId)) {
    let q = supabase.from('drivers').select('id').eq('is_active', true);
    q = job.busId ? q.eq('bus_id', job.busId) : q.eq('school_id', job.schoolId);
    const { data: staff } = await q;
    const staffIds = (staff || []).map((d) => d.id);
    if (staffIds.length > 0) {
      const { data } = await supabase
        .from('device_tokens')
        .select('fcm_token')
        .in('driver_id', staffIds);
      tokens.push(...(data || []).map((t) => t.fcm_token));
    }
  }

  return [...new Set(tokens.filter(Boolean))];
}

// Student-specific notifications (attendance, absent) must never fall through
// to the bus-wide branch — that would push one child's update to every parent
// on the bus.
function isStudentSpecific(job) {
  const kind = String(job.category || job.type || '').toUpperCase();
  return kind.includes('ATTENDANCE') || kind.includes('ABSENT');
}

async function handleDispatch(job) {
  if (isStudentSpecific(job) && !job.studentId && !job.parentUserIds?.length) {
    console.warn(`[FCM] Dropped ${job.type || job.category}: student-specific push with no studentId (would have gone to the whole bus).`);
    return;
  }
  const tokens = await tokensForNotification(job);
  if (tokens.length === 0) {
    console.log(`[FCM] No device tokens for job ${job.type} — nothing to send (parents may not have opened the app yet).`);
    return;
  }

  const fcm = await getMessaging();
  if (!fcm) return; // Firebase not configured yet.

  // For a proximity alarm we set an Android channel + high priority so the
  // phone rings even in the background; the Flutter app plays the alarm sound
  // on this channel.
  const isAlarm = job.type === 'PROXIMITY_ALARM';
  // How long FCM keeps trying if the phone is off or offline. A "bus is near"
  // alarm is useless after a couple of minutes, but incidents (absent, trip
  // ended, notices) should still arrive when the parent's phone comes back.
  const ttlSec = isAlarm ? 120 : 24 * 3600;
  const message = {
    tokens,
    notification: {
      title: job.title || 'Evide School Bus',
      body: job.body || '',
    },
    data: {
      type: job.type || 'GENERAL',
      // Copies of the title/body so a data-only push can still be shown.
      title: job.title || 'Evide School Bus',
      body: job.body || '',
      ...(job.studentId ? { studentId: String(job.studentId) } : {}),
      ...(job.studentIds ? { studentIds: job.studentIds.join(',') } : {}),
      ...(job.busId ? { busId: String(job.busId) } : {}),
    },
    android: {
      priority: 'high',
      ttl: ttlSec * 1000,
      notification: {
        channelId: isAlarm ? 'proximity_alarm_v2' : 'general',
        sound: isAlarm ? 'alarm' : 'default',
        // Wakes the screen and keeps the alert up until it's dealt with.
        priority: 'max',
        defaultVibrateTimings: false,
        vibrateTimingsMillis: [0, 500, 250, 500],
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSec),
      },
      payload: {
        aps: {
          sound: isAlarm ? 'alarm.caf' : 'default',
          // Breaks through Focus modes without needing Apple's Critical Alerts entitlement.
          'interruption-level': 'time-sensitive',
        },
      },
    },
  };

  try {
    const res = await fcm.sendEachForMulticast(message);
    console.log(`[FCM] Sent ${job.type}: ${res.successCount} ok, ${res.failureCount} failed`);
    // Clean up tokens FCM reports as permanently invalid; record any other
    // failure so the super admin panel can show it.
    if (res.failureCount > 0) {
      const stale = [];
      const failures = {};
      res.responses.forEach((r, i) => {
        if (r.success) return;
        const code = r.error?.code || 'unknown';
        if (code === 'messaging/registration-token-not-registered') {
          stale.push(tokens[i]);
        } else {
          failures[code] ||= { count: 0, message: r.error?.message };
          failures[code].count += 1;
        }
      });
      if (stale.length > 0) {
        await supabase.from('device_tokens').delete().in('fcm_token', stale);
        console.log(`[FCM] Removed ${stale.length} stale token(s)`);
      }
      for (const [code, f] of Object.entries(failures)) {
        await supabase.from('push_failures').insert({
          category: job.type || null,
          bus_id: job.busId || null,
          error_code: code,
          error_message: (f.message || '').slice(0, 300),
          failed_count: f.count,
        });
      }
    }
  } catch (err) {
    console.error('[FCM] send failed:', err.message);
    await supabase.from('push_failures').insert({
      category: job.type || null,
      bus_id: job.busId || null,
      error_code: 'send_failed',
      error_message: String(err.message || '').slice(0, 300),
      failed_count: 1,
    });
  }
}

// Starts the queue consumer for notification dispatch. Call once at startup.
export async function startNotificationWorker() {
  const queue = await getQueue();
  await queue.work(JOBS.DISPATCH_NOTIFICATION, async (job) => {
    // pg-boss v9 passes an array of jobs.
    const jobs = Array.isArray(job) ? job : [job];
    for (const j of jobs) {
      await handleDispatch(j.data);
    }
  });
  console.log('[FCM] Notification dispatch worker started.');
}
