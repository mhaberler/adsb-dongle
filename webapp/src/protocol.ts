// Matches the NDJSON schema emitted by the dongle firmware
// (see ../../README.md and ../../CLAUDE.md in the repo root).

export interface AircraftMessage {
  hex: string;
  flight?: string;
  // Emitter category as in readsb, e.g. "A3" (large), "B2" (balloon).
  // Firmware before this field changed sent a number (type code - 1).
  category?: string | number;
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
  nic?: number; // integrity of the last position, 0-11
  version?: number;
  nic_baro?: number;
  nac_p?: number;
  sil?: number;
  sil_type?: string;
  gva?: number;
  rssi?: number; // dBFS, readsb method; only from +SS raw frames
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

// Raw ASCII-hex Mode-S frame from the GNS5892R/Rextron module itself:
// "*<28 hex chars>;" — 56-bit frames zero-padded to 14 bytes, MSB first
// (GNS5892 command-interface doc V1.0, "ADS-B data reception example").
// Command-reply lines ("#49-02-00-...-<LF CR>") are recognized and ignored.
//
// "+SS<hex>;" is the same frame with a signal byte in front, as a sensorpod
// publishes RTL-SDR frames on `ihex` (GNS5892R mode 3+ layout). SS is read
// on readsb's Beast scale, round(sqrt(signal) * 255) - a real GNS5892R in
// mode 3+ may scale it differently; we put the module in "*" mode anyway
// (#49-03).
export type StreamLineKind = "ndjson" | "rawframe" | "command-reply" | "unknown";

export function classifyLine(line: string): StreamLineKind {
  const trimmed = line.trim();
  if (!trimmed) return "unknown";
  if (trimmed[0] === "{") return "ndjson";
  if (trimmed[0] === "*" || trimmed[0] === "+") return "rawframe";
  if (trimmed[0] === "#") return "command-reply";
  return "unknown";
}

// Decodes a raw frame line's hex payload into bytes. Returns null if the
// line isn't well-formed (wrong length, non-hex characters) — the 14-byte
// output is zero-padded same as the module does for 56-bit short frames.
export function parseRawFrame(line: string): Uint8Array | null {
  const trimmed = line.trim();
  const start = trimmed[0] === "*" ? 1 : trimmed[0] === "+" ? 3 : 0;
  if (!start) return null;
  if (start === 3 && parseRawSignal(trimmed) === undefined) return null;
  const end = trimmed.indexOf(";");
  const hex = end === -1 ? trimmed.slice(start) : trimmed.slice(start, end);
  if (hex.length === 0 || hex.length > 28 || hex.length % 2 !== 0) return null;
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;

  const out = new Uint8Array(14);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

// Signal level (power, 0..1 of full scale) of a "+SS<hex>;" frame:
// (SS / 255)^2, i.e. 20*log10(SS/255) dBFS. undefined for "*" frames.
export function parseRawSignal(line: string): number | undefined {
  const trimmed = line.trim();
  if (trimmed[0] !== "+" || !/^[0-9A-Fa-f]{2}$/.test(trimmed.slice(1, 3))) return undefined;
  const ss = parseInt(trimmed.slice(1, 3), 16) / 255;
  return ss * ss;
}
