// Mapbox/Google encoded polyline helpers (precision 5, the Mapbox default for
// geometries=polyline, which is what routeGenerator stores).

export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of ['lat', 'lng']) {
      let result = 0, shift = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 'lat') lat += delta; else lng += delta;
    }
    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative distance (m) at each vertex. */
export function cumulative(points) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + haversine(points[i - 1], points[i]));
  return out;
}

/** The point `meters` along the path (clamped to the ends). */
export function pointAt(points, cum, meters) {
  if (meters <= 0) return { ...points[0] };
  const total = cum[cum.length - 1];
  if (meters >= total) return { ...points[points.length - 1] };
  let i = 1;
  while (cum[i] < meters) i++;
  const t = (meters - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return {
    lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
    lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * t,
  };
}
