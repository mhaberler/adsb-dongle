// Browser-side equivalent of the firmware's aircraft table (Aircraft struct
// + adsb_process_frame/adsb_table_loop in src/adsb.cpp): keyed by ICAO,
// CPR even/odd pairing per aircraft, 60s TTL eviction. Unlike the firmware
// there's no fixed-size slot cap (a JS Map, not a 100-entry static array)
// and no publish throttle (the browser has no serial-bandwidth constraint,
// so marker updates are emitted immediately per frame).
import { decodeModeS, type ModeSMessage } from "./modes";
import { decodeCPRairborne } from "./cpr";
import type { AircraftMessage, StatsMessage } from "./protocol";

const AIRCRAFT_TTL_MS = 60000; // matches ADSB_AIRCRAFT_TTL_MS
const CPR_PAIR_MAX_MS = 10000; // matches ADSB_CPR_PAIR_MAX_MS
const EMERGENCY_NAMES = [
  "none",
  "general",
  "lifeguard",
  "minfuel",
  "nordo",
  "unlawful",
  "downed",
  "reserved",
];

interface AircraftState {
  icao: number;
  flight?: string;
  category?: number;
  altBaro?: number;
  altGeom?: number;
  gs?: number;
  track?: number;
  baroRate?: number;
  squawk?: number;
  emergency?: number;
  lat?: number;
  lon?: number;
  seenPosMs?: number;

  navVersion?: number;
  nacP?: number;
  gva?: number;
  nicBaro?: number;
  sil?: number;
  silType?: number;

  evenValid: boolean;
  oddValid: boolean;
  evenLat: number;
  evenLon: number;
  oddLat: number;
  oddLon: number;
  evenMs: number;
  oddMs: number;

  lastSeenMs: number;
  messages: number;
}

export type StoreEvent =
  | { kind: "update"; data: AircraftMessage }
  | { kind: "remove"; hex: string };

function icaoToHex(icao: number): string {
  return icao.toString(16).padStart(6, "0");
}

export class AircraftStore {
  private table = new Map<number, AircraftState>();
  private framesSeen = 0;
  private crcFail = 0;
  private decoded = 0;
  private droppedLines = 0;

  // Feed a raw 14-byte Mode-S frame (already hex-decoded). Returns store
  // events (update/remove) produced by this frame, if any.
  processFrame(msg: Uint8Array): StoreEvent[] {
    this.framesSeen++;

    const mm = decodeModeS(msg);
    if (!mm) {
      this.crcFail++;
      return [];
    }
    this.decoded++;

    const now = Date.now();
    let ac = this.table.get(mm.icao);
    if (!ac) {
      ac = {
        icao: mm.icao,
        evenValid: false,
        oddValid: false,
        evenLat: 0,
        evenLon: 0,
        oddLat: 0,
        oddLon: 0,
        evenMs: 0,
        oddMs: 0,
        lastSeenMs: now,
        messages: 0,
      };
      this.table.set(mm.icao, ac);
    }
    ac.lastSeenMs = now;
    ac.messages++;

    this.applyMessage(ac, mm, now);

    return [{ kind: "update", data: this.toAircraftMessage(ac, now) }];
  }

  // Malformed line from the reader (bad hex, wrong length) — counted
  // separately from CRC failures, matching the firmware's dropped_lines.
  recordDroppedLine(): void {
    this.droppedLines++;
  }

  // Sweep for TTL eviction; call on a ~1s tick. Returns remove events.
  sweep(): StoreEvent[] {
    const now = Date.now();
    const events: StoreEvent[] = [];
    for (const [icao, ac] of this.table) {
      if (now - ac.lastSeenMs > AIRCRAFT_TTL_MS) {
        events.push({ kind: "remove", hex: icaoToHex(icao) });
        this.table.delete(icao);
      }
    }
    return events;
  }

  getStats(): StatsMessage {
    return {
      frames_seen: this.framesSeen,
      crc_fail: this.crcFail,
      decoded: this.decoded,
      dropped_lines: this.droppedLines,
      dropped_overflow: 0,
      aircraft_count: this.table.size,
    };
  }

