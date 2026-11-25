// SDR link on Android: the local Java plugin (android/.../rtlsdr/RtlSdrPlugin.java)
// drives the RTL-SDR and demodulates natively; only Raw frames cross the
// bridge (ADR 0002). Android only - not in the iOS build.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface RtlSdrPlugin {
  list(): Promise<{ devices: { deviceId: number; name: string | null }[] }>;
  start(): Promise<{ label: string }>;
  stop(): Promise<void>;
  addListener(event: "frames", fn: (ev: { lines: string[] }) => void): Promise<PluginListenerHandle>;
  addListener(event: "stopped", fn: (ev: { reason: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "attached" | "detached", fn: () => void): Promise<PluginListenerHandle>;
}

export const RtlSdr = registerPlugin<RtlSdrPlugin>("RtlSdr");

export async function rtlSdrPresent(): Promise<boolean> {
  return RtlSdr.list()
    .then(({ devices }) => devices.length > 0)
    .catch(() => false);
}
