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
// shape and light multipliers set by the scene's music profile (1 = the plain look)
uniform float uHeight;    // curtain height
uniform float uWidth;     // sheet thickness
uniform float uCover;     // 0..1 share of each curtain's length that is lit
uniform float uFold;      // ripple / fold amplitude
uniform float uBright;    // overall curtain brightness
uniform float uWarm;      // 0..1 the green body warms toward gold, the crown toward pink-white
// the night progression over the piece (PROFILE.NIGHT)
uniform float uNight;     // 0 = late twilight .. 1 = deepest night
uniform float uDawn;      // 0..1 the pre-dawn glow

const float HORIZON = 0.30; // (reference restyle: a lower horizon, more sky)
const float FOCAL = 1.1;

vec3 viewRay(vec2 uv) {
  return normalize(vec3((uv.x - 0.5) * uAspect, uv.y - HORIZON, FOCAL));
}
