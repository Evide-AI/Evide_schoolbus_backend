const MAPBOX_DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

/**
 * Calls the Mapbox Directions API for a road-snapped route through an
 * ordered list of coordinates. Returns the encoded polyline plus total
 * distance/duration, or throws if Mapbox can't find a route (e.g. a point
 * that's unreachable by road, or too many waypoints).
 *
 * NOTE: this makes a real network call — untested in this environment
 * (no network access to api.mapbox.com from where this was built). Verify
 * against your real MAPBOX_ACCESS_TOKEN before relying on it; the request/
 * response shape here follows Mapbox's documented Directions API v5.
 *
 * @param {Array<{lat:number, lng:number}>} orderedPoints - in visit order
 * @returns {Promise<{polyline: string, distanceMeters: number, durationSeconds: number, legDurations: number[]}>}
 *   legDurations[i] = driving seconds from point i to point i+1 (used as the
 *   starting ETA for each stop before real trip times are learned).
 */
export async function fetchRoadRoute(orderedPoints) {
  if (!process.env.MAPBOX_ACCESS_TOKEN) {
    throw new Error('MAPBOX_ACCESS_TOKEN is not set in the environment');
  }
  if (orderedPoints.length < 2) {
    throw new Error('Need at least 2 points to generate a route');
  }
  if (orderedPoints.length > 25) {
    // Mapbox's driving profile caps at 25 waypoints per request.
    throw new Error(`Too many stops for a single Directions request (${orderedPoints.length} incl. school, max 25). Students within 50m are already grouped into one stop — split this bus's students across trips or buses.`);
  }

  const coordsParam = orderedPoints.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${MAPBOX_DIRECTIONS_URL}/${coordsParam}?geometries=polyline&overview=full&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`;

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mapbox Directions API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  if (!data.routes || data.routes.length === 0) {
    throw new Error('Mapbox could not find a route through the given stops');
  }

  const route = data.routes[0];
  return {
    polyline: route.geometry,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    legDurations: (route.legs || []).map((leg) => leg.duration),
  };
}