  private applyMessage(ac: AircraftState, mm: ModeSMessage, now: number): void {
    if (mm.metype >= 1 && mm.metype <= 4) {
      ac.flight = mm.flight;
      ac.category = mm.aircraftType;
    } else if (mm.metype >= 9 && mm.metype <= 18) {
      ac.altBaro = mm.altitude;

      if (mm.fflag) {
        ac.oddLat = mm.rawLatitude!;
        ac.oddLon = mm.rawLongitude!;
        ac.oddMs = now;
        ac.oddValid = true;
      } else {
        ac.evenLat = mm.rawLatitude!;
        ac.evenLon = mm.rawLongitude!;
        ac.evenMs = now;
        ac.evenValid = true;
      }

      if (ac.evenValid && ac.oddValid && Math.abs(ac.evenMs - ac.oddMs) <= CPR_PAIR_MAX_MS) {
        const pos = decodeCPRairborne(ac.evenLat, ac.evenLon, ac.oddLat, ac.oddLon, !!mm.fflag);
        if (pos) {
          ac.lat = pos.lat;
          ac.lon = pos.lon;
          ac.seenPosMs = now;
        }
      }
    } else if (mm.metype === 19 && mm.mesub! >= 1 && mm.mesub! <= 4) {
      ac.baroRate = mm.vertRateSign ? -mm.vertRate! : mm.vertRate;
      if (mm.mesub === 1 || mm.mesub === 2) {
        ac.gs = Math.round(mm.velocity!);
        ac.track = Math.round(mm.heading!);
      } else if (mm.headingIsValid) {
        ac.track = Math.round(mm.heading!);
      }
      if (mm.geoMinusBaroValid && ac.altBaro !== undefined) {
        const delta = mm.geoMinusBaroSign ? -mm.geoMinusBaro! : mm.geoMinusBaro!;
        ac.altGeom = ac.altBaro + delta;
      }
    } else if (mm.metype === 31 && mm.mesub === 0 && mm.opstatusValid) {
      ac.navVersion = mm.opstatusVersion;
      if (mm.nacP !== undefined) ac.nacP = mm.nacP;
      if (mm.gva !== undefined) ac.gva = mm.gva;
      if (mm.nicBaro !== undefined) ac.nicBaro = mm.nicBaro;
      if (mm.sil !== undefined) {
        ac.sil = mm.sil;
        ac.silType = mm.silType;
      }
    } else if (mm.metype === 28 && mm.mesub === 1) {
      if (mm.esEmergencyValid) ac.emergency = mm.esEmergency;
      if (mm.esSquawkValid) ac.squawk = mm.esSquawk;
    }
  }

  private toAircraftMessage(ac: AircraftState, now: number): AircraftMessage {
    const msg: AircraftMessage = {
      hex: icaoToHex(ac.icao),
      seen: (now - ac.lastSeenMs) / 1000,
      messages: ac.messages,
    };
    if (ac.flight !== undefined) msg.flight = ac.flight;
    if (ac.category !== undefined) msg.category = ac.category;
    if (ac.altBaro !== undefined) msg.alt_baro = ac.altBaro;
    if (ac.altGeom !== undefined) msg.alt_geom = ac.altGeom;
    if (ac.gs !== undefined) msg.gs = ac.gs;
    if (ac.track !== undefined) msg.track = ac.track;
    if (ac.baroRate !== undefined) msg.baro_rate = ac.baroRate;
    if (ac.squawk !== undefined) msg.squawk = ac.squawk.toString(16).padStart(4, "0");
    if (ac.emergency !== undefined) {
      msg.emergency = EMERGENCY_NAMES[ac.emergency < 8 ? ac.emergency : 7];
    }
    if (ac.lat !== undefined && ac.lon !== undefined) {
      msg.lat = ac.lat;
      msg.lon = ac.lon;
      msg.seen_pos = (now - ac.seenPosMs!) / 1000;
    }
    if (ac.navVersion !== undefined) {
      msg.version = ac.navVersion;
      if (ac.nicBaro !== undefined) msg.nic_baro = ac.nicBaro;
      if (ac.nacP !== undefined) msg.nac_p = ac.nacP;
      if (ac.sil !== undefined) {
        msg.sil = ac.sil;
        msg.sil_type = ac.silType ? "persample" : "perhour";
      }
      if (ac.gva !== undefined) msg.gva = ac.gva;
    }
    return msg;
  }
}
