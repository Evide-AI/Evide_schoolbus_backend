/**
 * Calculates the great-circle distance between two points
 * on the Earth (specified in decimal degrees) using the Haversine formula.
 * @param {object} loc1 - First location { lat: number, lon: number }
 * @param {object} loc2 - Second location { lat: number, lon: number }
 * @returns {number} Distance in meters.
 */
function getDistanceToNextStopInMeters(loc1, loc2) {
  if (
    !loc1 ||
    !loc2 ||
    loc1.lat == null ||
    loc1.lon == null ||
    loc2.lat == null ||
    loc2.lon == null
  ) {
    return null; // Return null if coordinates are invalid or missing
  }

  const R = 6371e3; // Earth's radius in meters
  const phi1 = (loc1.lat * Math.PI) / 180; // φ, λ in radians
  const phi2 = (loc2.lat * Math.PI) / 180;
  const deltaPhi = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const deltaLambda = ((loc2.lon - loc1.lon) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const distance = R * c; // in meters
  return distance;
}

/**
 * Estimates the time of arrival in minutes.
 * @param {object} currentBusLocation - { lat: number, lon: number }
 * @param {object} nextStopLocation - { lat: number, lon: number }
 * @param {number} speedKmh - Current speed in kilometers per hour.
 * @returns {number | null} Estimated time in minutes, or null if speed is 0 or distance can't be calculated.
 */
function getEtaInMinutes(currentBusLocation, nextStopLocation, speedKmh) {
  const distanceMeters = getDistanceToNextStopInMeters(
    currentBusLocation,
    nextStopLocation,
  );

  // Can't calculate ETA if distance is unknown or speed is zero or negative
  if (distanceMeters === null || speedKmh == null || speedKmh <= 0) {
    return null;
  }

  // Convert speed from km/h to m/minute
  // (speedKmh * 1000 meters/km) / 60 minutes/hour
  const speedMetersPerMinute = (speedKmh * 1000) / 60;

  // Calculate time = distance / speed
  const timeMinutes = distanceMeters / speedMetersPerMinute;

  // Round to the nearest minute for simplicity
  return Math.round(timeMinutes);
}

// Average human walking speed is ~5 km/h
const AVG_WALKING_SPEED_METERS_PER_MINUTE = (5 * 1000) / 60;

/**
 * Calculates the estimated walking time in minutes based on distance.
 * @param {number} distanceMeters - The distance in meters.
 * @returns {number} The estimated walking time in minutes.
 */
function getWalkTimeInMinutes(distanceMeters) {
  if (distanceMeters === null || distanceMeters < 0) {
    return null;
  }

  // Handle 0 distance
  if (distanceMeters === 0) {
    return 0;
  }

  const timeMinutes = distanceMeters / AVG_WALKING_SPEED_METERS_PER_MINUTE;

  return timeMinutes;
}

export { getEtaInMinutes, getDistanceToNextStopInMeters, getWalkTimeInMinutes };
