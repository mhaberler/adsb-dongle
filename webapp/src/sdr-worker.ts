// Web Worker for an SDR link: IQ buffers in, Raw frame batches out, so the
// 2.4 Msps demodulation never stalls the map.
import { ModeSDemod2400 } from "./modes-demod-2400";

const demod = new ModeSDemod2400();
self.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
  const lines = demod.push(new Uint8Array(ev.data));
  if (lines.length) self.postMessage(lines);
};
