// Broker feed: subscribes to Raw frames on an MQTT-over-WebSocket broker
// (sensorpod publishes one `*<hex>;` frame per message on `ihex`) and hands
// each payload to the same line handler a serial link feeds. Shared by the
// webapp (URL typed in) and the app (URL from mDNS discovery).
//
// `mqtt` resolves to its browser ESM bundle under Vite (package.json
// "browser" export condition), so no Node polyfills are needed.

import mqtt, { type MqttClient } from "mqtt";
import type { LineHandler } from "./transport";

export const RAW_FRAME_TOPIC = "ihex";

// Consecutive failed reconnects (3 s apart) before giving up and calling
// onLost - the app then rescans mDNS instead of retrying a vanished broker.
const MAX_RECONNECTS = 3;
const RECONNECT_PERIOD_MS = 3000;
const CONNECT_TIMEOUT_MS = 10000;

export interface BrokerEndpoint {
  host: string;
  port: number;
  txt?: Record<string, string>;
  tls?: boolean;
}

// ws(s)://host:port + TXT `path` (default /mqtt), as advertised under
// _mqtt-ws._tcp / _mqtt-wss._tcp.
export function brokerUrl({ host, port, txt, tls }: BrokerEndpoint): string {
  const h = host.includes(":") ? `[${host}]` : host; // bare IPv6
  const path = txt?.path || "/mqtt";
  return `${tls ? "wss" : "ws"}://${h}:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

// An https page may not open ws:// (mixed content) - true when the browser
// will refuse the connection outright.
export function isMixedContent(pageProtocol: string, url: string): boolean {
  return pageProtocol === "https:" && url.startsWith("ws:");
}

export class MqttFeed {
  private client: MqttClient | null = null;

  // Resolves once subscribed; rejects if the first connect fails. After
  // that, onLost fires (once) when the broker stays unreachable for
  // MAX_RECONNECTS attempts. disconnect() never fires onLost.
  connect(url: string, topic: string, onLine: LineHandler, onLost: () => void): Promise<void> {
    this.disconnect();
    const decoder = new TextDecoder();
    const client = mqtt.connect(url, {
      clientId: `adsb_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
    this.client = client;

    return new Promise((resolve, reject) => {
      let connectedOnce = false;
      let reconnects = 0;

      const giveUp = (err: Error) => {
        if (this.client !== client) return;
        this.client = null;
        client.end(true);
        if (connectedOnce) onLost();
        else reject(err);
      };

      client.on("connect", () => {
        reconnects = 0;
        client.subscribe(topic, (err) => {
          if (err) return giveUp(err);
          if (!connectedOnce) {
            connectedOnce = true;
            resolve();
          }
        });
      });
      client.on("reconnect", () => {
        if (++reconnects > MAX_RECONNECTS) giveUp(new Error(`broker unreachable: ${url}`));
      });
      client.on("message", (_topic, payload) => {
        const line = decoder.decode(payload).trim();
        if (line) onLine(line);
      });
    });
  }

  disconnect(): void {
    const client = this.client;
    this.client = null;
    client?.end(true);
  }

  get connected(): boolean {
    return this.client !== null;
  }
}
