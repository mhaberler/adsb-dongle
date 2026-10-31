import "./style.css";
import { LineReader, type ByteTransport } from "./transport";
import { requestWebSerialTransport } from "./transport-webserial";
import { FtdiTransport } from "./transport-ftdi";
import { CdcAcmTransport } from "./transport-cdcacm";
import { classifyLine, parseLine, parseRawFrame, parseRawSignal } from "./protocol";
import type { StatsMessage } from "./protocol";
import { AircraftMap } from "./map";
import { AircraftStore } from "./aircraft-store";
import { MqttFeed, RAW_FRAME_TOPIC, isMixedContent } from "./mqtt-feed";

const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const connStatus = document.querySelector<HTMLSpanElement>("#conn-status")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;
const geoStatus = document.querySelector<HTMLSpanElement>("#geo-status")!;
const mqttBtn = document.querySelector<HTMLButtonElement>("#mqtt-btn")!;
const mqttUrl = document.querySelector<HTMLInputElement>("#mqtt-url")!;

const MQTT_URL_KEY = "adsb.mqttUrl";
mqttUrl.value = localStorage.getItem(MQTT_URL_KEY) ?? "ws://esp32p4-e185df.local:8080/mqtt";

const map = new AircraftMap("map");
const lineReader = new LineReader();
const mqttFeed = new MqttFeed();

// Exactly one input source at a time: a serial link or a broker feed.
type Source = "none" | "serial" | "mqtt";
let source: Source = "none";

// Web Serial (navigator.serial) is desktop-only - Android Chrome has no
// such API at all, so there we fall back to WebUSB with hand-rolled
// FTDI and CDC-ACM drivers (transport-ftdi.ts, transport-cdcacm.ts).
// Baud probe order favors the direct-wired module's 921600 on the WebUSB
// path (Android + WebUSB almost always means the FTDI-adapted module, not
// the ESP32 dongle) and the dongle's 115200 first on Web Serial (desktop).
async function requestTransport(): Promise<{ transport: ByteTransport; probeOrder: number[] }> {
  if (navigator.serial) {
    return { transport: await requestWebSerialTransport(), probeOrder: [115200, 921600] };
  }
  if (navigator.usb) {
    const device = await navigator.usb.requestDevice({
      filters: [
        { vendorId: 0x0403 }, // FTDI
        { classCode: 0x02 }, // CDC comm interface
        { classCode: 0xef }, // composite/IAD (covers most CDC-ACM boards)
      ],
    });
    const transport: ByteTransport = FtdiTransport.matches(device)
      ? new FtdiTransport(device)
      : new CdcAcmTransport(device);
    return { transport, probeOrder: [921600, 115200] };
  }
  throw new Error("No Web Serial or WebUSB support in this browser");
}

if ("geolocation" in navigator) {
  let geoFailStreak = 0;
  navigator.geolocation.watchPosition(
    (pos) => {
      geoFailStreak = 0;
      map.setMyLocation(pos.coords.latitude, pos.coords.longitude);
      geoStatus.textContent = "";
    },
    (err) => {
      // PERMISSION_DENIED(1) / POSITION_UNAVAILABLE(2) / TIMEOUT(3).
      // watchPosition keeps retrying on its own for 2/3; only 1 is final.
      // A first-fix TIMEOUT/POSITION_UNAVAILABLE is common while the OS
      // location backend warms up, so don't alarm on a single miss.
      geoFailStreak++;
      if (err.code === GeolocationPositionError.PERMISSION_DENIED || geoFailStreak >= 3) {
        geoStatus.textContent = `location: ${err.message}`;
      }
    },
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 },
  );
} else {
  geoStatus.textContent = "location: not supported";
}

type StreamMode = "unknown" | "ndjson" | "raw";
let mode: StreamMode = "unknown";
let rawCommandSent = false;
const rawStore = new AircraftStore();
let sweepTimer: number | undefined;
let statsTimer: number | undefined;

function renderStats(s: StatsMessage): void {
  statsEl.textContent = [
    `frames: ${s.frames_seen}`,
    `crc_fail: ${s.crc_fail}`,
    `decoded: ${s.decoded}`,
    `dropped: ${s.dropped_lines + s.dropped_overflow}`,
    `aircraft: ${s.aircraft_count}`,
  ].join("\n");
}

