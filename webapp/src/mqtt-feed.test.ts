import { describe, expect, test } from "bun:test";
import { brokerUrl, isMixedContent } from "./mqtt-feed";

describe("brokerUrl", () => {
  test("uses TXT path", () => {
    expect(brokerUrl({ host: "esp32p4-e185df.local", port: 8080, txt: { path: "/mqtt" } })).toBe(
      "ws://esp32p4-e185df.local:8080/mqtt",
    );
  });

  test("defaults path to /mqtt", () => {
    expect(brokerUrl({ host: "10.0.0.5", port: 9001 })).toBe("ws://10.0.0.5:9001/mqtt");
    expect(brokerUrl({ host: "10.0.0.5", port: 9001, txt: {} })).toBe("ws://10.0.0.5:9001/mqtt");
  });

  test("adds missing leading slash", () => {
    expect(brokerUrl({ host: "h", port: 1, txt: { path: "ws" } })).toBe("ws://h:1/ws");
  });

  test("wss for tls", () => {
    expect(brokerUrl({ host: "h", port: 443, tls: true })).toBe("wss://h:443/mqtt");
  });

  test("brackets IPv6", () => {
    expect(brokerUrl({ host: "fe80::1", port: 8080 })).toBe("ws://[fe80::1]:8080/mqtt");
  });
});

describe("isMixedContent", () => {
  test("ws from https is blocked", () => {
    expect(isMixedContent("https:", "ws://h:8080/mqtt")).toBe(true);
  });
  test("wss from https, ws from http are fine", () => {
    expect(isMixedContent("https:", "wss://h/mqtt")).toBe(false);
    expect(isMixedContent("http:", "ws://h:8080/mqtt")).toBe(false);
  });
});
