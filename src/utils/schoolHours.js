import { supabase } from '../db/supabaseClient.js';

const TZ = 'Asia/Kolkata';
const TTL_MS = 60 * 1000;

const DEFAULTS = {
  attendance_enabled: true,
  morning_start: '06:00',
  morning_end: '10:30',
  evening_start: '14:00',
  evening_end: '18:30',
};

const cache = new Map(); // busId -> { at, value }

export function serviceDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function minutesOfDay(d = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).split(':').map(Number);
  return h * 60 + m;
}

function toMinutes(t, fallback) {
  const [h, m] = String(t || fallback).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Loads (cached 60 s) the settings of the school a bus belongs to. */
export async function getSchoolSettings(busId) {
  const hit = cache.get(busId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = { ...DEFAULTS, school_id: null, latitude: null, longitude: null };
  const { data: bus } = await supabase.from('buses').select('school_id').eq('id', busId).maybeSingle();
  if (bus?.school_id) {
    const { data: school, error } = await supabase
      .from('schools')
      .select('id, latitude, longitude, attendance_enabled, morning_start, morning_end, evening_start, evening_end')
      .eq('id', bus.school_id)
      .maybeSingle();
    if (error) {
      // Columns missing (migration_009 not run yet): fall back to defaults.
      console.error('[hours] school settings load failed:', error.message);
      const { data: basic } = await supabase.from('schools').select('id, latitude, longitude').eq('id', bus.school_id).maybeSingle();
      value = { ...value, school_id: bus.school_id, latitude: basic?.latitude ?? null, longitude: basic?.longitude ?? null };
    } else if (school) {
      value = {
        school_id: school.id,
        latitude: school.latitude,
        longitude: school.longitude,
        attendance_enabled: school.attendance_enabled ?? true,
        morning_start: school.morning_start || DEFAULTS.morning_start,
        morning_end: school.morning_end || DEFAULTS.morning_end,
        evening_start: school.evening_start || DEFAULTS.evening_start,
        evening_end: school.evening_end || DEFAULTS.evening_end,
      };
    }
  }
  cache.set(busId, { at: Date.now(), value });
  return value;
}

/**
 * 'pickup' inside the morning window, 'drop' inside the evening window,
 * null outside school hours (no notifications are sent then).
 */
export function activeWindow(settings, now = new Date()) {
  const m = minutesOfDay(now);
  if (m >= toMinutes(settings.morning_start, DEFAULTS.morning_start) && m <= toMinutes(settings.morning_end, DEFAULTS.morning_end)) return 'pickup';
  if (m >= toMinutes(settings.evening_start, DEFAULTS.evening_start) && m <= toMinutes(settings.evening_end, DEFAULTS.evening_end)) return 'drop';
  return null;
}

export async function currentWindowForBus(busId, now = new Date()) {
  return activeWindow(await getSchoolSettings(busId), now);
}

export function invalidateSchoolSettings(busId) {
  if (busId) cache.delete(busId); else cache.clear();
}
