#include <Arduino.h>

#include "adsb.hpp"

void setup() {
  Serial.begin(115200);
  adsb_setup();
}

void loop() { adsb_loop(); }
