// ---------------------------------------------------------------------------
// Galaxy particles. Each particle stores its orbit (radius, angle, height)
// rather than a position, so rotation, breathing and shockwaves are all
// computed here on the GPU.
//   aOrbit = (radius 0..1.2, angle, height, type)
//   aSeed  = (size, twinkle seed, colour variation, brightness)
// type: 0 bulge, 1 disk, 2 young blue stars, 3 pink HII glow, 4 violet dust glow
// ---------------------------------------------------------------------------

attribute vec4 aOrbit;
attribute vec4 aSeed;

uniform float uTime;        // scene clock
uniform float uRotation;    // accumulated galaxy rotation (energy-driven)
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uScale;       // point size scale (render height / reference)
uniform float uRadius;      // galaxy radius in world units
uniform vec4 uWaves[4];     // shockwaves: x = radius, y = strength

varying vec3 vColor;
varying float vSoft;

vec3 typeColor(float type, float v) {
  if (type < 0.5) return mix(vec3(1.0, 0.86, 0.62), vec3(1.0, 0.95, 0.85), v);       // bulge: warm
  if (type < 1.5) return mix(vec3(1.0, 0.9, 0.78), vec3(0.85, 0.88, 1.0), v);        // disk: mixed
  if (type < 2.5) return mix(vec3(0.55, 0.72, 1.0), vec3(0.85, 0.92, 1.0), v);       // young: blue-white
  if (type < 3.5) return mix(vec3(1.0, 0.32, 0.62), vec3(0.95, 0.42, 0.85), v);      // HII: pink/magenta
  return mix(vec3(0.45, 0.25, 0.85), vec3(0.6, 0.3, 0.75), v);                       // dust glow: violet
}

void main() {
  float r = aOrbit.x;
  float type = aOrbit.w;

  // rotation: rigid pattern speed, the core turns a little faster
  float ang = aOrbit.y + uRotation * (1.0 + 0.9 * exp(-r * 6.0));
  // small epicycles so particles shimmer within their arm
  ang += 0.015 * sin(uTime * 0.6 + aSeed.y * 40.0);

  // bass breathes the arms outward (more at mid radii than in the core)
  float rr = r * (1.0 + uBass * 0.07 * smoothstep(0.08, 0.5, r));
  // mid ripples the particle field
  rr += uMid * 0.012 * sin(ang * 3.0 + r * 22.0 - uTime * 1.8);
  float y = aOrbit.z + uMid * 0.02 * r * sin(r * 30.0 - uTime * 2.2 + ang * 2.0);

  // shockwave rings from beats: push outward and brighten
  float boost = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = r - uWaves[i].x;
    float w = exp(-d * d / 0.0035) * uWaves[i].y;
    rr += w * 0.035;
    boost += w;
  }

  vec3 pos = vec3(cos(ang) * rr, y, sin(ang) * rr) * uRadius;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float size = aSeed.x;
  float bright = aSeed.w * (1.0 + boost * 2.5);
  // treble sparkle on the young stars and some disk stars
  if (type > 0.5 && type < 2.5) {
    float tw = pow(0.5 + 0.5 * sin(uTime * 9.0 + aSeed.y * 120.0), 8.0);
    bright *= 1.0 + uTreble * tw * 3.0;
  }
  // the core glows brighter with bass
  bright *= 1.0 + uBass * 0.8 * exp(-r * 9.0);

#ifdef DUST
  // absorbers: per-channel absorption (blue is absorbed most, reddening the light)
  vColor = vec3(0.5, 0.62, 0.8) * aSeed.w;
  vSoft = 1.0;
#else
  vColor = typeColor(type, aSeed.z) * bright;
  vSoft = type > 2.5 ? 1.0 : 0.0;
#endif
  // big soft sprites (gas, dust) dominate fill rate, so they get a tighter cap
  gl_PointSize = clamp(size * uScale * (24.0 / -mv.z), 1.0, vSoft > 0.5 ? 40.0 * max(uScale, 1.0) : 96.0);
  // keep total light roughly constant when points get clamped to 1px
  vColor *= min(1.0, size * uScale * (24.0 / -mv.z));
}
