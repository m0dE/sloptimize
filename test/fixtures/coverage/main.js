let cars = 0;
function stepCars() { cars++; }
function frame() {
  stepCars();
  window.lights.tick(16);   // a city with no traffic lights: tick runs, update never does
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
