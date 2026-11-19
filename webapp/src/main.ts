import "./style.css";
import { LineReader, type ByteTransport } from "./transport";
import { grantedWebSerialTransport, requestWebSerialTransport } from "./transport-webserial";
import { FtdiTransport } from "./transport-ftdi";
import { CdcAcmTransport } from "./transport-cdcacm";
import { classifyLine, isPlausibleLine, parseLine, parseRawFrame, parseRawSignal } from "./protocol";
import type { StatsMessage } from "./protocol";
import { AircraftMap } from "./map";
import { AircraftStore } from "./aircraft-store";
import { MqttFeed, RAW_FRAME_TOPIC, isMixedContent } from "./mqtt-feed";
import { advancedSection } from "./advanced";

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
const mqttFeed = new MqttFeed();

// MQTT broker feed (sensorpod): an expert option, so it lives collapsed in
// the layer switcher's "Advanced" section instead of the toolbar.
const MQTT_URL_KEY = "adsb.mqttUrl";
const mqttBox = advancedSection(map);
mqttBox.innerHTML =
  `<div>MQTT broker feed</div>` +
  `<div class="adv-hint">Raw frames from a sensorpod broker (topic ${RAW_FRAME_TOPIC}) ` +
  `instead of a USB receiver.</div>` +
  `<div class="adv-row"><input type="url" spellcheck="false" aria-label="MQTT broker WebSocket URL" /></div>` +
  `<div class="adv-row"><button type="button">Connect</button></div>`;
const mqttUrl = mqttBox.querySelector("input")!;
const mqttBtn = mqttBox.querySelector("button")!;
mqttUrl.placeholder = "ws://host:8080/mqtt";
mqttUrl.value = "ws://esp32p4-e185df.local:8080/mqtt";
try {
  mqttUrl.value = localStorage.getItem(MQTT_URL_KEY) ?? mqttUrl.value;
} catch {
  // storage unavailable: keep the default
}

// Exactly one input source at a time: a serial link or a broker feed.
type Source = "none" | "serial" | "mqtt";
let source: Source = "none";

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

// The button is a bare colour swatch: its state is a data attribute, the
// active source is `source` above.
let connecting = false;

function setState(state: ConnState): void {
  connectBtn.dataset.state = state;
  const label = state === "connected" ? "Disconnect" : "Connect";
  connectBtn.title = label;
  connectBtn.setAttribute("aria-label", label);
}

// The colour dot shows either source; a tap on it disconnects whichever
// is active.
function setSource(next: Source): void {
  source = next;
  setState(next === "none" ? "disconnected" : "connected");
  if (next === "mqtt") {
    connectBtn.title = `MQTT ${RAW_FRAME_TOPIC} - tap to disconnect`;
    connectBtn.setAttribute("aria-label", connectBtn.title);
  }
  mqttBtn.textContent = next === "mqtt" ? "Disconnect" : "Connect";
}

// Used only during baud auto-probe: a line is "valid" if it's a recognized
// stream shape (NDJSON, raw frame, or a module command reply) - strictly,
// so that line noise at a wrong baud rate can't lock that rate.
function isRecognizedLine(line: string): boolean {
  return isPlausibleLine(line);
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

// Serial link (Web Serial / WebUSB). Never replaces an active broker feed
// on its own - only a click does.
async function connect(ask: boolean): Promise<void> {
  if (connecting || source !== "none") return;
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
    setSource("serial");
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
  if (source !== "none") {
    await disconnectSource();
    return;
  }
  await connect(true);
});

mqttBtn.addEventListener("click", async () => {
  if (source === "mqtt") {
    await disconnectSource();
    return;
  }
  if (connecting) return;

  const url = mqttUrl.value.trim();
  if (!url) return;
  if (isMixedContent(location.protocol, url)) {
    toast("ws:// is blocked on an https page - use wss:// or run the webapp over http (bun dev)", 8000);
    return;
  }
  try {
    localStorage.setItem(MQTT_URL_KEY, url);
  } catch {
    // not remembered, still connect
  }
  connecting = true;
  setState("connecting");
  try {
    await disconnectSource();
    resetState();
    await mqttFeed.connect(url, RAW_FRAME_TOPIC, handleLine, () => {
      onDisconnect();
      setState("error");
      toast("MQTT broker lost");
    });
    setSource("mqtt");
    toast(`MQTT ${RAW_FRAME_TOPIC}`, 2500);
  } catch (err) {
    setState("error");
    toast((err as Error).message);
  } finally {
    connecting = false;
  }
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