function setSource(next: Source): void {
  source = next;
  connStatus.textContent =
    next === "serial" ? "connected" : next === "mqtt" ? `MQTT ${RAW_FRAME_TOPIC}` : "disconnected";
  connectBtn.textContent = next === "serial" ? "Disconnect" : "Connect";
  mqttBtn.textContent = next === "mqtt" ? "Disconnect MQTT" : "MQTT";
}

// Used only during baud auto-probe: a line is "valid" if it's a recognized
// stream shape (NDJSON, raw frame, or a module command reply).
function isRecognizedLine(line: string): boolean {
  return classifyLine(line) !== "unknown";
}

function handleNdjsonLine(line: string): void {
  const msg = parseLine(line);
  if (!msg) return;

  switch (msg.kind) {
    case "aircraft":
      map.upsert(msg.data);
      break;
    case "tombstone":
      map.remove(msg.data.hex);
      break;
    case "stats":
      renderStats(msg.data);
      break;
  }
}

function handleRawLine(line: string): void {
  const kind = classifyLine(line);
  if (kind !== "rawframe") return; // ignore command-reply / unknown lines

  const frame = parseRawFrame(line);
  if (!frame) {
    rawStore.recordDroppedLine();
    return;
  }

  for (const event of rawStore.processFrame(frame, parseRawSignal(line))) {
    if (event.kind === "update") map.upsert(event.data);
    else map.remove(event.hex);
  }
}

function handleLine(line: string): void {
  if (mode === "unknown") {
    const kind = classifyLine(line);
    if (kind === "ndjson") mode = "ndjson";
    else if (kind === "rawframe") mode = "raw";
    else return; // command-reply / unknown before we've locked a mode
  }

  if (mode === "ndjson") {
    handleNdjsonLine(line);
  } else if (mode === "raw") {
    if (!rawCommandSent && source === "serial") {
      rawCommandSent = true;
      // GNS5892 command interface: "#49-03<CR>" = DF17/18/19-only output
      // mode. Harmless no-op if this line actually came via an ESP32
      // pass-through rather than a directly-wired module.
      void lineReader.write("#49-03\r");
    }
    handleRawLine(line);

    if (statsTimer === undefined) {
      statsTimer = window.setInterval(() => renderStats(rawStore.getStats()), 5000);
    }
    if (sweepTimer === undefined) {
      sweepTimer = window.setInterval(() => {
        for (const event of rawStore.sweep()) {
          if (event.kind === "remove") map.remove(event.hex);
        }
      }, 1000);
    }
  }
}

function resetState(): void {
  mode = "unknown";
  rawCommandSent = false;
  if (sweepTimer !== undefined) {
    window.clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
  if (statsTimer !== undefined) {
    window.clearInterval(statsTimer);
    statsTimer = undefined;
  }
}

function onDisconnect(): void {
  setSource("none");
  statsEl.textContent = "";
  resetState();
}

async function disconnectSource(): Promise<void> {
  if (source === "serial") await lineReader.disconnect();
  else if (source === "mqtt") mqttFeed.disconnect();
  if (source !== "none") onDisconnect();
}

connectBtn.addEventListener("click", async () => {
  if (source === "serial") {
    await disconnectSource();
    return;
  }

  try {
    const { transport, probeOrder } = await requestTransport();
    await disconnectSource();
    resetState();
    await lineReader.connect(transport, probeOrder, isRecognizedLine, handleLine, onDisconnect);
    setSource("serial");
  } catch (err) {
    connStatus.textContent = `error: ${(err as Error).message}`;
  }
});

mqttBtn.addEventListener("click", async () => {
  if (source === "mqtt") {
    await disconnectSource();
    return;
  }

  const url = mqttUrl.value.trim();
  if (isMixedContent(location.protocol, url)) {
    connStatus.textContent = "error: ws:// is blocked on an https page - use wss:// or run the webapp over http (bun dev)";
    return;
  }
  localStorage.setItem(MQTT_URL_KEY, url);
  try {
    await disconnectSource();
    resetState();
    connStatus.textContent = "connecting...";
    await mqttFeed.connect(url, RAW_FRAME_TOPIC, handleLine, () => {
      onDisconnect();
      connStatus.textContent = "error: broker lost";
    });
    setSource("mqtt");
  } catch (err) {
    connStatus.textContent = `error: ${(err as Error).message}`;
  }
});
