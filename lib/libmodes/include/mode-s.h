// Vendored from https://github.com/Displacer/libmodes @7ff29c93 (BSD-2,
// itself a refactor of antirez/dump1090). Patched for sensorpod:
//  - DF18 (CF 0/1/2/6) aliased into the DF17 ME-decode path
//  - ME19 mesub 1/2: geo_minus_baro (25 ft units) added to mode_s_msg
//  - ME31 mesub 0 (airborne operational status): ADS-B version, NIC-A,
//    NACp, GVA, SIL/SIL-type, NIC-baro added to mode_s_msg. Bit offsets
//    cross-checked against readsb's decodeESOperationalStatus()
//    (mode_s.c), version 1/2 only - version 0 carries none of these.
//  - ME28 mesub 1 (emergency/priority status): emergency code + ID13
//    squawk field added to mode_s_msg. Bit offsets cross-checked
//    against readsb's decodeESAircraftStatus().
//  - ME9-18 (airborne position): ME bit 8 as nic_b - NIC supplement-B in
//    ADS-B version 2, the single-antenna flag in versions 0/1. Combined
//    with the type code and NIC-A into NIC by the caller (adsb.cpp).
//  - decode_ac12_field(): Q=0 (100 ft Gillham code, older GA altitude
//    encoders) decoded like readsb's decodeAC12Field()/modeAToModeC();
//    the original returned 0. Undecodable fields give
//    MODE_S_INVALID_ALTITUDE, altitude_valid = 0.
//  - ME19: raw speed/vertical-rate/geo-delta values are offset by one,
//    0 = no information (readsb's decodeESAirborneVelocity()). velocity
//    (kt, x4 for supersonic subtype 2), vert_rate (ft/min, signed) and
//    geo_minus_baro (ft, signed) are scaled values with their own
//    *_valid flags; vertical rate and geo delta decoded for subtypes 1-4.
//  - ME28 squawk (es_squawk) hex-coded like readsb: 7700 -> 0x7700.
// See sensorpod ADSB.md for details.
#ifndef __MODE_S_DECODER_H
#define __MODE_S_DECODER_H

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

#define MODE_S_ICAO_CACHE_LEN 1024 // Power of two required
#define MODE_S_LONG_MSG_BYTES (112 / 8)
#define MODE_S_UNIT_FEET 0
#define MODE_S_UNIT_METERS 1
#define MODE_S_INVALID_ALTITUDE (-9999) // decode_ac12_field(): no altitude

// Program state
typedef struct {
  // Internal state
  uint32_t icao_cache[sizeof(uint32_t) * MODE_S_ICAO_CACHE_LEN *
                      2]; // Recently seen ICAO addresses cache

  // Configuration
  int fix_errors; // Single bit error correction if true
  int aggressive; // Aggressive detection algorithm
  int check_crc;  // Only display messages with good CRC
} mode_s_t;

// The struct we use to store information about a decoded message
struct mode_s_msg {
  // Generic fields
  unsigned char msg[MODE_S_LONG_MSG_BYTES]; // Binary message
  int msgbits;                              // Number of bits in message
  int msgtype;                              // Downlink format #
  int crcok;                                // True if CRC was valid
  uint32_t crc;                             // Message CRC
  int errorbit;        // Bit corrected. -1 if no bit corrected.
  int aa1, aa2, aa3;   // ICAO Address bytes 1 2 and 3
  int phase_corrected; // True if phase correction was applied.

  // DF 11
  int ca; // Responder capabilities.

  // DF 17
  int metype; // Extended squitter message type.
  int mesub;  // Extended squitter message subtype.
  int heading_is_valid;
  int heading;
  int aircraft_type;
  int fflag;                // 1 = Odd, 0 = Even CPR message.
  int tflag;                // UTC synchronized?
  int raw_latitude;         // Non decoded latitude
  int raw_longitude;        // Non decoded longitude
  int nic_b;                // ME bit 8 (airborne position), see top.
  char flight[9];           // 8 chars flight number.
  int ew_dir;               // 0 = East, 1 = West.
  int ew_velocity;          // E/W velocity, knots (unsigned).
  int ns_dir;               // 0 = North, 1 = South.
  int ns_velocity;          // N/S velocity, knots (unsigned).
  int vert_rate_source;     // Vertical rate source: 1 = baro, 0 = GNSS.
  int vert_rate_sign;       // Vertical rate sign (1 = descending).
  int vert_rate_valid;      // 1 if vert_rate is present.
  int vert_rate;            // Vertical rate, ft/min, signed.
  int velocity_valid;       // 1 if velocity/heading (sub 1/2) are present.
  int velocity;             // Ground speed, knots, from EW and NS velocity.
  int geo_minus_baro_valid; // 1 if geo_minus_baro is present.
  int geo_minus_baro_sign;  // 1 = GNSS alt below baro alt.
  int geo_minus_baro;       // geometric - barometric altitude, feet, signed.

  // ME31 (Operational Status), mesub 0 (airborne) only, version 1/2.
  int opstatus_valid;   // 1 if the fields below are populated.
  int opstatus_version; // ADS-B version (0/1/2, from ME bits 41-43).
  int nic_a_valid;
  int nic_a; // NIC supplement A.
  int nac_p_valid;
  int nac_p; // Navigation Accuracy Category, position (0-11).
  int gva_valid;
  int gva; // Geometric Vertical Accuracy (version 2 only).
  int nic_baro_valid;
  int nic_baro; // Barometric altitude integrity.
  int sil_valid;
  int sil;      // Source Integrity Level (0-3).
  int sil_type; // 0 = per-hour, 1 = per-sample (version 2 only).

  // ME28 (Aircraft Status), mesub 1 (Emergency/Priority Status).
  int es_emergency_valid;
  int es_emergency; // 0=none,1=general,2=lifeguard/medical,3=min fuel,
                    // 4=no comms(7600),5=unlawful interference(7500),
                    // 6=downed aircraft (DO-260B Table 2-42).
  int es_squawk_valid;
  int es_squawk; // Squawk from the ME28 ID13 field, hex-coded
                 // (7700 -> 0x7700, print with "%04x"), unlike `identity`
                 // below (decimal digits, 7700 -> 7700).

  // DF4, DF5, DF20, DF21
  int fs;       // Flight status for DF4,5,20,21
  int dr;       // Request extraction of downlink request.
  int um;       // Request extraction of downlink request.
  int identity; // 13 bits identity (Squawk).

  // Fields used by multiple message types.
  int altitude, unit;
  int altitude_valid; // ME9-18 only: 0 if the AC12 field held no altitude.
};

typedef void (*mode_s_callback_t)(mode_s_t *self, struct mode_s_msg *mm);

#ifdef __cplusplus
extern "C" {
#endif

void mode_s_init(mode_s_t *self);
void mode_s_compute_magnitude_vector(unsigned char *data, uint16_t *mag,
                                     uint32_t size);
void mode_s_detect(mode_s_t *self, uint16_t *mag, uint32_t maglen,
                   mode_s_callback_t);
void mode_s_decode(mode_s_t *self, struct mode_s_msg *mm, unsigned char *msg);

#ifdef __cplusplus
}
#endif

#endif
