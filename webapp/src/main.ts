import "./style.css";
import { SerialLineReader } from "./serial";
import { parseLine } from "./protocol";
import { AircraftMap } from "./map";

const connectBtn = document.querySelector<HTMLButtonElement>("#connect-btn")!;
const connStatus = document.querySelector<HTMLSpanElement>("#conn-status")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;

const map = new AircraftMap("map");
const serial = new SerialLineReader();

function setConnected(connected: boolean): void {
  connStatus.textContent = connected ? "connected" : "disconnected";
  connectBtn.textContent = connected ? "Disconnect" : "Connect";
}

function handleLine(line: string): void {
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
      statsEl.textContent =
        `frames: ${msg.data.frames_seen}  ` +
        `crc_fail: ${msg.data.crc_fail}  ` +
        `decoded: ${msg.data.decoded}  ` +
        `dropped: ${msg.data.dropped_lines + msg.data.dropped_overflow}  ` +
        `aircraft: ${msg.data.aircraft_count}`;
      break;
  }
}

function onDisconnect(): void {
  setConnected(false);
  statsEl.textContent = "";
}

connectBtn.addEventListener("click", async () => {
  if (connectBtn.textContent === "Disconnect") {
    await serial.disconnect();
    onDisconnect();
    return;
  }

  try {
    await serial.connect(handleLine, onDisconnect);
    setConnected(true);
  } catch (err) {
    connStatus.textContent = `error: ${(err as Error).message}`;
  }
});
