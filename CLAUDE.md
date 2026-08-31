# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Standalone ADS-B dongle firmware: ESP32-C6 (Seeed XIAO) + Rextron 89001090
Mode-S/ADS-B receiver module, decoding DF17/DF18 extended-squitter frames
and emitting NDJSON (one JSON object per line) on `Serial` at 115200 baud.
No networking, no MQTT, no display — pure UART-in, JSON-out dongle.

Note: `ADSB.md` in this repo describes a different, related integration
(MQTT publish, `{hostname}/ADSB/{icao}` topics, m5stack-nanoc6/esp32p4-waveshare
envs, GPIO52/53) from a sibling "sensorpod" project. That doc does not match
this repo's actual `platformio.ini` (env `seed-xiao-c6-adsb`, ESP32-C6,
GPIO19/5, Serial NDJSON output) — treat it as background/design rationale
for the decoder internals, not as this repo's I/O contract.

## Build / flash / monitor

PlatformIO project, single env `seed-xiao-c6-adsb` (default).

```sh
pio run                # build
pio run -t upload      # flash
pio device monitor     # serial monitor (115200 baud) — NDJSON output appears here
pio run -t upload -t monitor   # flash then monitor
```

No test suite in this repo.

## Architecture

`src/main.cpp` is a thin shell: `setup()` calls `adsb_setup()`, `loop()` calls
`adsb_loop()`. All logic lives in `src/adsb.cpp` (gated behind `-DADSB_UART`,
always set for this env — effectively always compiled in for this project).

**Pipeline**: UART reader task → ring buffer → `adsb_loop()` (decode +
aircraft table + publish), all in `src/adsb.cpp`.

- **Reader task** (`adsb_reader_task`, FreeRTOS task, prio 5): blocks on
  `Serial1.read()` from the Rextron module (921600 8N1, GPIO19 RX / GPIO5 TX,
  set via `ADSB_RX_PIN`/`ADSB_TX_PIN` build flags), frames `*<hex>;` ASCII
  lines, pushes raw hex payloads into a `RingbufHandle_t` (8 KB,
  `RINGBUF_TYPE_NOSPLIT`). Runs independent of the Arduino `loop()` so it
  can't be starved by main-loop stalls.
- **`adsb_loop()`** (called every Arduino `loop()` iteration): drains the
  ring buffer non-blocking, hex→binary, decodes via `mode_s_decode()`
  (`lib/libmodes`), updates the aircraft table every 250 ms, and emits stats
  every 5 s.
