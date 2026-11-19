// Port of the decode half of lib/libmodes/src/mode-s.c (Displacer/libmodes,
// BSD-2-Clause, a refactor of antirez/dump1090), restricted to DF17 and
// DF18 CF 0/1/2/6 (ADS-B/TIS-B rebroadcast, aliased into the same ME-decode
// path). The demodulator (mode_s_detect/magnitude vector) is not ported —
// this module decodes already-framed 14-byte binary frames, same as the
// firmware. CRC is check-only: no single/two-bit error correction (matches
// firmware config: fix_errors=0, aggressive=0, check_crc=1).
//
// Carries the same local patches as the firmware (see comment at top
// of lib/libmodes/include/mode-s.h): DF18 aliasing, ME19 geo-baro delta,
// ME31 operational status fields, ME28 emergency/squawk, NIC-B — plus the
// decode fixes from the same comment: Gillham (Q=0) altitude, ME19
// velocity/vertical-rate/geo-delta scaling, hex-coded squawk.

const MODE_S_CHECKSUM_TABLE: number[] = [
  0x3935ea, 0x1c9af5, 0xf1b77e, 0x78dbbf, 0xc397db, 0x9e31e9, 0xb0e2f0,
  0x587178, 0x2c38bc, 0x161c5e, 0x0b0e2f, 0xfa7d13, 0x82c48d, 0xbe9842,
  0x5f4c21, 0xd05c14, 0x682e0a, 0x341705, 0xe5f186, 0x72f8c3, 0xc68665,
  0x9cb936, 0x4e5c9b, 0xd8d449, 0x939020, 0x49c810, 0x24e408, 0x127204,
  0x093902, 0x049c81, 0xfdb444, 0x7eda22, 0x3f6d11, 0xe04c8c, 0x702646,
  0x381323, 0xe3f395, 0x8e03ce, 0x4701e7, 0xdc7af7, 0x91c77f, 0xb719bb,
  0xa476d9, 0xadc168, 0x56e0b4, 0x2b705a, 0x15b82d, 0xf52612, 0x7a9309,
  0xc2b380, 0x6159c0, 0x30ace0, 0x185670, 0x0c2b38, 0x06159c, 0x030ace,
  0x018567, 0xff38b7, 0x80665f, 0xbfc92b, 0xa01e91, 0xaff54c, 0x57faa6,
  0x2bfd53, 0xea04ad, 0x8af852, 0x457c29, 0xdd4410, 0x6ea208, 0x375104,
  0x1ba882, 0x0dd441, 0xf91024, 0x7c8812, 0x3e4409, 0xe0d800, 0x706c00,
  0x383600, 0x1c1b00, 0x0e0d80, 0x0706c0, 0x038360, 0x01c1b0, 0x00e0d8,
  0x00706c, 0x003836, 0x001c1b, 0xfff409, 0x000000, 0x000000, 0x000000,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
];

export function modeSChecksum(msg: Uint8Array, bits: number): number {
  let crc = 0;
  const offset = bits === 112 ? 0 : 112 - 56;
  for (let j = 0; j < bits; j++) {
    const byte = j >> 3;
    const bit = j & 7;
    const bitmask = 1 << (7 - bit);
    if (msg[byte] & bitmask) crc ^= MODE_S_CHECKSUM_TABLE[j + offset];
  }
  return crc >>> 0;
}

function msgLenByType(type: number): number {
  return type === 16 || type === 17 || type === 19 || type === 20 || type === 21
    ? 112
    : 56;
}

const AIS_CHARSET =
  "?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????";

// ME-relative bit accessors (1-based, bit 1 = first bit of the ME field,
// i.e. msg[4] MSB) — matches readsb's getbit()/getbits() convention so bit
// numbers transcribed from readsb's decoders can be used directly.
function meGetBit(msg: Uint8Array, bitnum: number): number {
  const bi = bitnum - 1;
  const by = 4 + (bi >> 3);
  const mask = 1 << (7 - (bi & 7));
  return msg[by] & mask ? 1 : 0;
}

