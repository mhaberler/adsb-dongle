// Web Worker for an SDR link: IQ buffers in, Raw frame batches out, so the
// 2 Msps demodulation never stalls the map.
import { ModeSDemod } from "./modes-demod";

const demod = new ModeSDemod();
self.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
  const lines = demod.push(new Uint8Array(ev.data));
  if (lines.length) self.postMessage(lines);
};
