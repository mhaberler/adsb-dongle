# adsb-dongle

Standalone ADS-B receiver dongle: ESP32-C6 (Seeed XIAO) decodes Mode-S
DF17/DF18 extended-squitter frames from a TTL-UART ADS-B receiver module
and emits one JSON object per aircraft, per line (NDJSON) on `Serial`.
No networking, no display — UART in, JSON out.

## Supported modules

Either module works as-is; both output ASCII `*<hex>;` Mode-S frames over
TTL UART at a fixed 921600 8N1, no flow control.

- **Rextron 89001090**
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

## More detail

See [CLAUDE.md](CLAUDE.md) for architecture (reader task, ring buffer,
decoder, aircraft table) and [ADSB.md](ADSB.md) for decoder design
rationale (note: `ADSB.md` describes a related but different MQTT-based
integration — background only, not this repo's I/O contract).
