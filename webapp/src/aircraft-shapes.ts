// Marker symbols per emitter category (the "A3"-style category the
// aircraft itself broadcasts, see protocol.ts). Drawn nose-up (north) in a
// -12..12 viewBox and rotated with the track, except `fixed` ones.
// Narrow shapes get a thinner outline so their fill doesn't disappear.

export type Shape =
  | "arrow"
  | "jet"
  | "heavy"
  | "light"
  | "glider"
  | "heli"
  | "balloon"
  | "drone"
  | "ground";

interface ShapeDef {
  size: number; // px
  svg: string;
  fixed?: boolean; // not rotated with the track
}

const JET = '<path d="M0-11 2-3 10 2v2L2 1l-.5 6L4 9v1.5L0 9.5-4 10.5V9l2.5-2L-2 1l-8 3V2l8-5z"/>';

export const SHAPES: Record<Shape, ShapeDef> = {
  // no or unhelpful category: the generic arrow the map always had
  arrow: { size: 24, svg: '<path d="M0-11 5 2 0-1-5 2z"/>' },
  jet: { size: 24, svg: JET },
  heavy: { size: 30, svg: JET },
  light: {
    size: 22,
    svg: '<path stroke-width=".4" d="M-1.2-9h2.4v4h9v3.2h-9v5.6l3 1v2.2h-8.4v-2.2l3-1V-1.8h-9V-5h9z"/>',
  },
  glider: {
    size: 26,
    svg: '<path stroke-width=".35" d="M-1-8h2v5h10.5v2H1V6l2.5.5V8.2h-7V6.5L-1 6v-7H-11.5v-2H-1z"/>',
  },
  heli: {
    size: 24,
    svg:
      '<circle r="9.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".7"/>' +
      '<path stroke-width=".4" d="M0-6.5a3.2 4.5 0 1 1 0 9 3.2 4.5 0 1 1 0-9zM-1 2h2v5.3h2v1.7h-6V7.3h2z"/>',
  },
  balloon: {
    size: 20,
    fixed: true,
    svg: '<path d="M0-10a6.5 6.5 0 0 1 6.5 6.5c0 3.5-3.5 6-5 7.5h-3c-1.5-1.5-5-4-5-7.5A6.5 6.5 0 0 1 0-10zM-1.8 5.5h3.6V9h-3.6z"/>',
  },
  drone: {
    size: 20,
    svg:
      '<path d="M-5.5-4-4-5.5 5.5 4 4 5.5zM4-5.5 5.5-4-4 5.5-5.5 4z"/>' +
      '<circle cx="-5" cy="-5" r="2.8"/><circle cx="5" cy="-5" r="2.8"/>' +
      '<circle cx="-5" cy="5" r="2.8"/><circle cx="5" cy="5" r="2.8"/>',
  },
  ground: { size: 16, svg: '<rect x="-3.5" y="-6" width="7" height="12" rx="1.5"/>' },
};

const BY_CATEGORY: Record<string, Shape> = {
  A1: "light", // < 15,500 lb
  A2: "jet", // small, < 75,000 lb
  A3: "jet", // large
  A4: "jet", // high-vortex large (B757)
  A5: "heavy",
  A6: "jet", // high performance
  A7: "heli",
  B1: "glider",
  B2: "balloon",
  B4: "light", // ultralight / hang glider / paraglider
  B6: "drone",
  C1: "ground", // emergency vehicle
  C2: "ground", // service vehicle
  C3: "ground", // point obstacle
};

// Older firmware sent a number here (type code - 1); that and unknown
// categories fall back to the arrow.
export function shapeOf(category: string | number | undefined): Shape {
  return (typeof category === "string" && BY_CATEGORY[category]) || "arrow";
}

export const CATEGORY_NAMES: Record<string, string> = {
  A1: "light",
  A2: "small",
  A3: "large",
  A4: "high vortex large",
  A5: "heavy",
  A6: "high performance",
  A7: "rotorcraft",
  B1: "glider",
  B2: "lighter-than-air",
  B3: "parachutist",
  B4: "ultralight",
  B6: "UAV",
  B7: "space vehicle",
  C1: "emergency vehicle",
  C2: "service vehicle",
  C3: "obstacle",
};
