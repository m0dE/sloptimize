class TrafficLight {
  constructor(at) { this.at = at; this.phase = 0; }
  update(dt) {
    this.phase = (this.phase + dt) % 3000;
    return this.phase < 1500 ? 'green' : 'red';
  }
  setPhase(p) { this.phase = p; }
}
class TrafficLightManager {
  constructor() { this.lights = new Map(); }
  add(at) { this.lights.set(at, new TrafficLight(at)); }
  tick(dt) { for (const l of this.lights.values()) l.update(dt); }
}
window.lights = new TrafficLightManager();
