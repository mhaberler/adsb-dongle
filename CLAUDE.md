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
module `RxD1` (in) → GPIO5. Fixed 921600 8N1, no flow control.
