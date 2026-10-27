// ---------------------------------------------------------------------------
// Flow field (low resolution, every frame), in painting heights per second.
// The sky flow is the curl of a stream function, so it is divergence free:
// strokes circle the stars and the moon and wind around the double spiral
// instead of bunching up. Curl noise adds a slow turbulence. The landscape
// drifts gently along the hills and the cypress rises like a flame.
// ---------------------------------------------------------------------------

uniform sampler2D tMask;
uniform float uTime;
uniform vec4 uSpirals[2];   // x, y, radius, strength (sign = turning direction)
uniform vec3 uStars[12];    // x, y, radius (the last one is the moon)
uniform float uTurbulence;
uniform float uStarSwirl;
uniform float uMoonSwirl;
uniform float uFlowGain;    // painting heights per second for unit flow
varying vec2 vUv;

// Compact Gaussian vortex: tangential flow near c, none far away
float vortex(vec2 p, vec2 c, float r, float s) {
  vec2 d = p - c;
  return s * r * exp(-dot(d, d) / (r * r));
}

float streamFunction(vec2 p) {
  float s = 0.0;
  // the wind current: left to right across the sky, in long waves
  s += 0.35 * p.y + 0.12 * sin(p.x * 2.4 - 0.6 + p.y * 2.0);
  s += vortex(p, uSpirals[0].xy, uSpirals[0].z, uSpirals[0].w);
  s += vortex(p, uSpirals[1].xy, uSpirals[1].z, uSpirals[1].w);
  for (int i = 0; i < 12; i++) s += vortex(p, uStars[i].xy, uStars[i].z * 1.7, i == 11 ? uMoonSwirl : uStarSwirl);
  s += uTurbulence * fbm(p * 2.2 + vec2(uTime * 0.02, -uTime * 0.015), 3);
  return s;
}

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  const float e = 0.004;
  vec2 v = vec2(streamFunction(p + vec2(0.0, e)) - streamFunction(p - vec2(0.0, e)),
                streamFunction(p - vec2(e, 0.0)) - streamFunction(p + vec2(e, 0.0))) / (2.0 * e);

  vec4 m = texture2D(tMask, vUv);
  // hills roll gently; the village below them barely moves
  vec2 hills = vec2(0.22, 0.04 * sin(p.x * 9.0 + uTime * 0.2)) * mix(0.1, 1.0, smoothstep(0.17, 0.26, p.y));
  vec2 flame = vec2(0.12 * sin(p.y * 14.0 + uTime * 0.5), 0.45);
  v = mix(v, hills, m.g);
  v = mix(v, flame, smoothstep(0.2, 0.6, m.r));
  v *= 1.0 - m.a; // the houses and the church stand still (no drift, no smear)
  gl_FragColor = vec4(v * uFlowGain, 0.0, 1.0);
}
