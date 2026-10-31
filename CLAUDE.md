# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Standalone ADS-B dongle firmware: ESP32-C6 (Seeed XIAO) + Rextron 89001090
Mode-S/ADS-B receiver module, decoding DF17/DF18 extended-squitter frames
and emitting NDJSON (one JSON object per line) on `Serial` at 115200 baud.
No networking, no MQTT, no display — pure UART-in, JSON-out dongle.

Domain vocabulary (Input source, Serial link, Broker feed, Raw frame, ...)
is in `CONTEXT.md`; decisions in `docs/adr/`.

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

No firmware test suite. The webapp has bun unit tests (`cd webapp && bun
test`, see below) that also cover the firmware's decode logic through its
TypeScript port; `src/nic.h` has no Arduino dependency and can be compiled
on the host with `cc` to compare against it.

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
  subtype 0), emergency/squawk (ME28 subtype 1), and NIC-B (ME bit 8 of
  airborne positions). CRC is check-only — no bit-error correction.
- **NIC** (`src/nic.h`, header-only, plain C): `adsb_compute_nic()` turns
  the position type code plus NIC-A (from ME31) and NIC-B into the
  position's integrity category, same mapping as readsb's
  `compute_nic()`; computed when a CPR pair solves, published as `nic`.
  Mirrored in `webapp/src/aircraft-store.ts` `computeNic()` — keep both in
  sync (the webapp's `nav.test.ts` covers the TS side; the C side can be
  compared on the host by compiling `nic.h` with `cc`, it has no
  Arduino dependency).
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
  `lon`, `seen_pos`, `nic`, `version`, `nic_baro`, `nac_p`, `sil`,
  `sil_type`, `gva`, `seen`, `messages`); fields are omitted, not
  zero-filled, until decoded at least once. `category` is readsb's
  emitter category string (`"A3"`: set A-D from type code 4-1, plus ME
  bits 6-8 = libmodes' `mesub`); firmware before that sent the bare
  number `metype - 1`, which the webapp still accepts (shown as the
  generic arrow).
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
manager, no server. Connects over the Web Serial API (or an MQTT broker
feed, see `mqtt-feed.ts`) and plots aircraft on
a Leaflet map (`webapp/src/map.ts`; OSM/OpenTopoMap bases + openflightmaps
overlay, tiles cached offline — see `tile-cache.ts` below).

```sh
cd webapp
bun install
bun dev             # http://localhost:5173
bun run build       # tsc + vite build -> webapp/dist
bun test            # decoder, NIC, display, list, database + geo unit tests, no hardware needed
```

**Two input modes, auto-detected by first line character** (`webapp/src/main.ts`
`handleLine`): `{` → NDJSON from this repo's dongle firmware (parsed by
`protocol.ts` `parseLine`, rendered directly via `map.ts`); `*` → raw
ASCII-hex Mode-S frames from a GNS5892R/Rextron module wired directly to a
USB-UART adapter (921600 baud) — decoded **entirely in the browser**, no
firmware involved. `+SS<hex>;` is also a raw frame (sensorpod RTL-SDR
frames on `ihex`, signal on): `parseRawFrame` strips `SS`,
`parseRawSignal` turns it into a signal level `(SS/255)²` (readsb Beast
scale; a real GNS5892R in mode 3+ may scale it differently — we put it in
`*` mode). `AircraftStore.processFrame(msg, signal)` keeps the last 8
levels per aircraft and emits `rssi` = `10·log10(mean + 1.125e-5)` dBFS,
rounded to 0.1 — identical to readsb and the sensorpod's `ADSB/{icao}`
`rssi`. Kept until eviction; uncalibrated (no dBm, the gain isn't in
`ihex`). Shown in the list (RSSI column, sorted strongest first) and
popup. Tested in `protocol.test.ts` and `nav.test.ts`.

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
  local patches as `lib/libmodes` (DF18 aliasing, ME19 geo−baro
  delta, ME31 opstatus fields, ME28 emergency/squawk, NIC-B) — see comment block
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
- **`tile-cache.ts`** (used only by `map.ts`, so the Android app gets it
  too): offline tile cache on top of
  [`leaflet.offline`](https://github.com/allartk/leaflet.offline)
  (IndexedDB db `leaflet.offline`). `LAYER_DEFS`: bases OSM (default) and
  OpenTopoMap, overlay openflightmaps aero — selection persisted in
  `localStorage` (`adsb.layers`), switched via a stock `L.control.layers`.
  Every layer has `maxNativeZoom` = its `nativeMax` (12; OFM 11), so higher
  zooms are upscaled rather than fetched — keeps offline and online
  behaviour identical. Tiles viewed online are stored passively
  (`tileload` hook). The preload button (`map.ts` `setupCacheControls`)
  downloads the current viewport for all visible layers from the current
  zoom to `nativeMax`, 4 concurrent, refused above
  `MAX_TILES_PER_LAYER` (5000); stored base tiles are skipped, overlay
  tiles always refetched (aero data goes stale — date of last complete
  overlay preload shown in the status line, kept in `localStorage`
  `adsb.aeroPreloadedAt`). No expiry: the delete button wipes everything.
  The library's own `savetiles` control is not used (single-layer only).
  The OFM tile URL is the one openflightmaps' own web map uses, not a
  documented API.
- In raw mode, `main.ts` sends `#49-03\r` once on connect (GNS5892 command
  interface: DF17/18/19-only output mode) to cut the short-frame (DF4/5/
  20/21) traffic the module emits by default — harmless no-op if the
  stream is actually coming through an ESP32 pass-through. Not sent on a
  broker feed.
- **`mqtt-feed.ts`** (`MqttFeed`): broker feed — subscribes to the
  sensorpod's `ihex` topic (`RAW_FRAME_TOPIC`, one `*<hex>;` raw frame per
  message) over MQTT-over-WebSocket and passes each payload to the same
  `handleLine` a serial link feeds, so it lands in the raw-mode decode
  path. `ADSB/<icao>` (decoded JSON) is deliberately not used (ADR 0001).
  mqtt.js resolves to its browser ESM bundle via the `browser` export
  condition — no Node polyfills. After `MAX_RECONNECTS` (3) failed 3 s
  reconnects it ends the client and calls `onLost`. `brokerUrl()` builds
  `ws(s)://host:port` + TXT `path` (default `/mqtt`); `isMixedContent()`
  flags `ws://` from an https page, which browsers block — so the GitHub
  Pages build can only reach `wss://` brokers. Webapp UI: URL field
  (`localStorage` `adsb.mqttUrl`) + MQTT button in the toolbar; serial and
  MQTT are mutually exclusive (`source` in `main.ts`). Used by the app
  too. Tested in `mqtt-feed.test.ts`.
