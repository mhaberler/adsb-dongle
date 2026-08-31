import "./style.css";
import { SerialLineReader } from "./serial";
import { classifyLine, parseLine, parseRawFrame } from "./protocol";
import type { StatsMessage } from "./protocol";
import { AircraftMap } from "./map";
import { AircraftStore } from "./aircraft-store";

const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const connStatus = document.querySelector<HTMLSpanElement>("#conn-status")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;
const geoStatus = document.querySelector<HTMLSpanElement>("#geo-status")!;

const map = new AircraftMap("map");
const serial = new SerialLineReader();

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

function setConnected(connected: boolean): void {
  connStatus.textContent = connected ? "connected" : "disconnected";
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
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

  for (const event of rawStore.processFrame(frame)) {
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
    if (!rawCommandSent) {
      rawCommandSent = true;
      // GNS5892 command interface: "#49-03<CR>" = DF17/18/19-only output
      // mode. Harmless no-op if this line actually came via an ESP32
      // pass-through rather than a directly-wired module.
      void serial.write("#49-03\r");
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
  setConnected(false);
  statsEl.textContent = "";
  resetState();
}

connectBtn.addEventListener("click", async () => {
  if (connectBtn.textContent === "Disconnect") {
    await serial.disconnect();
    onDisconnect();
    return;
  }

  try {
    resetState();
    await serial.connect(isRecognizedLine, handleLine, onDisconnect);
    setConnected(true);
  } catch (err) {
    connStatus.textContent = `error: ${(err as Error).message}`;
  }
});
