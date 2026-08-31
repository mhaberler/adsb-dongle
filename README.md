# adsb-dongle

Standalone ADS-B receiver dongle: ESP32-C6 (Seeed XIAO) decodes Mode-S
DF17/DF18 extended-squitter frames from a TTL-UART ADS-B receiver module
and emits one JSON object per aircraft, per line (NDJSON) on `Serial`.
No networking, no display — UART in, JSON out.

## Supported modules

Either module works as-is; both output ASCII `*<hex>;` Mode-S frames over
TTL UART at a fixed 921600 8N1, no flow control.

- **Rextron 89001090**, [Technical datasheet](https://rextronaviation.weebly.com/uploads/1/3/1/2/131270069/89001090_technical.pdf)
- **GNS5892R**, [Datasheet V13](https://www.gns-electronics.de/wp-content/uploads/2026/04/GNS5892R_ADSBModul_datasheet_V13.pdf)

## Wiring

| Module pin | ESP32-C6 GPIO |
|---|---|
| 3V3 | 3V3 |
| GND | GND |
| TxD (module out) | GPIO19 (RX) |
| RxD (module in)  | GPIO5 (TX) |

## Build / flash / monitor

PlatformIO project, single env `seed-xiao-c6-adsb` (default).

```sh
pio run                        # build
pio run -t upload              # flash
pio device monitor             # serial monitor (115200 baud) — NDJSON output
pio run -t upload -t monitor   # flash then monitor
```

## Example output

Per-aircraft object, published on-change, at most once per second:

```json
{"hex":"40621d","flight":"BAW123  ","category":3,"alt_baro":37000,"gs":412,"track":271,"baro_rate":-64,"lat":51.4712,"lon":-0.4589,"seen_pos":0.8,"version":2,"nic_baro":1,"nac_p":9,"sil":3,"sil_type":"perhour","gva":2,"seen":0.2,"messages":184}
```

Tombstone, published once when an aircraft hasn't sent a message for 60 s
(then the slot is freed):

```json
{"hex":"40621d","expired":true}
```

Receiver-wide stats, published every 5 s:

```json
{"frames_seen":15234,"crc_fail":312,"decoded":14899,"dropped_lines":0,"dropped_overflow":0,"aircraft_count":7}
```

Fields are omitted (not zero/null-filled) until decoded at least once —
e.g. `lat`/`lon`/`seen_pos` only appear after a valid even/odd CPR pair,
`squawk`/`emergency` only if the aircraft sends an emergency/priority
status message. See [CLAUDE.md](CLAUDE.md) for the full field list and
decoder internals.

## Web viewer

`webapp/` is a browser-only ADS-B viewer: connects to the dongle over the
[Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
(no server, no native app) and plots live aircraft on a Leaflet/OpenStreetMap
map, styled after [airplanejs](https://github.com/watson/airplanejs). Built
with Vite + vanilla TypeScript.

```sh
cd webapp
bun install
bun dev             # http://localhost:5173, click Connect and pick the dongle's serial port
bun run build       # production build to webapp/dist
bun test            # decoder unit tests (no hardware needed)
```

Requires a Chromium-based browser. On desktop this uses the
[Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
(not supported in Firefox/Safari). **Android Chrome has no Web Serial API
at all**, so there the webapp falls back to
[WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) with
two small hand-rolled drivers (`webapp/src/transport-ftdi.ts`,
`webapp/src/transport-cdcacm.ts` — no external dependency): an FTDI
FT230X/FT232R driver for the direct-wired module, and a CDC-ACM driver for
the ESP32 dongle. The Connect button picks whichever API the browser has;
no separate mode to choose. The FTDI path is the reliable one on Android —
the CDC-ACM path only works if Android's own kernel `cdc_acm` driver
hasn't already claimed the ESP32's interface, which fails with a clear
"unable to claim interface" error when it happens (nothing the webapp can
do about that from the browser).

The webapp works with two kinds of serial source, auto-detected by line
shape (no separate mode to pick):

- **The ESP32 dongle** (this repo's firmware) at 115200 baud, streaming the
  decoded NDJSON described above.
- **A GNS5892R/Rextron module wired directly to a USB-UART adapter**
  (e.g. an FTDI **FT230X** breakout — see [Jim's FTDI FT-X errata notes](https://jim.sh/ftx/#click-ftdi-errata)
  for known FT-X quirks) at 921600 baud, streaming raw ASCII-hex Mode-S
  frames (`*<28 hex chars>;`, per the
  [GNS5892 command interface doc](https://www.gns-electronics.de/wp-content/uploads/2019/10/GNS5892-command-interface-V1.0.pdf)).
  No ESP32 involved — the adapter's USB-CDC port is opened directly via
  Web Serial. In this mode the webapp does the full decode in-browser — a
  TypeScript port of this repo's own firmware decode path
  (`webapp/src/modes.ts`, `webapp/src/cpr.ts`, `webapp/src/aircraft-store.ts`;
  see [CLAUDE.md](CLAUDE.md) for details) — and sends `#49-03\r` on connect
  to put the module in DF17/18/19-only output mode.

Connect auto-probes 115200 then 921600 to find whichever source is
plugged in.

![Directly decoding hex messages in-browser](assets/Screenshot%202026-08-31%20at%2009.23.21.png)

*Directly decoding hex messages in-browser*

## More detail

See [CLAUDE.md](CLAUDE.md) for architecture (reader task, ring buffer,
decoder, aircraft table) and [ADSB.md](ADSB.md) for decoder design
rationale (note: `ADSB.md` describes a related but different MQTT-based
integration — background only, not this repo's I/O contract).
