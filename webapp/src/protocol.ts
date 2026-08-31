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

// Raw ASCII-hex Mode-S frame from the GNS5892R/Rextron module itself:
// "*<28 hex chars>;" — 56-bit frames zero-padded to 14 bytes, MSB first
// (GNS5892 command-interface doc V1.0, "ADS-B data reception example").
// Command-reply lines ("#49-02-00-...-<LF CR>") are recognized and ignored.
export type StreamLineKind = "ndjson" | "rawframe" | "command-reply" | "unknown";

export function classifyLine(line: string): StreamLineKind {
  const trimmed = line.trim();
  if (!trimmed) return "unknown";
  if (trimmed[0] === "{") return "ndjson";
  if (trimmed[0] === "*") return "rawframe";
  if (trimmed[0] === "#") return "command-reply";
  return "unknown";
}

// Decodes a raw frame line's hex payload into bytes. Returns null if the
// line isn't well-formed (wrong length, non-hex characters) — the 14-byte
// output is zero-padded same as the module does for 56-bit short frames.
export function parseRawFrame(line: string): Uint8Array | null {
  const trimmed = line.trim();
  if (trimmed[0] !== "*") return null;
  const end = trimmed.indexOf(";");
  const hex = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  if (hex.length === 0 || hex.length > 28 || hex.length % 2 !== 0) return null;
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null;

  const out = new Uint8Array(14);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}
