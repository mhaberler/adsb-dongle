# ADS-B dongle viewer

Receives ADS-B extended-squitter traffic from a Mode-S receiver module and shows the aircraft on a map, in the browser (webapp) and on phones (app).

## Language

### Input

**Input source**:
Where the viewer's lines come from; exactly one is active at a time. Either a Serial link or a Broker feed.
_Avoid_: transport, connection, feed (alone)

**Serial link**:
An Input source over USB: the receiver module wired via a USB-UART adapter, or this repo's ESP32 dongle.
_Avoid_: USB connection, port

**Broker feed**:
An Input source that subscribes to Raw frames on a Broker's `ihex` topic.
_Avoid_: MQTT connection, network source

**Broker**:
An MQTT-over-WebSocket endpoint, found via `_mqtt-ws._tcp` mDNS advertisement or typed in as a URL. In practice a sensorpod.
_Avoid_: server, MQTT server

**Remembered broker**:
The Broker the user last picked; reconnected to silently whenever it is advertised again.
_Avoid_: default broker, preferred broker

### Data

**Raw frame**:
One demodulated Mode-S message as ASCII hex: `*<hex>;` as emitted by the receiver module, or `+SS<hex>;` with a Signal level byte in front (a sensorpod's RTL-SDR frames). Same unit on a Serial link and on the `ihex` topic.
_Avoid_: ihex line, hex frame, message

**Signal level**:
The received power of one Raw frame relative to the receiver's full scale, carried as the `SS` byte (readsb Beast scale). Uncalibrated: it moves with the receiver's gain.
_Avoid_: RSSI (that is per aircraft), signal strength

**RSSI**:
An aircraft's recent received strength in dBFS, averaged over its last eight Signal levels the way readsb does.
_Avoid_: signal, dBm (it is not calibrated)

**Decoded aircraft message**:
One readsb `aircraft.json`-style JSON object for one aircraft, as emitted by the dongle firmware (NDJSON) or published on `ADSB/<icao>`.
_Avoid_: aircraft JSON, position report
