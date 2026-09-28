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

// Resolve which parents should receive a notification, and their device tokens.
async function tokensForNotification(job) {
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
  } else if (job.busId) {
    // Bus-wide notification: all parents of students on this bus.
    const { data: students } = await supabase
      .from('students')
      .select('id')
      .eq('bus_id', job.busId);
    const studentIds = (students || []).map((s) => s.id);
    if (studentIds.length > 0) {
      const { data: links } = await supabase
        .from('parent_student_links')
        .select('parent_user_id')
        .in('student_id', studentIds);
      parentUserIds = [...new Set((links || []).map((l) => l.parent_user_id))];
    }
  }

  if (parentUserIds.length === 0) return [];
  const { data: tokens } = await supabase
    .from('device_tokens')
    .select('fcm_token')
    .in('parent_user_id', parentUserIds);
  return [...new Set((tokens || []).map((t) => t.fcm_token))];
}

async function handleDispatch(job) {
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
      payload: {
        aps: { sound: isAlarm ? 'alarm.caf' : 'default' },
      },
    },
  };

  try {
    const res = await fcm.sendEachForMulticast(message);
    console.log(`[FCM] Sent ${job.type}: ${res.successCount} ok, ${res.failureCount} failed`);
    // Clean up tokens FCM reports as permanently invalid.
    if (res.failureCount > 0) {
      const stale = [];
      res.responses.forEach((r, i) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          stale.push(tokens[i]);
        }
      });
      if (stale.length > 0) {
        await supabase.from('device_tokens').delete().in('fcm_token', stale);
        console.log(`[FCM] Removed ${stale.length} stale token(s)`);
      }
    }
  } catch (err) {
    console.error('[FCM] send failed:', err.message);
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