function meGetBits(msg: Uint8Array, firstBit: number, lastBit: number): number {
  let value = 0;
  for (let i = firstBit; i <= lastBit; i++) {
    value = (value << 1) | meGetBit(msg, i);
  }
  return value;
}

// 13-bit Gillham-ordered field (C1 A1 C2 A2 C4 A4 X B1 D1 B2 D2 B4 D4,
// MSB first) -> "hex Gillham" 0xABCD, one octal digit per nibble (bit 0 =
// x1, bit 1 = x2, bit 2 = x4), as readsb's decodeID13Field(). For a squawk
// this is the code itself in hex: 7700 -> 0x7700.
export function decodeId13Field(id13: number): number {
  let hex = 0;
  if (id13 & 0x1000) hex |= 0x0010; // C1
  if (id13 & 0x0800) hex |= 0x1000; // A1
  if (id13 & 0x0400) hex |= 0x0020; // C2
  if (id13 & 0x0200) hex |= 0x2000; // A2
  if (id13 & 0x0100) hex |= 0x0040; // C4
  if (id13 & 0x0080) hex |= 0x4000; // A4
  // 0x0040: X (or M), unused
  if (id13 & 0x0020) hex |= 0x0100; // B1
  if (id13 & 0x0010) hex |= 0x0001; // D1 (or Q)
  if (id13 & 0x0008) hex |= 0x0200; // B2
  if (id13 & 0x0004) hex |= 0x0002; // D2
  if (id13 & 0x0002) hex |= 0x0400; // B4
  if (id13 & 0x0001) hex |= 0x0004; // D4
  return hex;
}

// Gillham (Mode C) altitude code in hex-Gillham form -> altitude in 100 ft
// units, or undefined if the code is not a valid altitude. Same algorithm
// as readsb's internalModeAToModeC() (mode_ac.c): the 500 ft steps are a
// Gray code over D2 D4 A1 A2 A4 B1 B2 B4, the 100 ft steps a 5-state
// reflected code over C1 C2 C4.
export function modeAToModeC(modeA: number): number | undefined {
  // D1 and the unused bits must be clear, C1/C2/C4 can't all be zero.
  if ((modeA & 0xffff8889) !== 0 || (modeA & 0x00f0) === 0) return undefined;

  let oneHundreds = 0;
  if (modeA & 0x0010) oneHundreds ^= 0x007; // C1
  if (modeA & 0x0020) oneHundreds ^= 0x003; // C2
  if (modeA & 0x0040) oneHundreds ^= 0x001; // C4
  if ((oneHundreds & 5) === 5) oneHundreds ^= 2; // 7 -> 5, 5 -> 7
  if (oneHundreds > 5) return undefined;

  let fiveHundreds = 0;
  if (modeA & 0x0002) fiveHundreds ^= 0x0ff; // D2
  if (modeA & 0x0004) fiveHundreds ^= 0x07f; // D4
  if (modeA & 0x1000) fiveHundreds ^= 0x03f; // A1
  if (modeA & 0x2000) fiveHundreds ^= 0x01f; // A2
  if (modeA & 0x4000) fiveHundreds ^= 0x00f; // A4
  if (modeA & 0x0100) fiveHundreds ^= 0x007; // B1
  if (modeA & 0x0200) fiveHundreds ^= 0x003; // B2
  if (modeA & 0x0400) fiveHundreds ^= 0x001; // B4

  // The 100 ft code runs backwards in odd 500 ft steps.
  if (fiveHundreds & 1) oneHundreds = 6 - oneHundreds;

  return fiveHundreds * 5 + oneHundreds - 13;
}

// 12-bit AC altitude field (ME bits 9-20) -> feet, undefined if not
// available. Q bit set: 25 ft steps. Q bit clear: 100 ft Gillham code, as
// sent by older (mostly GA) altitude encoders (patch: firmware; libmodes
// returned 0 here).
function decodeAc12Field(msg: Uint8Array): number | undefined {
  const ac12 = meGetBits(msg, 9, 20);
  if (ac12 & 0x10) {
    const n = ((ac12 & 0x0fe0) >> 1) | (ac12 & 0x000f);
    return n * 25 - 1000;
  }
  // Insert M = 0 at bit 6 to get the 13-bit Gillham layout.
  const id13 = ((ac12 & 0x0fc0) << 1) | (ac12 & 0x003f);
  const c = modeAToModeC(decodeId13Field(id13));
  return c === undefined ? undefined : c * 100;
}

