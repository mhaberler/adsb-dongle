#include "adsb.hpp"

#ifdef ADSB_UART

#include "cpr.h"
#include <ArduinoJson.h>
#include <HardwareSerial.h>
#include <freertos/FreeRTOS.h>
#include <freertos/ringbuf.h>
#include <freertos/task.h>
#include <string.h>

extern "C" {
#include <mode-s.h>
}

// Rextron 89001090 ADS-B receiver module: fixed 921600 8N1 TTL UART,
// no flow control, ASCII frames "*<hex>;" (Mode-S extended squitter DF17
// and DF18), up to ~100 aircraft concurrently. A dedicated reader task
// keeps draining the UART regardless of main-loop stalls (HTTP/OTA/mDNS);
// framed hex lines are handed off through a ring buffer to adsb_loop(),
// which decodes them (libmodes + readsb cpr.c), maintains a per-aircraft
// table, and publishes readsb aircraft.json-style objects per aircraft to
// MQTT topic {hostname}/ADSB/{icao}.

#define ADSB_BAUD 921600
#define ADSB_RX_BUF_SIZE 16384
#define ADSB_RINGBUF_SIZE 8192
#define ADSB_MAX_LINE 32 // "*" + 28 hex chars (112 bit frame) + ";"

#define ADSB_MAX_AIRCRAFT 100
#define ADSB_AIRCRAFT_TTL_MS 60000
#define ADSB_CPR_PAIR_MAX_MS 10000
#define ADSB_PUBLISH_INTERVAL_MS 1000

static HardwareSerial adsb_serial(1);
static RingbufHandle_t adsb_ringbuf;
static uint32_t adsb_dropped_lines = 0;
static uint32_t adsb_dropped_overflow = 0;
static uint32_t adsb_frames_seen = 0;
static uint32_t adsb_crc_fail = 0;
static uint32_t adsb_decoded = 0;

static mode_s_t mode_s_ctx;

struct Aircraft {
  bool used = false;
  uint32_t icao = 0;
  char flight[9] = {0};
  bool has_flight = false;
  int category = -1;
  int alt_baro = 0;
  bool has_alt_baro = false;
  int alt_geom = 0;
  bool has_alt_geom = false;
  int gs = -1; // ground speed, knots
  int track = -1;
  int baro_rate = 0;
  bool has_baro_rate = false;
  int squawk = -1;
  double lat = 0, lon = 0;
  bool has_pos = false;
  uint32_t seen_pos_ms = 0;
  uint32_t messages = 0;

  // Navigation quality (ME31 mesub 0, airborne operational status).
  bool has_opstatus = false;
  int nav_version = -1;
  int nac_p = -1;
  int gva = -1;
  int nic_baro = -1;
  int sil = -1;
  int sil_type = -1;

  // Emergency/priority status (ME28 mesub 1).
  int emergency = -1;

  // CPR pairing state
  bool even_valid = false, odd_valid = false;
  int even_lat = 0, even_lon = 0, odd_lat = 0, odd_lon = 0;
  uint32_t even_ms = 0, odd_ms = 0;

  uint32_t last_seen_ms = 0;
  uint32_t last_published_ms = 0;
  uint32_t messages_at_last_publish = 0;
};

static Aircraft aircraft_table[ADSB_MAX_AIRCRAFT];

static Aircraft *aircraft_find_or_create(uint32_t icao) {
  Aircraft *free_slot = nullptr;
  for (auto &ac : aircraft_table) {
    if (ac.used && ac.icao == icao)
      return &ac;
    if (!ac.used && !free_slot)
      free_slot = &ac;
  }
  if (free_slot) {
    *free_slot = Aircraft();
    free_slot->used = true;
    free_slot->icao = icao;
  }
  return free_slot; // nullptr if table full; frame is then dropped
}

