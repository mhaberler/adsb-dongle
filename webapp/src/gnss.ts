import type { AircraftMessage } from "./protocol";

// How good the aircraft's own GNSS position is, as it reports it: NIC
// (integrity, from the position message's type code) and NACp (accuracy,
// from the operational status, ADS-B version 1+). Degraded below NIC 7
// (containment radius over 0.2 NM) or NACp 8 (error over 93 m), unusable
// at 0. Many aircraft degraded in one area at once points to GPS jamming;
// a single one says little (old avionics). Spoofing mostly goes unnoticed,
// since the receiver on board believes its fake position is accurate.
export type GnssQuality = "ok" | "degraded" | "unusable";

const NIC_MIN = 7;
const NACP_MIN = 8;

// null without a position or without NIC/NACp (yet)
export function gnssQuality(ac: AircraftMessage): GnssQuality | null {
  if (ac.lat === undefined || ac.lon === undefined) return null;
  const nacp = ac.version !== undefined && ac.version >= 1 ? ac.nac_p : undefined;
  const nic = ac.nic;
  if (nic === undefined && nacp === undefined) return null;
  if (nic === 0 || nacp === 0) return "unusable";
  if ((nic !== undefined && nic < NIC_MIN) || (nacp !== undefined && nacp < NACP_MIN)) {
    return "degraded";
  }
  return "ok";
}

export const gnssDegraded = (ac: AircraftMessage) => {
  const q = gnssQuality(ac);
  return q === "degraded" || q === "unusable";
};

// "NIC 8 · NACp 9", whichever are known
export function gnssValues(ac: AircraftMessage): string {
  return [
    ac.nic !== undefined && `NIC ${ac.nic}`,
    ac.version !== undefined && ac.version >= 1 && ac.nac_p !== undefined && `NACp ${ac.nac_p}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