- **Decoder**: `lib/libmodes/` is a vendored, patched copy of
  [Displacer/libmodes](https://github.com/Displacer/libmodes) (BSD-2-Clause).
  Only `mode_s_decode()` is used — frames arrive already demodulated from the
  module, so no demodulator/magnitude-vector code runs and `mode_s_init()` is
  skipped. Local patches (documented in a comment at the top of
  `lib/libmodes/include/mode-s.h`): DF18 aliased into the DF17 ME-decode
  path, geometric-altitude delta (ME19), Operational Status fields (ME31
  subtype 0), and emergency/squawk (ME28 subtype 1). CRC is check-only —
  no bit-error correction.
- **CPR position solve**: `src/cpr.c`/`src/cpr.h` — readsb's CPR solver
  ported verbatim (GPL-3). Only `decodeCPRairborne()` (global, even/odd
  frame pair) is used — no receiver-reference-position / local CPR, since
  the receiver is mobile.
- **Aircraft table** (`Aircraft` struct + `aircraft_table[]` in `adsb.cpp`):
  static array of 100 entries keyed by ICAO address, linear scan. Evicted
  60 s after last message (`ADSB_AIRCRAFT_TTL_MS`), publishing a tombstone
  (`{"hex":..., "expired":true}`) on eviction. Per-aircraft JSON published
  at most once per second, only when new messages arrived since the last
  publish (on-change, not a fixed heartbeat) — mirrors readsb's
  `aircraft.json` field names (`hex`, `flight`, `category`, `alt_baro`,
  `alt_geom`, `gs`, `track`, `baro_rate`, `squawk`, `emergency`, `lat`,
  `lon`, `seen_pos`, `version`, `nic_baro`, `nac_p`, `sil`, `sil_type`,
  `gva`, `seen`, `messages`); fields are omitted, not zero-filled, until
  decoded at least once.
- **Stats**: `adsb_get_stats()`/`AdsbStats` (declared in `src/adsb.hpp`)
  expose frame/decode/drop counters and live aircraft count; published as
  their own NDJSON line every 5 s from `adsb_loop()`.

## Key constants (`src/adsb.cpp`)

- `ADSB_BAUD` 921600, `ADSB_MAX_LINE` 32 (`*` + 28 hex chars + `;`)
- `ADSB_MAX_AIRCRAFT` 100, `ADSB_AIRCRAFT_TTL_MS` 60000
- `ADSB_CPR_PAIR_MAX_MS` 10000, `ADSB_PUBLISH_INTERVAL_MS` 1000

## Wiring

Rextron 89001090 module ↔ ESP32-C6: 3V3/GND, module `TxD1` (out) → GPIO19,
module `RxD1` (in) → GPIO5. Fixed 921600 8N1, no flow control. Also works
with a GNS5892R module (see README.md for datasheet link).

## Web viewer (`webapp/`)

Browser-only ADS-B map viewer — Vite + vanilla TypeScript, bun package
manager, no server. Connects over the Web Serial API and plots aircraft on
a Leaflet/OSM map (`webapp/src/map.ts`).

```sh
cd webapp
bun install
bun dev             # http://localhost:5173
bun run build       # tsc + vite build -> webapp/dist
bun test            # decoder unit tests, no hardware needed
```

**Two input modes, auto-detected by first line character** (`webapp/src/main.ts`
`handleLine`): `{` → NDJSON from this repo's dongle firmware (parsed by
`protocol.ts` `parseLine`, rendered directly via `map.ts`); `*` → raw
ASCII-hex Mode-S frames from a GNS5892R/Rextron module wired directly to a
USB-UART adapter (921600 baud) — decoded **entirely in the browser**, no
firmware involved.

**Transport layer** (`transport.ts` + three `transport-*.ts` drivers):
`navigator.serial` (Web Serial) exists only on desktop Chrome/Edge —
**Android Chrome has no Web Serial API at all** — so `main.ts`
`requestTransport()` falls back to WebUSB (`navigator.usb`) there:

- **`transport.ts`**: `ByteTransport` interface (`open`/`close`/`read`/
  `write`/`setOnDisconnect`) all three drivers implement, plus `LineReader`
  — the transport-agnostic baud auto-probe (opens at each rate in the
  caller-supplied `probeOrder`, watches `PROBE_WINDOW_MS` (2 s) for a line
  matching `isValidLine`) and NDJSON/raw-frame line-splitting logic,
  shared across all three transports.
- **`transport-webserial.ts`**: thin `ByteTransport` wrapper around
  `navigator.serial` (desktop). `requestWebSerialTransport()` calls
  `requestPort()`.
- **`transport-ftdi.ts`**: hand-rolled WebUSB driver for FTDI FT230X/
  FT232R-family chips (the FTDI USB-UART adapter used to wire a module
  directly, per README.md) — no vendor SDK, protocol is the well-known
  open reverse-engineered one (same as Linux `ftdi_sio`/libftdi/pyftdi).
  `ftdiBaudDivisor()` computes the SET_BAUDRATE vendor-request value/index
  pair (48 MHz-base encode_baudrate algorithm; cross-checked against
  FTDI's published AN232B-05 divisor table for the two rates this app
  uses — 921600 → 0x8003, 115200 → 0x001A — see `transport-ftdi.test.ts`).
  `stripFtdiStatusBytes()` removes the 2-byte modem-status header FTDI
  prepends to **every** USB packet (every 64-byte stride within a bulk-IN
  transfer, not just the start of the buffer).