static void adsb_reader_task(void *arg) {
  char line[ADSB_MAX_LINE];
  size_t len = 0;
  bool in_frame = false;

  for (;;) {
    int c = adsb_serial.read();
    if (c < 0) {
      // Nothing pending right now; block briefly to give up the CPU.
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }

    if (c == '*') {
      // Start of a new frame; discard any partial garbage in progress.
      in_frame = true;
      len = 0;
      continue;
    }

    if (!in_frame)
      continue;

    if (c == ';') {
      in_frame = false;
      if (len > 0) {
        if (xRingbufferSend(adsb_ringbuf, line, len, 0) != pdTRUE)
          adsb_dropped_overflow++;
      }
      len = 0;
      continue;
    }

    if (len < ADSB_MAX_LINE) {
      line[len++] = (char)c;
    } else {
      // Frame too long for a Mode-S line; drop it and resync on next '*'.
      in_frame = false;
      len = 0;
      adsb_dropped_lines++;
    }
  }
}

void adsb_setup() {
  adsb_ringbuf = xRingbufferCreate(ADSB_RINGBUF_SIZE, RINGBUF_TYPE_NOSPLIT);
  adsb_serial.setRxBufferSize(ADSB_RX_BUF_SIZE);
  adsb_serial.begin(ADSB_BAUD, SERIAL_8N1, ADSB_RX_PIN, ADSB_TX_PIN);
  xTaskCreate(adsb_reader_task, "adsb_rx", 4096, nullptr, 5, nullptr);

  // Skip mode_s_init(): it only builds the I/Q magnitude LUT for the
  // demodulator (mode_s_detect), which we never call - we feed already
  // demodulated frames straight into mode_s_decode(). Set the config
  // fields it would otherwise set, check-only per project decision.
  memset(&mode_s_ctx, 0, sizeof(mode_s_ctx));
  mode_s_ctx.fix_errors = 0;
  mode_s_ctx.aggressive = 0;
  mode_s_ctx.check_crc = 1;

  log_i("ADS-B UART started at %d baud (rx=%d tx=%d)", ADSB_BAUD, ADSB_RX_PIN,
        ADSB_TX_PIN);
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9')
    return c - '0';
  if (c >= 'A' && c <= 'F')
    return c - 'A' + 10;
  if (c >= 'a' && c <= 'f')
    return c - 'a' + 10;
  return -1;
}

// Decodes an ASCII hex frame in-place into a 14-byte Mode-S buffer.
// Returns the number of bytes decoded, or 0 on malformed hex.
static size_t hex_to_bin(const char *hex, size_t hexlen, unsigned char *out,
                         size_t outcap) {
  size_t n = 0;
  for (size_t i = 0; i + 1 < hexlen && n < outcap; i += 2) {
    int hi = hex_nibble(hex[i]);
    int lo = hex_nibble(hex[i + 1]);
    if (hi < 0 || lo < 0)
      return 0;
    out[n++] = (unsigned char)((hi << 4) | lo);
  }
  return n;
}

