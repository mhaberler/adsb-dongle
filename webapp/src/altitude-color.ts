export interface AltitudeStop {
  alt: number;
  r: number;
  g: number;
  b: number;
}

const ALTITUDE_STOPS: readonly AltitudeStop[] = [
  { alt: 0, r: 255, g: 0, b: 0 },       // Red (Ground/Sea Level)
  { alt: 1000, r: 255, g: 128, b: 0 },   // Orange
  { alt: 2500, r: 255, g: 255, b: 0 },   // Yellow
  { alt: 5000, r: 0, g: 255, b: 0 },     // Green
  { alt: 10000, r: 0, g: 255, b: 255 },  // Cyan
  { alt: 20000, r: 0, g: 128, b: 255 },  // Light Blue
  { alt: 30000, r: 0, g: 0, b: 255 },    // Dark Blue
  { alt: 40000, r: 128, g: 0, b: 255 },  // Purple
  { alt: 50000, r: 255, g: 0, b: 255 },  // Magenta
  { alt: 60000, r: 255, g: 200, b: 200 } // Light Pink
] as const;

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Maps an altitude in feet to its corresponding ADSBexchange hex color string.
 * @param alt - Altitude in feet (can be null or undefined for unknown values).
 */
export function getAdsbColor(alt: number | null | undefined): string {
  if (alt === null || alt === undefined || Number.isNaN(alt)) {
    return '#7f7f7f'; // Gray for unknown/ground signal missing
  }

  if (alt <= 0) {
    return rgbToHex(ALTITUDE_STOPS[0].r, ALTITUDE_STOPS[0].g, ALTITUDE_STOPS[0].b);
  }

  const maxStop = ALTITUDE_STOPS[ALTITUDE_STOPS.length - 1];
  if (alt >= maxStop.alt) {
    return rgbToHex(maxStop.r, maxStop.g, maxStop.b);
  }

  let lower = ALTITUDE_STOPS[0];
  let upper = maxStop;

  for (let i = 0; i < ALTITUDE_STOPS.length - 1; i++) {
    if (alt >= ALTITUDE_STOPS[i].alt && alt < ALTITUDE_STOPS[i + 1].alt) {
      lower = ALTITUDE_STOPS[i];
      upper = ALTITUDE_STOPS[i + 1];
      break;
    }
  }

  const factor = (alt - lower.alt) / (upper.alt - lower.alt);

  const r = Math.round(lower.r + factor * (upper.r - lower.r));
  const g = Math.round(lower.g + factor * (upper.g - lower.g));
  const b = Math.round(lower.b + factor * (upper.b - lower.b));

  return rgbToHex(r, g, b);
}