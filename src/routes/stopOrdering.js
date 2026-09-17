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