static void adsb_process_frame(const char *hex, size_t hexlen) {
  unsigned char msg[14] = {0};
  size_t nbytes = hex_to_bin(hex, hexlen, msg, sizeof(msg));
  if (nbytes < 7) // shorter than any DF17/18 frame can be
    return;

  adsb_frames_seen++;

  struct mode_s_msg mm;
  memset(&mm, 0, sizeof(mm));
  mode_s_decode(&mode_s_ctx, &mm, msg);

  if (!mm.crcok) {
    adsb_crc_fail++;
    return;
  }
  if (mm.msgtype != 17 && mm.msgtype != 18)
    return; // module is expected to only emit these, but be defensive

  uint32_t icao =
      ((uint32_t)mm.aa1 << 16) | ((uint32_t)mm.aa2 << 8) | (uint32_t)mm.aa3;
  Aircraft *ac = aircraft_find_or_create(icao);
  if (!ac)
    return; // table full

  adsb_decoded++;
  uint32_t now = millis();
  ac->last_seen_ms = now;
  ac->messages++;

  if (mm.metype >= 1 && mm.metype <= 4) {
    strncpy(ac->flight, mm.flight, sizeof(ac->flight) - 1);
    ac->category = mm.aircraft_type;
    ac->has_flight = true;
  } else if (mm.metype >= 9 && mm.metype <= 18) {
    // Airborne position: CPR pairing + global decode.
    ac->alt_baro = mm.altitude;
    ac->has_alt_baro = true;

    if (mm.fflag) {
      ac->odd_lat = mm.raw_latitude;
      ac->odd_lon = mm.raw_longitude;
      ac->odd_ms = now;
      ac->odd_valid = true;
    } else {
      ac->even_lat = mm.raw_latitude;
      ac->even_lon = mm.raw_longitude;
      ac->even_ms = now;
      ac->even_valid = true;
    }

    if (ac->even_valid && ac->odd_valid &&
        (uint32_t)abs((int32_t)(ac->even_ms - ac->odd_ms)) <=
            ADSB_CPR_PAIR_MAX_MS) {
      double lat, lon;
      if (decodeCPRairborne(ac->even_lat, ac->even_lon, ac->odd_lat,
                            ac->odd_lon, mm.fflag, &lat, &lon) == 0) {
        ac->lat = lat;
        ac->lon = lon;
        ac->has_pos = true;
        ac->seen_pos_ms = now;
      }
    }
  } else if (mm.metype == 19 && mm.mesub >= 1 && mm.mesub <= 4) {
    ac->baro_rate = mm.vert_rate_sign ? -mm.vert_rate : mm.vert_rate;
    ac->has_baro_rate = true;
    if (mm.mesub == 1 || mm.mesub == 2) {
      ac->gs = mm.velocity;
      ac->track = mm.heading;
    } else if (mm.heading_is_valid) {
      ac->track = mm.heading;
    }
    if (mm.geo_minus_baro_valid && ac->has_alt_baro) {
      int delta =
          mm.geo_minus_baro_sign ? -mm.geo_minus_baro : mm.geo_minus_baro;
      ac->alt_geom = ac->alt_baro + delta;
      ac->has_alt_geom = true;
    }
  } else if (mm.metype == 31 && mm.mesub == 0 && mm.opstatus_valid) {
    ac->has_opstatus = true;
    ac->nav_version = mm.opstatus_version;
    if (mm.nac_p_valid)
      ac->nac_p = mm.nac_p;
    if (mm.gva_valid)
      ac->gva = mm.gva;
    if (mm.nic_baro_valid)
      ac->nic_baro = mm.nic_baro;
    if (mm.sil_valid) {
      ac->sil = mm.sil;
      ac->sil_type = mm.sil_type;
    }
  } else if (mm.metype == 28 && mm.mesub == 1) {
    if (mm.es_emergency_valid)
      ac->emergency = mm.es_emergency;
    if (mm.es_squawk_valid)
      ac->squawk = mm.es_squawk;
  }
  // DF4/5/20/21 squawk fields are not decoded (DF17/18 module output only,
  // ME28 mesub 1 above is the only DF17/18 source of squawk).
}

static void icao_to_hex(uint32_t icao, char *out /* 7 bytes */) {
  snprintf(out, 7, "%06x", (unsigned)icao);
}

