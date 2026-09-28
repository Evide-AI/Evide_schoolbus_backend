import { getDistanceToNextStopInMeters } from '../utils/geoUtils.js';

/**
 * Greedy nearest-neighbor ordering: starting from `origin`, repeatedly picks
 * the closest remaining point. This is a heuristic, not a true shortest-path
 * solve (that's what Mapbox's paid Optimization API would give you) — good
 * enough for a bus route that already follows a natural geographic corridor,
 * but worth a manual sanity check on the map for routes with an unusual
 * stop layout (e.g. stops on both sides of a river with only one bridge).
 *
 * @param {{lat:number, lng:number}} origin
 * @param {Array<{id:string, lat:number, lng:number}>} points
 * @returns {Array<{id:string, lat:number, lng:number}>} points reordered by nearest-neighbor from origin
 */
export function nearestNeighborOrder(origin, points) {
  const remaining = [...points];
  const ordered = [];
  let current = { lat: origin.lat, lng: origin.lng };

  while (remaining.length > 0) {
    let closestIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const d = getDistanceToNextStopInMeters(
        { lat: current.lat, lon: current.lng },
        { lat: remaining[i].lat, lon: remaining[i].lng }
      );
      if (d !== null && d < closestDistance) {
        closestDistance = d;
        closestIndex = i;
      }
    }

    const next = remaining.splice(closestIndex, 1)[0];
    ordered.push(next);
    current = { lat: next.lat, lng: next.lng };
  }

  return ordered;
}

// Students whose points are within this distance share one stop (siblings,
// same apartment, same junction). Fewer stops = cleaner ETAs and stays under
// Mapbox's 25-waypoint limit.
const STOP_GROUP_RADIUS_METERS = 50;

/**
 * Groups students into stops. Greedy: each student joins the first existing
 * stop within STOP_GROUP_RADIUS_METERS of that stop's first student, else
 * starts a new stop. Returns [{ id, ids, lat, lng }].
 */
export function groupIntoStops(points) {
  const stops = [];
  for (const p of points) {
    const near = stops.find((s) => {
      const d = getDistanceToNextStopInMeters({ lat: s.lat, lon: s.lng }, { lat: p.lat, lon: p.lng });
      return d != null && d <= STOP_GROUP_RADIUS_METERS;
    });
    if (near) near.ids.push(p.id);
    else stops.push({ id: p.id, ids: [p.id], lat: p.lat, lng: p.lng });
  }
  return stops;
}
