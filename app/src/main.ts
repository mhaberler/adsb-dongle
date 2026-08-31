import "./style.css";
import { Geolocation } from "@capacitor/geolocation";
import { UsbSerial } from "@leeskies/capacitor-usb-serial";
import { LineReader } from "../../webapp/src/transport";
import { requestNativeTransport } from "./transport-native";
import { classifyLine, parseLine, parseRawFrame } from "../../webapp/src/protocol";
import type { StatsMessage } from "../../webapp/src/protocol";
import { AircraftMap } from "../../webapp/src/map";
import { AircraftStore } from "../../webapp/src/aircraft-store";

const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const connStatus = document.querySelector<HTMLSpanElement>("#conn-status")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;
const geoStatus = document.querySelector<HTMLSpanElement>("#geo-status")!;

const map = new AircraftMap("map");
const lineReader = new LineReader();

// Fixed baud, no auto-probe: this app only targets the FTDI-wired module
// (see README.md), and the probe's close+reopen cycle raced the native
// Android USB-serial driver's async teardown ("No connected device"
// errors, repeated disconnect/reconnect loop) - not worth it for a
// single known device/rate.
const BAUD = 921600;

let connecting = false;

async function initGeolocation(): Promise<void> {
  try {
    const perm = await Geolocation.requestPermissions();
    if (perm.location !== "granted" && perm.coarseLocation !== "granted") {
      geoStatus.textContent = "location: permission denied";
      return;
    }
  } catch (err) {
    geoStatus.textContent = `location: ${(err as Error).message}`;
    return;
  }

  let geoFailStreak = 0;
  await Geolocation.watchPosition(
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 },
    (pos, err) => {
      if (pos) {
        geoFailStreak = 0;
        map.setMyLocation(pos.coords.latitude, pos.coords.longitude);
        geoStatus.textContent = "";
        return;
      }
      geoFailStreak++;
      if (geoFailStreak >= 3) {
        geoStatus.textContent = `location: ${err?.message ?? "unavailable"}`;
      }
    },
  );
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
      // mode. Disabled for now (not the cause of the reconnect-loop bug
      // fixed in transport.ts/BAUD above - that was confirmed to be the
      // baud-probe's close+reopen race, unrelated to this command).
      // void lineReader.write("#49-03\r");
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

async function connect(silent: boolean): Promise<void> {
  if (connecting || connectBtn.textContent === "Disconnect") return;
  connecting = true;
  try {
    resetState();
    const transport = await requestNativeTransport();
    await lineReader.connectAt(transport, BAUD, handleLine, onDisconnect);
    setConnected(true);
  } catch (err) {
    // Auto-connect attempts (startup, device-attach) stay quiet when
    // nothing is plugged in yet; a manual Connect click always reports.
    if (!silent) connStatus.textContent = `error: ${(err as Error).message}`;
  } finally {
    connecting = false;
  }
}

connectBtn.addEventListener("click", async () => {
  if (connectBtn.textContent === "Disconnect") {
    await lineReader.disconnect();
    onDisconnect();
    return;
  }
  await connect(false);
});

// Auto-connect: on startup if a device is already attached, and whenever
// one is plugged in while the app is running.
void UsbSerial.addListener("attached", () => void connect(true));
void connect(true);

void initGeolocation();