static void adsb_publish_aircraft(Aircraft &ac, uint32_t now) {
  JsonDocument doc;
  char hex[7];
  icao_to_hex(ac.icao, hex);
  doc["hex"] = hex;
  if (ac.has_flight)
    doc["flight"] = ac.flight;
  if (ac.category >= 0)
    doc["category"] = ac.category;
  if (ac.has_alt_baro)
    doc["alt_baro"] = ac.alt_baro;
  if (ac.has_alt_geom)
    doc["alt_geom"] = ac.alt_geom;
  if (ac.gs >= 0)
    doc["gs"] = ac.gs;
  if (ac.track >= 0)
    doc["track"] = ac.track;
  if (ac.has_baro_rate)
    doc["baro_rate"] = ac.baro_rate;
  if (ac.squawk >= 0) {
    char squawk_hex[5];
    snprintf(squawk_hex, sizeof(squawk_hex), "%04x", (unsigned)ac.squawk);
    doc["squawk"] = squawk_hex;
  }
  if (ac.emergency >= 0) {
    static const char *emergency_names[] = {"none",    "general", "lifeguard",
                                            "minfuel", "nordo",   "unlawful",
                                            "downed",  "reserved"};
    doc["emergency"] = emergency_names[ac.emergency < 8 ? ac.emergency : 7];
  }
  if (ac.has_pos) {
    doc["lat"] = ac.lat;
    doc["lon"] = ac.lon;
    doc["seen_pos"] = (now - ac.seen_pos_ms) / 1000.0;
  }
  if (ac.has_opstatus) {
    doc["version"] = ac.nav_version;
    if (ac.nic_baro >= 0)
      doc["nic_baro"] = ac.nic_baro;
    if (ac.nac_p >= 0)
      doc["nac_p"] = ac.nac_p;
    if (ac.sil >= 0) {
      doc["sil"] = ac.sil;
      doc["sil_type"] = ac.sil_type ? "persample" : "perhour";
    }
    if (ac.gva >= 0)
      doc["gva"] = ac.gva;
  }
  doc["seen"] = (now - ac.last_seen_ms) / 1000.0;
  doc["messages"] = ac.messages;

  String payload;
  serializeJson(doc, payload);
  Serial.println(payload);

  ac.last_published_ms = now;
  ac.messages_at_last_publish = ac.messages;
}

static void adsb_publish_tombstone(Aircraft &ac) {
  char hex[7];
  icao_to_hex(ac.icao, hex);
  JsonDocument doc;
  doc["hex"] = hex;
  doc["expired"] = true;
  String payload;
  serializeJson(doc, payload);
  Serial.println(payload);
}

static void adsb_table_loop() {
  uint32_t now = millis();

  for (auto &ac : aircraft_table) {
    if (!ac.used)
      continue;

    if (now - ac.last_seen_ms > ADSB_AIRCRAFT_TTL_MS) {
      adsb_publish_tombstone(ac);
      ac = Aircraft();
      continue;
    }

    if (now - ac.last_published_ms >= ADSB_PUBLISH_INTERVAL_MS &&
        ac.messages != ac.messages_at_last_publish) {
      adsb_publish_aircraft(ac, now);
    }
  }
}

static void adsb_publish_stats() {
  AdsbStats s = adsb_get_stats();
  JsonDocument doc;
  doc["frames_seen"] = s.frames_seen;
  doc["crc_fail"] = s.crc_fail;
  doc["decoded"] = s.decoded;
  doc["dropped_lines"] = s.dropped_lines;
  doc["dropped_overflow"] = s.dropped_overflow;
  doc["aircraft_count"] = s.aircraft_count;
  String payload;
  serializeJson(doc, payload);
  Serial.println(payload);
}

void adsb_loop() {
  size_t item_size = 0;
  void *item = xRingbufferReceive(adsb_ringbuf, &item_size, 0);
  if (item) {
    adsb_process_frame((const char *)item, item_size);
    vRingbufferReturnItem(adsb_ringbuf, item);
  }

  uint32_t now = millis();

  static uint32_t last_table_tick = 0;
  if (now - last_table_tick >= 250) {
    last_table_tick = now;
    adsb_table_loop();
  }

  static uint32_t last_stats_tick = 0;
  if (now - last_stats_tick >= 5000) {
    last_stats_tick = now;
    adsb_publish_stats();
  }
}

AdsbStats adsb_get_stats() {
  AdsbStats s;
  s.frames_seen = adsb_frames_seen;
  s.crc_fail = adsb_crc_fail;
  s.decoded = adsb_decoded;
  s.dropped_lines = adsb_dropped_lines;
  s.dropped_overflow = adsb_dropped_overflow;
  uint32_t count = 0;
  for (auto &ac : aircraft_table)
    if (ac.used)
      count++;
  s.aircraft_count = count;
  return s;
}

#endif // ADSB_UART