- **`modes.test.ts`**: unit tests using known-good DF17 example frames from
  the [GNS5892 command interface doc](https://www.gns-electronics.de/wp-content/uploads/2019/10/GNS5892-command-interface-V1.0.pdf).
  Expected values were cross-checked by compiling and running
  `lib/libmodes/src/mode-s.c` directly on the same frames (see git history
  for the one-off comparison script) — confirms bit-level parity with the
  firmware decoder, not just internal self-consistency.
- **`map.ts`** (`AircraftMap`): one `Track` per ICAO address with a
  position — marker (rotation, fill colour and label are patched into its
  DOM element per update; the `L.divIcon` is only swapped when the shape
  changes, see `aircraft-shapes.ts`), a per-track `L.layerGroup` (`trail`:
  trail polylines + dead-reckoning tail) inside `trailLayer`, and the lead
  vector. A separate `aircraft` map holds every aircraft heard (also
  without position) for the list. Trails are split into runs per
  1000 ft altitude band (`TRAIL_BAND_FT`, one polyline per run, coloured
  via `getAdsbColor`), capped at `TRAIL_MAX_POINTS` (300) by trimming the
  first run; a new point is only added when lat/lon changed (in raw mode
  `upsert` runs on every frame). Dead reckoning: a 250 ms timer moves each
  marker from the last fix along `track` at `gs` for
  `min(DR_MAX_S, seen_pos + time since receipt)`; `rxMs` is
  `performance.now()` at `upsert`. Popup content is a function
  (`popupHtml`), refreshed via `getPopup().update()` only while open.
  View options (trails/labels/range rings/lead minutes) live in a section
  appended to the stock layer switcher's panel (`setupViewControls`),
  persisted in `localStorage` `adsb.view`; labels are hidden via a
  `no-labels` class on the map container. Range rings (`RINGS_KM`) follow
  `setMyLocation`. The Twemoji flag font is registered from TS via
  `FontFace` (so the app gets it without CSS changes); the `.flag`,
  `.plane-label`, `.ring-label` and view-option CSS is in both style.css
  files.
  FL filter: `setHidden()` takes marker, trail group and lead vector off
  the map for tracks outside `list.band` (re-checked per `upsert` and on
  band change); hidden tracks keep recording and are skipped by the GNSS
  status. Follow: `setFollow()` pans to the aircraft and marks marker and
  row (`following` class); `place()` calls `followPan()`, which only pans
  once the aircraft leaves the inner half of the view; `dragstart` ends
  it.
- **`aircraft-list.ts`** (`AircraftList`): DOM panel appended next to the
  map container (`#app`), so both webapp and app get it without
  index.html changes. Top right on wide screens; at ≤ 600 px a pill at the
  bottom that opens into a bottom sheet and closes on row click (CSS in
  both style.css files, safe-area aware). Re-rendered once a second by
  `AircraftMap` (`LIST_TICK_MS`), not per frame; clicks via delegation on
  `tbody`. Columns Flight/Alt/Speed/Dist/RSSI/GNSS (RSSI sort value is
  negated so the default ascending order = strongest first). Pure, tested
  helpers: `sortRows` (missing values last in both directions), `matchesQuery`, `inBand` (flight levels; no altitude =
  outside an active band). Settings (open, sort, FL band) in
  `localStorage` `adsb.list`. Tested in `aircraft-list.test.ts`.
- **`aircraft-db.ts`** (`AircraftDb`): Mictronics database via
  tar1090-db, downloaded only on the user's click from
  `raw.githubusercontent.com` (CORS `*`; the `github.com/.../raw/...`
  redirect has no CORS header) — deliberately not bundled, not fetched in
  CI and not hosted, so the project doesn't redistribute it. Gunzipped in
  the browser (`DecompressionStream`), parsed line by line (`parseLine`:
  `ICAO;reg;type;flags;model;...`, first flags char `1` = military,
  `Miscode` placeholders skipped) and stored in IndexedDB `adsb.aircraftdb`:
  store `chunks` keyed by the first three hex digits (~1000 used, median
  4 kB, ~25 MB total), store `meta` (date, count, ICAO type table
  `icao_aircraft_types.js` → `kind`/`wtc`). `info(hex)` is synchronous:
  undefined until the chunk is loaded (then fetched in the background;
  the list re-renders every second, markers on their next update).
  Download UI: `map.ts` `setupDbControls`, below the view options.
  `shapeOf(category, info)` falls back to `kind`/`wtc`/`type` where the
  category is missing or generic (A1-A4/A6 only say light/jet). Tested in
  `aircraft-db.test.ts`.
- **`format.ts`**: `esc`, `altOf`, `callsign`, `flightLevel`, `climbArrow`
  shared by map and list.
- **`aircraft-shapes.ts`**: marker SVG per emitter category (`shapeOf`;
  jet/heavy/light/glider/heli/balloon/drone/ground, `arrow` for unknown,
  A0 and old numeric categories). The marker keeps one icon until the
  shape changes (category usually arrives after the first position).
- **`gnss.ts`**: `gnssQuality()` — `ok`/`degraded`/`unusable` from `nic`
  and `nac_p` (version ≥ 1): degraded below NIC 7 or NACp 8, unusable at 0;
  NACp alone if `nic` is missing (older firmware). `map.ts` draws trail
  runs keyed `"gnss"` red dashed while degraded and shows a bottom-left
  status line with the share of degraded aircraft (hidden when none).
- **`geo.ts`**: spherical great-circle helpers (`destPoint`, `distanceKm`),
  tested in `geo.test.ts`.
- **`icao-country.ts`**: ICAO address block → ISO country code, English
  name (`Intl.DisplayNames`) and flag emoji; table from tar1090's
  `flags.js`, first match wins (overlapping blocks ordered specific-first).
  Tested in `icao-country.test.ts`.

Deliberately out of scope for the raw-frame decoder (matches firmware):
DF4/5/20/21 short frames, ME31 subtype 1 (surface), surface (TC 5-8) and
GNSS-height (TC 20-22) positions, containment radius (Rc), bit-error
correction.

## Android / iOS app (`app/`)

Capacitor-wrapped app (Android + iOS). Android was added because the webapp's WebUSB fallback
(above) didn't work with the user's FTDI adapter — Android WebUSB support
for FTDI-class devices is unreliable in practice, even though the API
exists. `app/` uses a **native plugin** instead:
[`@leeskies/capacitor-usb-serial`](https://github.com/LeeSkies/capacitor-usb-serial),
which wraps [mik3y/usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android)
— the same library behind the "Serial USB Terminal" Android app, confirmed
working with this hardware. That plugin is Android-only (its iOS
`Package.swift` product name is also broken), so `capacitor.config.ts`
`ios.includePlugins` leaves it out of the iOS build; iOS is broker feed
only. Every `UsbSerial` call in `main.ts` is behind `HAS_USB`.

**`app/` is a separate top-level project, not a build of `webapp/`.**
It has its own `package.json`/`vite.config.ts`/`index.html`/`src/main.ts`,
but imports the shared decode/map pipeline straight from `../webapp/src`
(`transport.ts`, `protocol.ts`, `modes.ts`, `cpr.ts`, `aircraft-store.ts`,
`mqtt-feed.ts`, `map.ts`, and through it `tile-cache.ts`, `geo.ts`, `icao-country.ts` — via relative imports,
`app/tsconfig.json` `include`s `../webapp/src` and `app/vite.config.ts`
widens dev-server `fs.allow` to reach it). Modules under `../webapp/src`
resolve bare imports from `app/node_modules`, so any dependency they use
(`leaflet`, `leaflet.offline`, `mqtt`) must be listed in **both** `package.json`s.
**`webapp/` is never modified just for the app** — the app only reads
from it; shared code (e.g. `mqtt-feed.ts`) lives there only when the
webapp uses it too. `app/src/style.css` is a copy of webapp's — CSS added
there (e.g. `.tile-status`, the aircraft label/flag/view-option rules) must be copied over by hand — (plus
`env(safe-area-inset-*)` padding for the toolbar/stats since this runs
edge-to-edge in a native shell), and `app/src/main.ts` is a copy of
webapp's `main.ts` with the transport section and geolocation source
swapped for native equivalents — everything else (mode autodetect,
`#49-03\r`, stats overlay, TTL sweep) is identical logic, just re-wired.

```sh
cd app
bun install
bun run sync        # bun run build (tsc + vite) + bunx cap sync (android + ios)
bun run android      # sync + bunx cap run android
bun run ios          # sync + bunx cap run ios
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
- **`main.ts`**: same mode-autodetect/`handleLine` wiring as
  `webapp/src/main.ts`; USB at fixed `BAUD` 921600 via `connectAt` (no
  probe). Input source state machine (`source`: `none`/`usb`/`mqtt`,
  exactly one at a time):
  - Startup: `connectUsb(silent)` (Android), then `rescan()` (mDNS).
    The plugin's `attached` event → `connectUsb`, which replaces a
    broker feed (USB wins). USB unplug / broker lost → `onDisconnect` →
    `autoSelect()` falls back to a broker.
  - `autoSelect()`: remembered broker (`localStorage` `adsb.broker`,
    lowercased instance name) advertised → connect silently; no
    remembered broker → open the picker once the first broker resolves;
    remembered but absent for `REMEMBERED_WAIT_MS` (5 s) → picker. Skipped
    while the picker is open, while `paused`, or after a manual
    disconnect (`manualOff`, cleared by the next tap or a successful
    connect).
  - The button stays a colour LED (no text); the source ("USB 921600",
    "MQTT <broker>") goes into its title/aria-label and a toast.
    Tap connected → disconnect; tap idle → picker.
  - `@capacitor/app` `appStateChange`: on background, end the broker
    feed and stop mDNS (iOS kills sockets anyway); on resume `rescan()`,
    and the remembered broker reconnects. USB untouched. Geolocation uses `@capacitor/geolocation`'s
  `watchPosition` (its callback signature is `(position, err?)`, not the
  two-callback web API) instead of `navigator.geolocation` — the webview's
  built-in geolocation is unreliable inside Capacitor.
- **`broker-discovery.ts`** (`BrokerDiscovery`): `@mhaberler/capacitor-zeroconf-nsd`
  watch on `_mqtt-ws._tcp.`, keeps resolved services only (host =
  `hostname` minus trailing dot, else first IPv4), keyed by lowercased
  instance name (Android NSD lowercases names). `start()` clears the list
  — NSD/Bonjour `removed` events are unreliable, a restart is the
  refresh. Modeled on mdns-mqtt-vue3's `useMqttDiscovery`.
- **`source-picker.ts`** (`SourcePicker`): bottom-sheet modal (CSS in
  `app/src/style.css` only) listing USB (if attached) + brokers;
  refreshed live from `discovery.onChange`.
- **`capacitor.config.ts`**: `server.androidScheme: "http"` +
  `cleartext: true` — an https WebView origin would block `ws://`
  brokers as mixed content (changing the scheme reset the app's
  origin-bound storage once).
- **iOS** (`app/ios`, SPM, `DEVELOPMENT_TEAM` HLX9TTSLFS): `Info.plist`
  has `NSLocalNetworkUsageDescription`, `NSBonjourServices`
  (`_mqtt-ws._tcp`), ATS `NSAllowsLocalNetworking`,
  `NSLocationWhenInUseUsageDescription`, `ITSAppUsesNonExemptEncryption`
  false. Also `NSLocationAlwaysAndWhenInUseUsageDescription`, though the
  app only asks for when-in-use: `@capacitor/geolocation` references the
  always-API, and App Store Connect flags the build (ITMS-90683) without it.
- **Android manifest** (`app/android/app/src/main/AndroidManifest.xml`):
  `<uses-feature android:name="android.hardware.usb.host" android:required="false"/>`
  (`required="false"` so the app still installs on devices without USB
  host mode), `ACCESS_COARSE_LOCATION`/`ACCESS_FINE_LOCATION`,
  `ACCESS_NETWORK_STATE`/`ACCESS_WIFI_STATE`/`CHANGE_WIFI_MULTICAST_STATE`/
  `NEARBY_WIFI_DEVICES` (mDNS), and a
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

CI: `.github/workflows/app-release.yml`, triggered by pushing a `v*` tag
(`git tag v0.1.0 && git push origin v0.1.0`) or `workflow_dispatch`
(artifacts only, no release/TestFlight):
- `android`: debug APK (`./gradlew assembleDebug`), debug-signed only.
- `ios` (macos-latest, newest Xcode): unsigned `xcodebuild archive`, then
  signed at `-exportArchive` with automatic cloud-managed signing via an
  App Store Connect API key (`ci/ExportOptions-export.plist`, team
  HLX9TTSLFS; secrets `ASC_KEY_P8` base64, `ASC_KEY_ID`,
  `ASC_ISSUER_ID`) → IPA; on tags also exported with
  `ci/ExportOptions-upload.plist` = TestFlight upload. Version = tag,
  build number = `github.run_number`. Copied from mdns-mqtt-vue3.
- `release` (tags): APK + IPA → GitHub Release (`softprops/action-gh-release`).
