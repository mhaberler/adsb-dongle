// Port of src/cpr.c's decodeCPRairborne() (readsb's CPR position solver,
// GPL-3, same license as this repo). Only the global airborne solve is
// ported — no receiver-reference-position / local CPR, matching the
// firmware (this is for a mobile, balloon-borne receiver).

function cprModInt(a: number, b: number): number {
  const res = a % b;
  return res < 0 ? res + b : res;
}

// The NL function uses the precomputed table from 1090-WP-9-14.
function cprNLFunction(latIn: number): number {
  const lat = latIn < 0 ? -latIn : latIn;
  if (lat < 10.4704713) return 59;
  if (lat < 14.82817437) return 58;
  if (lat < 18.18626357) return 57;
  if (lat < 21.02939493) return 56;
  if (lat < 23.54504487) return 55;
  if (lat < 25.82924707) return 54;
  if (lat < 27.9389871) return 53;
  if (lat < 29.91135686) return 52;
  if (lat < 31.77209708) return 51;
  if (lat < 33.53993436) return 50;
  if (lat < 35.22899598) return 49;
  if (lat < 36.85025108) return 48;
  if (lat < 38.41241892) return 47;
  if (lat < 39.92256684) return 46;
  if (lat < 41.38651832) return 45;
  if (lat < 42.80914012) return 44;
  if (lat < 44.19454951) return 43;
  if (lat < 45.54626723) return 42;
  if (lat < 46.86733252) return 41;
  if (lat < 48.16039128) return 40;
  if (lat < 49.42776439) return 39;
  if (lat < 50.67150166) return 38;
  if (lat < 51.89342469) return 37;
  if (lat < 53.09516153) return 36;
  if (lat < 54.27817472) return 35;
  if (lat < 55.44378444) return 34;
  if (lat < 56.59318756) return 33;
  if (lat < 57.72747354) return 32;
  if (lat < 58.84763776) return 31;
  if (lat < 59.95459277) return 30;
  if (lat < 61.04917774) return 29;
  if (lat < 62.13216659) return 28;
  if (lat < 63.20427479) return 27;
  if (lat < 64.26616523) return 26;
  if (lat < 65.3184531) return 25;
  if (lat < 66.36171008) return 24;
  if (lat < 67.39646774) return 23;
  if (lat < 68.42322022) return 22;
  if (lat < 69.44242631) return 21;
  if (lat < 70.45451075) return 20;
  if (lat < 71.45986473) return 19;
  if (lat < 72.45884545) return 18;
  if (lat < 73.45177442) return 17;
  if (lat < 74.43893416) return 16;
  if (lat < 75.42056257) return 15;
  if (lat < 76.39684391) return 14;
  if (lat < 77.36789461) return 13;
  if (lat < 78.33374083) return 12;
  if (lat < 79.29428225) return 11;
  if (lat < 80.24923213) return 10;
  if (lat < 81.19801349) return 9;
  if (lat < 82.13956981) return 8;
  if (lat < 83.07199445) return 7;
  if (lat < 83.99173563) return 6;
  if (lat < 84.89166191) return 5;
  if (lat < 85.75541621) return 4;
  if (lat < 86.53536998) return 3;
  if (lat < 87.0) return 2;
  return 1;
}

function cprNFunction(lat: number, fflag: boolean): number {
  const nl = cprNLFunction(lat) - (fflag ? 1 : 0);
  return nl < 1 ? 1 : nl;
}

function cprDlonFunction(lat: number, fflag: boolean): number {
  return 360.0 / cprNFunction(lat, fflag);
}

export interface CprResult {
  lat: number;
  lon: number;
}

// Global airborne CPR solve from an even/odd frame pair. Returns null on
// bad data or if the pair crossed a latitude zone (caller should wait for
// another pair). fflag: true = odd, false = even (matches mm.fflag).
export function decodeCPRairborne(
  evenLat: number,
  evenLon: number,
  oddLat: number,
  oddLon: number,
  fflag: boolean,
): CprResult | null {
  const AirDlat0 = 360.0 / 60.0;
  const AirDlat1 = 360.0 / 59.0;
  const lat0 = evenLat;
  const lat1 = oddLat;
  const lon0 = evenLon;
  const lon1 = oddLon;

  const j = Math.floor((59 * lat0 - 60 * lat1) / 131072 + 0.5);
  let rlat0 = AirDlat0 * (cprModInt(j, 60) + lat0 / 131072);
  let rlat1 = AirDlat1 * (cprModInt(j, 59) + lat1 / 131072);

  if (rlat0 >= 270) rlat0 -= 360;
  if (rlat1 >= 270) rlat1 -= 360;

  if (rlat0 < -90 || rlat0 > 90 || rlat1 < -90 || rlat1 > 90) return null;
  if (cprNLFunction(rlat0) !== cprNLFunction(rlat1)) return null;

  let rlat: number;
  let rlon: number;

  if (fflag) {
    const ni = cprNFunction(rlat1, true);
    const m = Math.floor(
      (lon0 * (cprNLFunction(rlat1) - 1) - lon1 * cprNLFunction(rlat1)) / 131072.0 + 0.5,
    );
    rlon = cprDlonFunction(rlat1, true) * (cprModInt(m, ni) + lon1 / 131072);
    rlat = rlat1;
  } else {
    const ni = cprNFunction(rlat0, false);
    const m = Math.floor(
      (lon0 * (cprNLFunction(rlat0) - 1) - lon1 * cprNLFunction(rlat0)) / 131072 + 0.5,
    );
    rlon = cprDlonFunction(rlat0, false) * (cprModInt(m, ni) + lon0 / 131072);
    rlat = rlat0;
  }

  rlon -= Math.floor((rlon + 180) / 360) * 360;

  return { lat: rlat, lon: rlon };
}
