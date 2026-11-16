import "./style.css";
import { LineReader, type ByteTransport } from "./transport";
import { grantedWebSerialTransport, requestWebSerialTransport } from "./transport-webserial";
import { FtdiTransport } from "./transport-ftdi";
import { CdcAcmTransport } from "./transport-cdcacm";
import { classifyLine, parseLine, parseRawFrame } from "./protocol";
import type { StatsMessage } from "./protocol";
import { AircraftMap } from "./map";
import { AircraftStore } from "./aircraft-store";

const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const statusMsg = document.querySelector<HTMLDivElement>("#status-msg")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;

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

const map = new AircraftMap("map");
const lineReader = new LineReader();

// Baud probe order favors the direct-wired module's 921600 on the WebUSB
// path (Android + WebUSB almost always means the FTDI-adapted module, not
// the ESP32 dongle) and the dongle's 115200 first on Web Serial (desktop).
const SERIAL_PROBE = [115200, 921600];
const USB_PROBE = [921600, 115200];

const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0403 }, // FTDI
  { classCode: 0x02 }, // CDC comm interface
  { classCode: 0xef }, // composite/IAD (covers most CDC-ACM boards)
];

function usbTransport(device: USBDevice): ByteTransport {
  return FtdiTransport.matches(device) ? new FtdiTransport(device) : new CdcAcmTransport(device);
}

type Pick = { transport: ByteTransport; probeOrder: number[] };

// Web Serial (navigator.serial) is desktop-only - Android Chrome has no
// such API at all, so there we fall back to WebUSB with hand-rolled
// FTDI and CDC-ACM drivers (transport-ftdi.ts, transport-cdcacm.ts).
// `ask` = show the browser's device picker (needs a user click); without
// it only devices granted on an earlier visit are used (auto-connect).
async function findTransport(ask: boolean): Promise<Pick | null> {
  if (navigator.serial) {
    const transport = ask ? await requestWebSerialTransport() : await grantedWebSerialTransport();
    return transport && { transport, probeOrder: SERIAL_PROBE };
  }
  if (navigator.usb) {
    const device = ask
      ? await navigator.usb.requestDevice({ filters: USB_FILTERS })
      : (await navigator.usb.getDevices())[0];
    return device ? { transport: usbTransport(device), probeOrder: USB_PROBE } : null;
  }
  if (ask) throw new Error("No Web Serial or WebUSB in this browser - use Chrome or Edge");
  return null;
}

if ("geolocation" in navigator) {
  let geoFailStreak = 0;
  navigator.geolocation.watchPosition(
    (pos) => {
      geoFailStreak = 0;
      map.setMyLocation(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      // PERMISSION_DENIED(1) / POSITION_UNAVAILABLE(2) / TIMEOUT(3).
      // watchPosition keeps retrying on its own for 2/3; only 1 is final.
      // A first-fix TIMEOUT/POSITION_UNAVAILABLE is common while the OS
      // location backend warms up, so don't alarm on a single miss.
      geoFailStreak++;
      if (err.code === GeolocationPositionError.PERMISSION_DENIED || geoFailStreak === 3) {
        toast(`location: ${err.message}`);
      }
    },
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 },
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
let connecting = false;

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
  setConnected(false);
  statsEl.textContent = "";
  resetState();
}

async function connect(ask: boolean): Promise<void> {
  if (connecting || connState === "connected") return;
  connecting = true;
  setState("connecting");
  try {
    resetState();
    const pick = await findTransport(ask);
    if (!pick) {
      setState("disconnected");
      return;
    }
    await lineReader.connect(pick.transport, pick.probeOrder, isRecognizedLine, handleLine, onDisconnect);
    setConnected(true);
  } catch (err) {
    // Auto-connect attempts (startup, device plugged in) stay quiet; a
    // Connect click always reports. Closing the picker without choosing
    // a device (NotFoundError) is not an error either.
    if (!ask || (err as DOMException).name === "NotFoundError") {
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
  await connect(true);
});

// Auto-connect, like the Android app: on startup and whenever a device is
// plugged in - but only devices the user already picked once (browsers
// never hand out unpicked devices without a click).
navigator.serial?.addEventListener("connect", () => void connect(false));
navigator.usb?.addEventListener("connect", () => void connect(false));
void connect(false);

// PWA: offline cache (sw.js is generated by the build, so not in dev).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) toast("Update installed - reload to use it", 8000);
  });
  navigator.serviceWorker.register("./sw.js").catch((err: Error) => {
    toast(`offline mode unavailable: ${err.message}`);
  });
}
