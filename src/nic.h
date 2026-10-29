// Navigation Integrity Category (NIC, 0-11) of an airborne position, from
// the position message's type code plus the NIC supplements: NIC-A from
// the operational status message (ME31), NIC-B from bit 8 of the position
// message itself (version 2 only - in versions 0/1 that bit is the
// single-antenna flag). Mapping per DO-260B (version 2) and DO-260A
// (version 1), as in readsb's compute_nic(). Surface positions (TC 5-8) and
// GNSS-height positions (TC 20-22) are not decoded by this firmware.
//
// The supplements only decide between neighbouring values (9/8 for TC 11,
// 3/2 for TC 16), so they never move a position across the NIC < 7
// "degraded" threshold the webapp uses.
//
// Mirrored in webapp/src/aircraft-store.ts computeNic() - keep in sync.
#ifndef ADSB_NIC_H
#define ADSB_NIC_H

// version: ADS-B version from ME31 (-1 = not yet seen, treated as 0)
// nic_a: NIC supplement-A from ME31 (0 if not yet seen)
// nic_b: ME bit 8 of this position message
static inline int adsb_compute_nic(int metype, int version, int nic_a,
                                   int nic_b) {
  switch (metype) {
  case 9:
    return 11;
  case 10:
    return 10;
  case 11:
    if (version == 2)
      return nic_a && nic_b ? 9 : 8;
    if (version == 1)
      return nic_a ? 9 : 8;
    return 8;
  case 12:
    return 7;
  case 13:
    return 6;
  case 14:
    return 5;
  case 15:
    return 4;
  case 16:
    if (version == 2)
      return nic_a && nic_b ? 3 : 2;
    if (version == 1)
      return nic_a ? 3 : 2;
    return 2;
  case 17:
    return 1;
  default: // 18: no integrity (or unknown)
    return 0;
  }
}

#endif
