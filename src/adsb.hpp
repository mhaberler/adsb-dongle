#pragma once

#include <stdint.h>

void adsb_setup();
void adsb_loop();

struct AdsbStats {
  uint32_t frames_seen;      // '*...;' frames received from the module
  uint32_t crc_fail;         // frames dropped: bad Mode-S checksum
  uint32_t decoded;          // frames accepted (crcok, DF17/18)
  uint32_t dropped_lines;    // oversize/garbage frames (reader task)
  uint32_t dropped_overflow; // ring buffer full (reader task)
  uint32_t aircraft_count;   // live entries in the aircraft table
};

AdsbStats adsb_get_stats();
