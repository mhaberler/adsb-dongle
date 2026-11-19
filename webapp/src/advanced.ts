// "Advanced" section at the bottom of the layer switcher: a collapsed
// <details> for settings an ordinary user never needs - currently the MQTT
// broker feed (sensorpod). Shared by the webapp and the app; each fills the
// body with its own controls.
import type { AircraftMap } from "./map";

export function advancedSection(map: AircraftMap): HTMLElement {
  const box = map.addPanelSection("advanced-options");
  const details = document.createElement("details");
  details.innerHTML = `<summary>Advanced</summary><div class="adv-body"></div>`;
  box.append(details);
  return details.querySelector<HTMLElement>(".adv-body")!;
}
