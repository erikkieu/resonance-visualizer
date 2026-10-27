// ---------------------------------------------------------------------------
// Aurora curtain lookup table (4096 x 3, recomputed every frame).
// Each row is one curtain; each column a position x along it (-50..50 map
// units). Precomputing the slowly varying shape here means the volume march
// needs one texture fetch per curtain per slice instead of several noises.
//   r = z of the curtain's centre line (base distance + meander + folds)
//   g = brightness along the curtain (patchiness x fine vertical rays,
//       x the live spectrum and the note pulses passing by)
//   b = the curtain's height at this point (1 = the scene's plain height)
//   a = colour: position on the profile's AURORA.RAMP
// The audio-wave behaviour: the spectrum (uSpec, low notes left, high right)
// lifts and brightens the curtain like an equaliser, and every note onset
// is a pulse (uPulse) travelling along one curtain, lifting and brightening
// it and pulling its colour toward the note's (uPulseHue).
// ---------------------------------------------------------------------------

#define SPEC_BANDS 48
#define MAX_PULSES 12

uniform float uSpec[SPEC_BANDS];   // 0..1 per band, smoothed on the CPU
uniform vec4 uPulse[MAX_PULSES];   // x = screen position 0..1, y = curtain, z = strength (enveloped), w = width
uniform float uPulseHue[MAX_PULSES];
uniform vec3 uRibbonHue;           // base ramp position of each curtain
uniform vec3 uRibbonHeight;        // base height of each curtain
uniform float uAmp;                // 0..1 overall wave amplitude
uniform float uSpecHeight;
uniform float uSpecBright;
uniform float uPulseBright;
uniform float uPulseLift;
uniform float uTopScale;           // height the slices cover (tallest possible curtain)
varying vec2 vUv;

float spectrum(float u) {
  float b = clamp(u, 0.0, 1.0) * float(SPEC_BANDS - 1);
  int i = int(floor(b));
  float f = b - float(i);
  // smooth between neighbouring bands, so the curtain never steps
  return mix(uSpec[i], uSpec[min(i + 1, SPEC_BANDS - 1)], f * f * (3.0 - 2.0 * f));
}

void main() {
  float x = (vUv.x - 0.5) * 100.0;
  float fk = floor(vUv.y * 3.0);
  float t = uTime;

  float base = 8.0 + 7.5 * fk;
  float fold = 0.32 + 0.35 * uMid; // mid: fold frequency
  float meander = 4.0 * (vnoise(vec2(x * 0.035 + fk * 9.1, t * 0.018 + fk)) - 0.5) * 2.0;
  float folds = ((1.8 - 0.3 * fk) * sin(x * fold + t * (0.5 + 0.1 * fk) + fk * 2.3)
              + 0.5 * sin(x * fold * 2.3 - t * 0.7 + fk)) * uFold;

  // coverage: more of each curtain lights up as the music grows
  float patchy = smoothstep(0.55 - 0.4 * uCover, 0.95 - 0.3 * uCover, vnoise(vec2(x * 0.09 + t * 0.03, fk * 5.0)));
  // fine vertical rays; treble makes them crisper and denser
  float rays = vnoise(vec2(x * (2.6 + 2.5 * uTreble) - t * 0.25, fk * 3.0 + t * 0.05));
  rays = mix(1.0, 0.25 + 1.1 * rays * rays, 0.55 + 0.35 * uTreble);

  // where this point of the curtain appears across the screen (0 = left edge)
  float su = 0.5 + x * FOCAL / (base * uAspect);

  // the equaliser: this point's spectrum band lifts and brightens the curtain
  float spec = spectrum(su) * uAmp;
  float height = (fk < 0.5 ? uRibbonHeight.x : fk < 1.5 ? uRibbonHeight.y : uRibbonHeight.z) * (1.0 + uSpecHeight * spec);
  float light = 1.0 + uSpecBright * spec;
  float hue = fk < 0.5 ? uRibbonHue.x : fk < 1.5 ? uRibbonHue.y : uRibbonHue.z;

  // note pulses travelling along this curtain
  float pulseW = 0.0;
  float pulseHue = 0.0;
  for (int i = 0; i < MAX_PULSES; i++) {
    vec4 p = uPulse[i];
    if (p.z <= 0.0 || abs(p.y - fk) > 0.5) continue;
    float d = (su - p.x) / p.w;
    float g = p.z * exp(-d * d);
    pulseW += g;
    pulseHue += g * uPulseHue[i];
  }
  height += uPulseLift * pulseW;
  light += uPulseBright * pulseW;
  // the pulse carries the note's colour: the curtain leans toward it where it passes
  float pull = pulseW / (pulseW + 0.35);
  hue = mix(hue, pulseHue / max(pulseW, 1e-4), pull);
  // a passing pulse also lights up an otherwise dark stretch a little
  patchy = max(patchy, clamp(pulseW, 0.0, 1.0) * 0.6);

  gl_FragColor = vec4(base + meander + folds, (0.04 + 0.96 * patchy) * rays * (1.0 - 0.3 * fk) * light, min(height, uTopScale), hue);
}