export interface ModeSMessage {
  msgtype: number;
  crcok: boolean;
  aa1: number;
  aa2: number;
  aa3: number;
  icao: number;

  metype: number;
  mesub: number;

  // ME1-4: identification
  flight?: string;
  aircraftType?: number;

  // ME9-18: airborne position
  fflag?: boolean;
  altitude?: number; // feet; undefined if the AC field carries none
  rawLatitude?: number;
  rawLongitude?: number;
  nicB?: number; // ME bit 8: NIC supplement-B (v2), single-antenna flag (v0/1)

  // ME19 sub 1-4: velocity. Each field is undefined when the message says
  // "no information" (raw value 0).
  velocity?: number; // ground speed, knots (sub 1/2)
  heading?: number; // track over ground (sub 1/2) or heading (sub 3/4), degrees
  headingIsValid?: boolean; // sub 3/4 only
  vertRate?: number; // ft/min, signed (positive = climbing)
  vertRateBaro?: boolean; // vertRate source: true = barometric, false = GNSS
  geoMinusBaro?: number; // geometric - barometric altitude, feet, signed

  // ME31 sub 0: operational status (version 1/2 only)
  opstatusValid?: boolean;
  opstatusVersion?: number;
  nicA?: number;
  nacP?: number;
  gva?: number;
  nicBaro?: number;
  sil?: number;
  silType?: number;

  // ME28 sub 1: emergency/priority status
  esEmergencyValid?: boolean;
  esEmergency?: number;
  esSquawkValid?: boolean;
  esSquawk?: number;
}

