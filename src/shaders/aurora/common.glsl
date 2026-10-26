// ---------------------------------------------------------------------------
// Aurora scene: shared camera model and uniforms.
// The view uses a shifted projection: the horizon is a straight line at
// screen height HORIZON and verticals stay vertical, like a tilt-shift lens.
// ---------------------------------------------------------------------------

uniform float uAspect;
uniform float uTime;      // scene clock (energy-driven)
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uEnergy;
uniform float uSurge;     // beat-driven colour surge, 0..1
uniform vec2 uResolution;

const float HORIZON = 0.36;
const float FOCAL = 1.1;

vec3 viewRay(vec2 uv) {
  return normalize(vec3((uv.x - 0.5) * uAspect, uv.y - HORIZON, FOCAL));
}
