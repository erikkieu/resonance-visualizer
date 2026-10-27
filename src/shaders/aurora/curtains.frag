// ---------------------------------------------------------------------------
// Aurora curtain lookup table (4096 x 4, recomputed every frame).
// Each row is one curtain; each column a position x along it (-50..50 map
// units). Precomputing the slowly varying shape here means the volume march
// needs one texture fetch per curtain per slice instead of several noises.
//   r = z of the curtain's centre line (base distance + meander + folds,
//       bent into a long arc, bowed toward the viewer where a wave passes)
//   g = brightness along the curtain (a faint glow + the wave packets,
//       x the vertical rays)
//   b = the curtain's height at this point (1 = the scene's plain height)
//   a = colour: position on the curtain's layer ramp
// Curtains 0-1 belong to the melody layer (0 nearest, spanning the upper
// sky), 2-3 to the low layer (farther, lower in the sky). Every note of a
// layer is a packet (uPacket): a soft swell travelling across the screen
// along its curtain, which lifts, brightens and bows the curtain where it
// passes and carries the note's colour. Packets 0-11 are the melody's,
// 12-23 the low layer's; all are evaluated here in one pass.
// ---------------------------------------------------------------------------

#define MAX_PACKETS 24

uniform vec4 uPacket[MAX_PACKETS];   // x = screen position 0..1, y = curtain (fractional), z = strength x envelope, w = width
uniform vec4 uPacketShape[MAX_PACKETS]; // x = ramp position, y = lift, z = travel direction x front width (signed)
uniform vec4 uRowHeight;   // base height per curtain
uniform vec4 uRowHue;      // base ramp position per curtain
uniform vec4 uRowBright;   // packet brightness per curtain
uniform vec4 uRowBend;     // how far a packet bows the curtain toward the viewer
uniform vec4 uRowCurve;    // the curtain's arc (map units at the screen edges)
uniform vec4 uRowStria;    // vertical ray frequency
uniform float uGlow;       // faint light along every curtain (x amplitude)
uniform float uTopScale;   // height the slices cover (tallest possible curtain)
uniform vec4 uRowZ;        // distance of each curtain (LOOK.RAYS.DEPTH)
uniform vec4 uRay;         // x = octaves, y = frequency (× uRowStria), z = contrast, w = treble -> contrast
varying vec2 vUv;

float pick(vec4 v, float k) {
  return k < 0.5 ? v.x : k < 1.5 ? v.y : k < 2.5 ? v.z : v.w;
}

void main() {
  float x = (vUv.x - 0.5) * 100.0;
  float fk = floor(vUv.y * 4.0);
  float t = uTime;

  float base = pick(uRowZ, fk);
  // where this point of the curtain appears across the screen (0 = left edge)
  float su = 0.5 + x * FOCAL / (base * uAspect);
  float meander = 4.0 * (vnoise(vec2(x * 0.035 + fk * 9.1, t * 0.018 + fk)) - 0.5) * 2.0;
  float fold = 0.32 + 0.35 * uMid; // mid: fold frequency
  float folds = ((1.6 - 0.25 * fk) * sin(x * fold + t * (0.5 + 0.1 * fk) + fk * 2.3)
              + 0.5 * sin(x * fold * 2.3 - t * 0.7 + fk)) * uFold;
  float arc = pick(uRowCurve, fk) * 4.0 * (su - 0.5) * (su - 0.5);

  // the wave packets riding this curtain
  float w = 0.0;
  float hue = 0.0;
  float lift = 0.0;
  for (int i = 0; i < MAX_PACKETS; i++) {
    vec4 p = uPacket[i];
    if (p.z <= 0.0) continue;
    float wk = 1.0 - abs(p.y - fk);
    if (wk <= 0.0) continue;
    vec4 q = uPacketShape[i];
    float d = su - p.x;
    // the leading edge (in the travel direction) is crisper
    float wd = p.w * (d * q.z > 0.0 ? abs(q.z) : 1.0);
    float g = p.z * wk * exp(-d * d / (wd * wd));
    w += g;
    hue += g * q.x;
    lift += g * q.y;
  }

  // a faint, patchy glow keeps every curtain alive between the waves
  float patchy = smoothstep(0.35, 0.9, vnoise(vec2(x * 0.06 + t * 0.03, fk * 5.0)));
  // (mostly continuous: the waves run along an unbroken curtain)
  float light = uGlow * (0.6 + 0.4 * patchy) + pick(uRowBright, fk) * w;
  // vertical rays: fine for the melody, broad and gentle for the low layer; the
  // pattern drifts along the curtain with the clock (advected, never re-seeded)
  float rays = 0.0;
  float norm = 0.0;
  float a = 1.0;
  float f = pick(uRowStria, fk) * uRay.y;
  for (int o = 0; o < 3; o++) {
    if (float(o) >= uRay.x) break;
    rays += a * vnoise(vec2(x * f - t * 0.25, fk * 3.0 + t * 0.05 + float(o) * 7.3));
    norm += a;
    a *= 0.45;
    f *= 2.1;
  }
  rays /= norm;
  rays = mix(1.0, 0.25 + 1.1 * rays * rays, clamp(uRay.z + uRay.w * uTreble, 0.0, 1.0));
  float col = mix(pick(uRowHue, fk), hue / max(w, 1e-4), w / (w + 0.12));
  float z = base + meander + folds + arc - pick(uRowBend, fk) * min(w, 1.5);
  float height = pick(uRowHeight, fk) + lift;

  gl_FragColor = vec4(z, light * rays * (1.0 - 0.12 * fk), min(height, uTopScale), col);
}
