import { ZeroConf, type ZeroConfWatchResult } from "@mhaberler/capacitor-zeroconf-nsd";
import { brokerUrl } from "../../webapp/src/mqtt-feed";

// mDNS discovery of MQTT-over-WebSocket brokers (_mqtt-ws._tcp), modeled on
// mdns-mqtt-vue3's useMqttDiscovery. Only resolved services (port known)
// are listed.

const SERVICE = { type: "_mqtt-ws._tcp.", domain: "local." };

export interface Broker {
  // Instance name, lowercased: Android NSD lowercases instance names, so
  // this is the stable identity used for the remembered broker.
  key: string;
  name: string;
  url: string;
}

export class BrokerDiscovery {
  private brokers = new Map<string, Broker>();
  private watching = false;
  private listener: ((brokers: Broker[]) => void) | null = null;

  onChange(cb: (brokers: Broker[]) => void): void {
    this.listener = cb;
  }

  list(): Broker[] {
    return [...this.brokers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Starts from a clean slate: NSD/Bonjour "removed" events are unreliable,
  // so a restart is what actually drops vanished brokers.
  async start(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    this.brokers.clear();
    try {
      await ZeroConf.watch(SERVICE, (event) => this.onEvent(event));
    } catch (err) {
      this.watching = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.watching) return;
    this.watching = false;
    await ZeroConf.unwatch(SERVICE).catch(() => {});
  }

  private onEvent(event: ZeroConfWatchResult | null): void {
    if (!event || !this.watching) return;
    const { action, service } = event;
    const key = (service.name ?? "").toLowerCase();
    if (action === "removed") {
      if (this.brokers.delete(key)) this.listener?.(this.list());
      return;
    }
    if (action !== "resolved" || !service.port) return;
    const host = service.hostname || service.ipv4Addresses?.[0] || service.ipv6Addresses?.[0];
    if (!host) return;
    this.brokers.set(key, {
      key,
      name: service.name,
      url: brokerUrl({ host: host.replace(/\.$/, ""), port: service.port, txt: service.txtRecord }),
    });
    this.listener?.(this.list());
  }
}