// Decodes a 14-byte (112-bit) binary Mode-S frame. Returns null if the CRC
// doesn't check out, or if it's not DF17/DF18(CF 0/1/2/6). Short (56-bit)
// frames zero-padded to 14 bytes (as emitted by the GNS5892/Rextron
// modules) never carry DF17/18, so they're rejected by the DF filter below
// without needing special-case handling of the padding.
export function decodeModeS(msg: Uint8Array): ModeSMessage | null {
  const msgtype = msg[0] >> 3;
  const msgbits = msgLenByType(msgtype);

  const crc =
    ((msg[msgbits / 8 - 3] << 16) |
      (msg[msgbits / 8 - 2] << 8) |
      msg[msgbits / 8 - 1]) >>>
    0;
  const crc2 = modeSChecksum(msg, msgbits);
  if (crc !== crc2) return null;

  const aa1 = msg[1];
  const aa2 = msg[2];
  const aa3 = msg[3];
  const metype = msg[4] >> 3;
  const mesub = msg[4] & 7;

  const df18Cf = msg[0] & 7;
  const isDf18Es = msgtype === 18 && (df18Cf === 0 || df18Cf === 1 || df18Cf === 2 || df18Cf === 6);
  if (msgtype !== 17 && !isDf18Es) return null;

  const mm: ModeSMessage = {
    msgtype,
    crcok: true,
    aa1,
    aa2,
    aa3,
    icao: (aa1 << 16) | (aa2 << 8) | aa3,
    metype,
    mesub,
  };

  if (metype >= 1 && metype <= 4) {
    mm.aircraftType = metype - 1;
    const chars = [
      AIS_CHARSET[msg[5] >> 2],
      AIS_CHARSET[((msg[5] & 3) << 4) | (msg[6] >> 4)],
      AIS_CHARSET[((msg[6] & 15) << 2) | (msg[7] >> 6)],
      AIS_CHARSET[msg[7] & 63],
      AIS_CHARSET[msg[8] >> 2],
      AIS_CHARSET[((msg[8] & 3) << 4) | (msg[9] >> 4)],
      AIS_CHARSET[((msg[9] & 15) << 2) | (msg[10] >> 6)],
      AIS_CHARSET[msg[10] & 63],
    ];
    mm.flight = chars.join("");
  } else if (metype >= 9 && metype <= 18) {
    mm.fflag = (msg[6] & (1 << 2)) !== 0;
    mm.altitude = decodeAc12Field(msg);
    mm.rawLatitude = ((msg[6] & 3) << 15) | (msg[7] << 7) | (msg[8] >> 1);
    mm.rawLongitude = ((msg[8] & 1) << 16) | (msg[9] << 8) | msg[10];
    mm.nicB = meGetBit(msg, 8); // (patch: firmware)
  } else if (metype === 19 && mesub >= 1 && mesub <= 4) {
    // Raw values are offset by one (0 = no information), as in readsb's
    // decodeESAirborneVelocity() (patch: firmware; libmodes used them
    // unscaled and without the offset).
    if (mesub === 1 || mesub === 2) {
      const ewRaw = meGetBits(msg, 15, 24);
      const nsRaw = meGetBits(msg, 26, 35);
      if (ewRaw && nsRaw) {
        const scale = mesub === 2 ? 4 : 1; // subtype 2: supersonic, 4 kt units
        const ewv = (ewRaw - 1) * scale * (meGetBit(msg, 14) ? -1 : 1);
        const nsv = (nsRaw - 1) * scale * (meGetBit(msg, 25) ? -1 : 1);
        mm.velocity = Math.sqrt(ewv * ewv + nsv * nsv);
        let heading = (Math.atan2(ewv, nsv) * 180) / Math.PI;
        if (heading < 0) heading += 360;
        mm.heading = heading;
      }
    } else {
      mm.headingIsValid = (msg[5] & (1 << 2)) !== 0;
      mm.heading = (360.0 / 128) * (((msg[5] & 3) << 5) | (msg[6] >> 3));
    }

    // Vertical rate, 64 ft/min units; same position in all four subtypes.
    const vrRaw = meGetBits(msg, 38, 46);
    if (vrRaw) {
      mm.vertRate = (meGetBit(msg, 37) ? -64 : 64) * (vrRaw - 1) || 0; // || 0: no "-0"
      mm.vertRateBaro = meGetBit(msg, 36) === 1;
    }

    // Geometric - barometric altitude difference, 25 ft units, bit 49 is
    // the sign (patch: firmware).
    const deltaRaw = meGetBits(msg, 50, 56);
    if (deltaRaw) {
      mm.geoMinusBaro = (meGetBit(msg, 49) ? -25 : 25) * (deltaRaw - 1) || 0;
    }
  } else if (metype === 31 && mesub === 0) {
    // Operational Status, airborne (mesub 0). Only versions 1/2 carry
    // NIC-A/NACp/GVA/SIL; version 0 has none of these (patch: firmware).
    const version = meGetBits(msg, 41, 43);
    mm.opstatusVersion = version;
    if (version === 1 || version === 2) {
      mm.opstatusValid = true;
      mm.nicA = meGetBit(msg, 44);
      mm.nacP = meGetBits(msg, 45, 48);
      mm.sil = meGetBits(msg, 51, 52);
      if (version === 1) {
        mm.silType = 0; // per-hour (version 1 doesn't distinguish)
        mm.nicBaro = meGetBit(msg, 53);
      } else {
        mm.silType = meGetBit(msg, 55); // 1 = per-sample
        mm.gva = meGetBits(msg, 49, 50);
        mm.nicBaro = meGetBit(msg, 53);
      }
    }
  } else if (metype === 28 && mesub === 1) {
    // Aircraft Status, Emergency/Priority (mesub 1) (patch: firmware).
    mm.esEmergencyValid = true;
    mm.esEmergency = meGetBits(msg, 9, 11);

    // ID13 field, 13 bits, MSB (bit 12) first. Stored hex-coded like
    // readsb (squawk 7700 -> 0x7700), so "%04x" prints the code.
    const id13 = meGetBits(msg, 12, 24);
    if (id13) {
      mm.esSquawkValid = true;
      mm.esSquawk = decodeId13Field(id13);
    }
  }

  return mm;
}
