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
const statusMsg = document.querySelector<HTMLDivElement>("#status-msg")!;

let toastTimer: number | undefined;

// Transient message over the map. Empty text hides it immediately.
function toast(msg: string, ms = 4000): void {
  window.clearTimeout(toastTimer);
  if (!msg) {
    statusMsg.classList.remove("show");
    return;
  }
  statusMsg.textContent = msg;
  statusMsg.classList.add("show");
  toastTimer = window.setTimeout(() => statusMsg.classList.remove("show"), ms);
}
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;


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
      toast("location: permission denied");
      return;
    }
  } catch (err) {
    toast(`location: ${(err as Error).message}`);
    return;
  }

  let geoFailStreak = 0;
  await Geolocation.watchPosition(
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 },
    (pos, err) => {
      if (pos) {
        geoFailStreak = 0;
        map.setMyLocation(pos.coords.latitude, pos.coords.longitude);
        toast("");
        return;
      }
      geoFailStreak++;
      if (geoFailStreak >= 3) {
        toast(`location: ${err?.message ?? "unavailable"}`);
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

type ConnState = "disconnected" | "connecting" | "connected" | "error";

// The button is a bare colour swatch, so connection state lives here rather
// than being inferred from its label.
let connState: ConnState = "disconnected";

function setState(state: ConnState): void {
  connState = state;
  connectBtn.dataset.state = state;
  const label = state === "connected" ? "Disconnect" : "Connect";
  connectBtn.title = label;
  connectBtn.setAttribute("aria-label", label);
}

function setConnected(connected: boolean): void {
  setState(connected ? "connected" : "disconnected");
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
  if (connecting || connState === "connected") return;
  connecting = true;
  setState("connecting");
  try {
    resetState();
    const transport = await requestNativeTransport();
    await lineReader.connectAt(transport, BAUD, handleLine, onDisconnect);
    setConnected(true);
  } catch (err) {
    // Auto-connect attempts (startup, device-attach) stay quiet when
    // nothing is plugged in yet; a manual Connect click always reports.
    if (silent) {
      setState("disconnected");
    } else {
      setState("error");
      toast((err as Error).message);
    }
  } finally {
    connecting = false;
  }
}

connectBtn.addEventListener("click", async () => {
  if (connState === "connected") {
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

// Capacitor 8.5.0 (@capacitor/android SystemBars) injects the
// --safe-area-inset-* CSS variables before document.documentElement exists,
// so the injection throws ("Error injecting safe area CSS: TypeError: Cannot
// read properties of null") and the variables are never set — leaving the
// toolbar under the status bar on edge-to-edge Android (targetSdk 36).
// Re-trigger the injection now that the DOM is parsed.
declare global {
  interface Window {
    CapacitorSystemBarsAndroidInterface?: { onDOMReady(): void };
  }
}
window.CapacitorSystemBarsAndroidInterface?.onDOMReady();
