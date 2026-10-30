import "./style.css";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Geolocation } from "@capacitor/geolocation";
import { UsbSerial } from "@leeskies/capacitor-usb-serial";
import { LineReader } from "../../webapp/src/transport";
import { requestNativeTransport } from "./transport-native";
import { classifyLine, parseLine, parseRawFrame } from "../../webapp/src/protocol";
import type { StatsMessage } from "../../webapp/src/protocol";
import { AircraftMap } from "../../webapp/src/map";
import { AircraftStore } from "../../webapp/src/aircraft-store";
import { MqttFeed, RAW_FRAME_TOPIC } from "../../webapp/src/mqtt-feed";
import { BrokerDiscovery, type Broker } from "./broker-discovery";
import { SourcePicker, type PickerItem } from "./source-picker";

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
const mqttFeed = new MqttFeed();
const discovery = new BrokerDiscovery();
const picker = new SourcePicker();

// USB serial exists only on Android (the plugin has no iOS side); iOS is
// broker-feed only.
const HAS_USB = Capacitor.getPlatform() === "android";

// Fixed baud, no auto-probe: this app only targets the FTDI-wired module
// (see README.md), and the probe's close+reopen cycle raced the native
// Android USB-serial driver's async teardown ("No connected device"
// errors, repeated disconnect/reconnect loop) - not worth it for a
// single known device/rate.
const BAUD = 921600;

let connecting = false;

// Exactly one input source at a time. USB wins over a broker feed: plugging
// a device in replaces the feed, unplugging falls back to the remembered
// broker.
type Source = "none" | "usb" | "mqtt";
let source: Source = "none";
// Set by tapping to disconnect: suppresses auto-connect (startup excepted,
// device plug-in excepted) until the next tap.
let manualOff = false;
let paused = false;

const REMEMBERED_KEY = "adsb.broker";
// How long a scan may run without the remembered broker showing up before
// the picker is offered instead.
const REMEMBERED_WAIT_MS = 5000;
let scanStartedAt = 0;
let autoPickerShown = false;
let usbPresent = false;

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

function setSource(next: Source, label = ""): void {
  source = next;
  setState(next === "none" ? "disconnected" : "connected");
  if (next !== "none") {
    connectBtn.title = `${label} - tap to disconnect`;
    connectBtn.setAttribute("aria-label", connectBtn.title);
    toast(label, 2500);
  }
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
  if (source === "none") return;
  setSource("none");
  statsEl.textContent = "";
  resetState();
  // USB unplugged or broker lost: fall back to whatever broker is around.
  window.setTimeout(autoSelect, 0);
}

async function disconnectSource(): Promise<void> {
  if (source === "usb") await lineReader.disconnect();
  else if (source === "mqtt") mqttFeed.disconnect();
  onDisconnect();
}

async function connectUsb(silent: boolean): Promise<void> {
  if (!HAS_USB || connecting || source === "usb") return;
  connecting = true;
  const prev = connState;
  setState("connecting");
  try {
    // Fails with "No USB serial device attached" before the broker feed
    // (if any) is torn down.
    const transport = await requestNativeTransport();
    if (source === "mqtt") mqttFeed.disconnect();
    source = "none";
    resetState();
    await lineReader.connectAt(transport, BAUD, handleLine, onDisconnect);
    manualOff = false;
    setSource("usb", `USB ${BAUD}`);
  } catch (err) {
    // Auto-connect attempts (startup, device-attach) stay quiet when
    // nothing is plugged in yet; a manual pick always reports.
    if (silent) {
      setState(source === "none" ? "disconnected" : prev);
    } else {
      setState("error");
      toast((err as Error).message);
    }
  } finally {
    connecting = false;
  }
}

async function connectMqtt(broker: Broker, silent: boolean): Promise<void> {
  if (connecting) return;
  connecting = true;
  setState("connecting");
  try {
    await disconnectSource();
    resetState();
    await mqttFeed.connect(broker.url, RAW_FRAME_TOPIC, handleLine, () => {
      toast(`broker lost: ${broker.name}`);
      onDisconnect();
      void rescan();
    });
    localStorage.setItem(REMEMBERED_KEY, broker.key);
    manualOff = false;
    setSource("mqtt", `MQTT ${broker.name}`);
  } catch (err) {
    setState(silent ? "disconnected" : "error");
    if (!silent) toast((err as Error).message);
  } finally {
    connecting = false;
  }
}

// Auto-connect policy while no source is active: the remembered broker
// silently; otherwise offer the picker - right away on first use, after
// REMEMBERED_WAIT_MS if a remembered broker exists but isn't advertised.
function autoSelect(): void {
  // An open picker means the user (or an earlier auto-offer) is choosing.
  if (source !== "none" || connecting || manualOff || paused || picker.isOpen) return;
  const brokers = discovery.list();
  const remembered = localStorage.getItem(REMEMBERED_KEY);
  const match = brokers.find((b) => b.key === remembered);
  if (match) {
    void connectMqtt(match, true);
    return;
  }
  if (brokers.length === 0 || autoPickerShown) return;
  if (remembered && Date.now() - scanStartedAt < REMEMBERED_WAIT_MS) return;
  autoPickerShown = true;
  void openPicker();
}

function pickerItems(): PickerItem[] {
  const items: PickerItem[] = [];
  if (usbPresent) {
    items.push({ label: "USB serial", detail: `${BAUD} baud`, pick: () => void connectUsb(false) });
  }
  for (const b of discovery.list()) {
    items.push({ label: b.name, detail: b.url, pick: () => void connectMqtt(b, false) });
  }
  return items;
}

async function openPicker(): Promise<void> {
  if (HAS_USB) {
    usbPresent = await UsbSerial.listDevices()
      .then(({ devices }) => devices.length > 0)
      .catch(() => false);
  }
  picker.open(pickerItems());
}

async function rescan(): Promise<void> {
  await discovery.stop();
  scanStartedAt = Date.now();
  autoPickerShown = false;
  try {
    await discovery.start();
  } catch (err) {
    toast(`mDNS: ${(err as Error).message}`);
    return;
  }
  window.setTimeout(autoSelect, REMEMBERED_WAIT_MS);
}

discovery.onChange(() => {
  if (picker.isOpen) picker.update(pickerItems());
  autoSelect();
});

connectBtn.addEventListener("click", async () => {
  if (source !== "none") {
    manualOff = true;
    await disconnectSource();
    return;
  }
  manualOff = false;
  await openPicker();
});

// Broker feed sockets don't survive iOS suspension, and an mDNS watch in the
// background is pointless: drop both on pause, rescan on resume - the
// remembered broker (the one just in use) then reconnects silently. USB is
// left alone.
void App.addListener("appStateChange", ({ isActive }) => {
  paused = !isActive;
  if (paused) {
    if (source === "mqtt") {
      mqttFeed.disconnect();
      onDisconnect();
    }
    void discovery.stop();
  } else {
    void rescan();
  }
});

// Startup: USB first (Android), then the broker feed as fallback. Plugging
// a device in later replaces the feed.
async function start(): Promise<void> {
  if (HAS_USB) {
    void UsbSerial.addListener("attached", () => void connectUsb(true));
    await connectUsb(true);
  }
  await rescan();
}
void start();

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
