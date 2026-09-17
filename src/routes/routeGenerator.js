import { supabase } from '../db/supabaseClient.js';
import { nearestNeighborOrder } from './stopOrdering.js';
import { fetchRoadRoute } from './mapboxClient.js';

/**
 * Builds the ordered waypoint sequence for a route, without touching the
 * network or the database — kept separate from generateRouteForBus so the
 * sequencing logic itself can be tested without a Mapbox token or Supabase.
 *
 * Pickup: bus starts far from school, ends at school (so a driver naturally
 * finishes the run by arriving at school). We get this by nearest-neighbor
 * ordering *from* the school outward, then reversing it — farthest stop
 * first, school last.
 *
 * Drop: bus starts at school, works outward — nearest-neighbor ordering
 * from the school is used directly, school first.
 */
export function buildWaypointSequence(school, students, routeType) {
  if (students.length === 0) {
    throw new Error('No students with coordinates assigned to this bus/route type');
  }

  const points = students.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng }));
  const orderedFromSchool = nearestNeighborOrder({ lat: school.lat, lng: school.lng }, points);

  const schoolWaypoint = { id: 'SCHOOL', lat: school.lat, lng: school.lng };

  if (routeType === 'pickup') {
    return [...orderedFromSchool].reverse().concat(schoolWaypoint);
  }
  // drop
  return [schoolWaypoint, ...orderedFromSchool];
}

/**
 * Full pipeline: load the bus's students and school, build the waypoint
 * order, call Mapbox for the road-snapped path, and store the result.
 *
 * @param {string} busId
 * @param {'pickup'|'drop'} routeType
 */
export async function generateRouteForBus(busId, routeType) {
  const { data: bus, error: busError } = await supabase
    .from('buses')
    .select('id, school_id')
    .eq('id', busId)
    .maybeSingle();
  if (busError) throw new Error(`Failed to load bus: ${busError.message}`);
  if (!bus) throw new Error(`Bus ${busId} not found`);

  const { data: school, error: schoolError } = await supabase
    .from('schools')
    .select('latitude, longitude')
    .eq('id', bus.school_id)
    .maybeSingle();
  if (schoolError) throw new Error(`Failed to load school: ${schoolError.message}`);
  if (!school || school.latitude == null || school.longitude == null) {
    throw new Error('School coordinates are not set — required to generate a route');
  }

  const coordField = routeType === 'pickup'
    ? ['pickup_lat', 'pickup_lng']
    : ['drop_lat', 'drop_lng'];

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select(`id, ${coordField[0]}, ${coordField[1]}`)
    .eq('bus_id', busId)
    .not(coordField[0], 'is', null)
    .not(coordField[1], 'is', null);
  if (studentsError) throw new Error(`Failed to load students: ${studentsError.message}`);

  const points = (students || []).map((s) => ({
    id: s.id,
    lat: s[coordField[0]],
    lng: s[coordField[1]],
  }));

  const waypoints = buildWaypointSequence(
    { lat: school.latitude, lng: school.longitude },
    points,
    routeType
  );

  const { polyline, distanceMeters, durationSeconds } = await fetchRoadRoute(
    waypoints.map((w) => ({ lat: w.lat, lng: w.lng }))
  );

  const stopSequence = waypoints.map((w, index) => ({
    sequence: index,
    student_id: w.id === 'SCHOOL' ? null : w.id,
    lat: w.lat,
    lng: w.lng,
  }));

  const { error: upsertError } = await supabase.from('routes').upsert(
    {
      bus_id: busId,
      route_type: routeType,
      stop_sequence: stopSequence,
      polyline,
      distance_meters: distanceMeters,
      duration_seconds: durationSeconds,
      generated_at: new Date().toISOString(),
    },
    { onConflict: 'bus_id,route_type' }
  );
  if (upsertError) throw new Error(`Failed to save route: ${upsertError.message}`);

  return { busId, routeType, stopCount: points.length, distanceMeters, durationSeconds };
}