- **`transport-cdcacm.ts`**: WebUSB driver for USB CDC-ACM devices (this
  repo's ESP32 dongle, `ARDUINO_USB_CDC_ON_BOOT`). Claims both the CDC
  comm interface (class 2, for SET_LINE_CODING/SET_CONTROL_LINE_STATE)
  and the CDC data interface (class 10, for bulk transfers); asserts
  DTR+RTS on open, same as the Arduino CDC stack expects from a serial
  monitor. **Caveat**: only works if Android's own kernel `cdc_acm`
  driver hasn't already claimed the interface — if it has,
  `claimInterface()` throws and that error propagates up to the
  toolbar's connect-error display (`connStatus.textContent`) rather than
  failing silently; nothing further can be done about it from the
  browser (WebUSB can't detach a bound kernel driver).

`main.ts` `requestTransport()`: Web Serial when present (desktop) →
probe order `[115200, 921600]`; else WebUSB device picker filtered to
FTDI vendor ID (0x0403), CDC comm class, or composite/IAD class, then
`FtdiTransport.matches(device)` picks the FTDI driver vs. CDC-ACM →
probe order `[921600, 115200]` (Android + WebUSB is assumed to mean the
direct-wired module, not the dongle).

- **`modes.ts`**: TypeScript port of the **decode half** of
  `lib/libmodes/src/mode-s.c` (CRC table + `mode_s_decode()`), restricted
  to DF17 + DF18 CF 0/1/2/6 (same scope as the firmware) — the demodulator
  code (`mode_s_detect`, magnitude vectors) is not ported since input
  frames arrive already framed, same as the firmware. Carries the same
  four local patches as `lib/libmodes` (DF18 aliasing, ME19 geo−baro
  delta, ME31 opstatus fields, ME28 emergency/squawk) — see comment block
  at top of `lib/libmodes/include/mode-s.h` for patch details, which apply
  identically here. CRC is check-only, matching firmware config
  (`fix_errors=0`, `aggressive=0`).
- **`cpr.ts`**: verbatim port of `src/cpr.c`'s `decodeCPRairborne()` (global
  airborne solve only, same as firmware).
- **`aircraft-store.ts`**: browser-side equivalent of the firmware's
  `Aircraft` table (`src/adsb.cpp`) — keyed by ICAO in a `Map` (no 100-slot
  cap, unlike the firmware's static array), same 60 s TTL eviction and CPR
  even/odd pairing (10 s window), same `aircraft.json`-style field
  omission rules. Feeds `AircraftMessage`/removal events straight into the
  same `map.ts` used by the NDJSON path — both input modes converge on one
  rendering pipeline. Unlike the firmware there's no per-aircraft publish
  throttle (browser has no serial-bandwidth constraint); marker updates
  happen on every decoded frame.
- In raw mode, `main.ts` sends `#49-03\r` once on connect (GNS5892 command
  interface: DF17/18/19-only output mode) to cut the short-frame (DF4/5/
  20/21) traffic the module emits by default — harmless no-op if the
  stream is actually coming through an ESP32 pass-through.
- **`modes.test.ts`**: unit tests using known-good DF17 example frames from
  the [GNS5892 command interface doc](https://www.gns-electronics.de/wp-content/uploads/2019/10/GNS5892-command-interface-V1.0.pdf).
  Expected values were cross-checked by compiling and running
  `lib/libmodes/src/mode-s.c` directly on the same frames (see git history
  for the one-off comparison script) — confirms bit-level parity with the
  firmware decoder, not just internal self-consistency.

Deliberately out of scope for the raw-frame decoder (matches firmware):
DF4/5/20/21 short frames, ME31 subtype 1 (surface), position-derived
NIC/RC, bit-error correction.

## Android app (`app/`)

Capacitor-wrapped Android app, added because the webapp's WebUSB fallback
(above) didn't work with the user's FTDI adapter — Android WebUSB support
for FTDI-class devices is unreliable in practice, even though the API
exists. `app/` uses a **native plugin** instead:
[`@leeskies/capacitor-usb-serial`](https://github.com/LeeSkies/capacitor-usb-serial),
which wraps [mik3y/usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android)
— the same library behind the "Serial USB Terminal" Android app, confirmed
working with this hardware. Android-only (no iOS target; the underlying
library is Android-only).

**`app/` is a separate top-level project, not a build of `webapp/`.**
It has its own `package.json`/`vite.config.ts`/`index.html`/`src/main.ts`,
but imports the shared decode/map pipeline straight from `../webapp/src`
(`transport.ts`, `protocol.ts`, `modes.ts`, `cpr.ts`, `aircraft-store.ts`,
`map.ts` — via relative imports, `app/tsconfig.json` `include`s
`../webapp/src` and `app/vite.config.ts` widens dev-server `fs.allow` to
reach it). **`webapp/` itself is never modified for the app** — the app
only reads from it. `app/src/style.css` is a copy of webapp's (plus
`env(safe-area-inset-*)` padding for the toolbar/stats since this runs
edge-to-edge in a native shell), and `app/src/main.ts` is a copy of
webapp's `main.ts` with the transport section and geolocation source
swapped for native equivalents — everything else (mode autodetect,
`#49-03\r`, stats overlay, TTL sweep) is identical logic, just re-wired.

```sh
cd app
bun install
bun run sync        # bun run build (tsc + vite) + bunx cap sync android
bun run android      # sync + bunx cap run android
```

Always use `bun`/`bunx`, never `npm`/`npx`, for anything in this repo.

- **`transport-native.ts`**: `ByteTransport` over the plugin. `open(baud)`
  opens the port, `setParameters` (baud/8N1), asserts DTR+RTS (same
  reason as the webapp's CDC-ACM driver — the ESP32's Arduino CDC stack
  buffers output until DTR is seen), then `startReading` and attaches a
  `data` listener. The plugin delivers bytes as base64-encoded chunks via
  events (not a pull-based stream), so `read()` is backed by a small
  async push/pull queue: the `data` listener pushes decoded
  `Uint8Array`s, `read()` awaits the next one. `pickDevice()`/
  `requestNativeTransport()` picks the first attached device (this app
  assumes one adapter plugged in at a time) and requests permission.
- **`main.ts`**: same `LineReader`/mode-autodetect wiring as
  `webapp/src/main.ts`, but `requestTransport()` is unconditional (native
  only, no platform branching) with probe order `[921600, 115200]`
  (FTDI-wired module is the primary case). Adds **auto-connect**: tries
  `connect(silent: true)` on startup and on the plugin's `attached`
  event, swallowing "no device" errors; a manual Connect click surfaces
  errors normally. Geolocation uses `@capacitor/geolocation`'s
  `watchPosition` (its callback signature is `(position, err?)`, not the
  two-callback web API) instead of `navigator.geolocation` — the webview's
  built-in geolocation is unreliable inside Capacitor.
- **Android manifest** (`app/android/app/src/main/AndroidManifest.xml`):
  `<uses-feature android:name="android.hardware.usb.host" android:required="false"/>`
  (`required="false"` so the app still installs on devices without USB
  host mode), `ACCESS_COARSE_LOCATION`/`ACCESS_FINE_LOCATION`, and a
  `USB_DEVICE_ATTACHED` intent-filter + `device_filter.xml` meta-data on
  `MainActivity` so plugging in a matching device offers to launch the
  app with permission pre-granted.
- **`res/xml/device_filter.xml`**: vendor-ID filter for auto-launch —
  decimal `1027` (0x0403, FTDI) and `12346` (0x303A, Espressif/ESP32-C6).
- **`android/build.gradle`**: adds the **JitPack** Maven repo
  (`https://jitpack.io`) at the `allprojects` level — required because
  `mik3y/usb-serial-for-android` (the plugin's underlying dependency) is
  published there, not on Maven Central/Google's repo. Omitting this
  fails `:app:checkDebugAarMetadata` with "Could not find
  com.github.mik3y:usb-serial-for-android" — this was hit and fixed
  during initial setup, not a hypothetical.
- **minSdk 24** in `android/variables.gradle` — required by the plugin;
  already the Capacitor-template default here, left unchanged.

CI: `.github/workflows/android-apk.yml` builds a debug APK
(`./gradlew assembleDebug` after `bun run sync`) on pushes touching
`app/**` or `webapp/src/**`, uploaded as a workflow artifact. Debug-signed
only, no release signing configured.
