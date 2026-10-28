// Great-circle helpers on a spherical earth (R = 6371 km) — accurate to
// well under 0.5% at ADS-B ranges, plenty for range rings, distances and
// dead reckoning.

const R_KM = 6371;
const RAD = Math.PI / 180;

// Same shape as Leaflet's LatLngTuple (optional altitude ignored).
export type LatLon = readonly [lat: number, lon: number, alt?: number];

// Point reached from [lat, lon] after km along the initial bearing deg
// (true north, clockwise).
export function destPoint(
  [lat, lon]: LatLon,
  deg: number,
  km: number,
): [number, number] {
  const d = km / R_KM;
  const b = deg * RAD;
  const la = lat * RAD;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lon * RAD +
    Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / RAD, ((lo2 / RAD + 540) % 360) - 180];
}

// Haversine distance in km.
export function distanceKm(
  [lat1, lon1]: LatLon,
  [lat2, lon2]: LatLon,
): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
