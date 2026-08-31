// Matches the NDJSON schema emitted by the dongle firmware
// (see ../../README.md and ../../CLAUDE.md in the repo root).

export interface AircraftMessage {
  hex: string;
  flight?: string;
  category?: number;
  alt_baro?: number;
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  emergency?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  version?: number;
  nic_baro?: number;
  nac_p?: number;
  sil?: number;
  sil_type?: string;
  gva?: number;
  seen: number;
  messages: number;
}

export interface TombstoneMessage {
  hex: string;
  expired: true;
}

export interface StatsMessage {
  frames_seen: number;
  crc_fail: number;
  decoded: number;
  dropped_lines: number;
  dropped_overflow: number;
  aircraft_count: number;
}

export type DongleMessage =
  | { kind: "aircraft"; data: AircraftMessage }
  | { kind: "tombstone"; data: TombstoneMessage }
  | { kind: "stats"; data: StatsMessage };

export function parseLine(line: string): DongleMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  if (typeof o.frames_seen === "number") {
    return { kind: "stats", data: o as unknown as StatsMessage };
  }
  if (o.expired === true && typeof o.hex === "string") {
    return { kind: "tombstone", data: o as unknown as TombstoneMessage };
  }
  if (typeof o.hex === "string" && typeof o.seen === "number") {
    return { kind: "aircraft", data: o as unknown as AircraftMessage };
  }
  return null;
}
