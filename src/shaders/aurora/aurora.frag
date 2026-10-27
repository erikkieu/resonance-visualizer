// ---------------------------------------------------------------------------
// Aurora curtains (low resolution, additive HDR output).
//
// Each curtain is a thin, folded sheet standing on the ground plane: on the
// map (x, z) it is a wiggly line z = f(x), stored per curtain in the
// tCurtains lookup table (see curtains.frag). We march upward through a
// stack of horizontal slices; at each slice the view ray crosses the map at
// some (x, z) and picks up light if it is close to a curtain line. Because
// every slice re-samples the same footprint, the light stacks into tall
// vertical sheets in correct perspective, and folds seen edge-on come out
// brightest, as in real aurora photographs.
// Each curtain has its own height, light and colour along its length (the
// two-layer wave aurora, curtains.frag). Curtains 0-1 are the melody layer,
// coloured from uRampMel, 2-3 the low layer, from uRampLow: a bright,
// slightly whitened lower edge, the ramp colour in the body and the crown
// further along the ramp, twisted per curtain by the note's pitch class
// (uHueRot). The two layers are accumulated apart and combined by uScreen
// (0 = add, 1 = screen); a soft per-pixel cap (uCap) keeps the aurora from
// washing out the scene.
// ---------------------------------------------------------------------------

#define RAMP_STOPS 6

uniform float uSteps;
uniform sampler2D tCurtains;
uniform vec3 uRampMel[RAMP_STOPS];   // linear colours (unused stops repeat the last)
uniform float uRampMelAt[RAMP_STOPS];
uniform vec3 uRampLow[RAMP_STOPS];
uniform float uRampLowAt[RAMP_STOPS];
uniform vec4 uHueRot;             // radians per curtain
uniform vec4 uRowSheet;           // sheet thickness per curtain
uniform float uCrest;             // ramp offset of the crown
uniform float uScreen;            // 0 = the layers add, 1 = screen blend
uniform float uTopScale;          // tallest possible curtain (relative height)
uniform float uCap;
uniform float uOn;                // 0..1, the A key fades the aurora out
uniform vec4 uRays;               // x = ray bottom altitude, y = × slice span (tall rays), z = soft lower edge, w = fade toward the top
uniform vec2 uRays2;              // x = white cores, y = saturation
uniform vec2 uNoise;              // x = curtain edge softness, y = 1: slice jitter fixed in screen space (0: re-seeded every frame)
varying vec2 vUv;

const int CURTAINS = 4;

vec3 ramp(float h, bool mel) {
  h = clamp(h, 0.0, 1.0);
  vec3 c = mel ? uRampMel[0] : uRampLow[0];
  for (int i = 1; i < RAMP_STOPS; i++) {
    float a = mel ? uRampMelAt[i - 1] : uRampLowAt[i - 1];
    float b = mel ? uRampMelAt[i] : uRampLowAt[i];
    float f = clamp((h - a) / max(b - a, 1e-4), 0.0, 1.0);
    c = mix(c, mel ? uRampMel[i] : uRampLow[i], f * f * (3.0 - 2.0 * f));
  }
  return c;
}

// hue rotation about the grey axis (keeps the brightness, turns the hue)
vec3 hueRotate(vec3 c, float a) {
  float cs = cos(a);
  float sn = sin(a);
  float k = (1.0 - cs) / 3.0;
  float s3 = 0.57735 * sn;
  return max(vec3(
    (cs + k) * c.r + (k - s3) * c.g + (k + s3) * c.b,
    (k + s3) * c.r + (cs + k) * c.g + (k - s3) * c.b,
    (k - s3) * c.r + (k + s3) * c.g + (cs + k) * c.b
  ), 0.0);
}

void main() {
  vec3 rd = viewRay(vUv);
  if (rd.y <= 0.002 || uOn <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float t = uTime;
  // the slices cover the tallest curtain; bass swells the curtains gently
  float topAlt = 2.3 * (1.0 + 0.3 * uBass) * uHeight * uTopScale * uRays.y;
  float N = uSteps;
  // per-pixel jitter of the slice offsets hides banding between slices: a fixed
  // interleaved-gradient pattern (blue-noise-like, vanishes under the composite's blur),
  // or (the previous look) white noise re-seeded every frame, which boils
  float jitter = uNoise.y > 0.5
    ? fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))
    : hash12(gl_FragCoord.xy + fract(t * 7.0) * 13.0);
  float rot[4];
  rot[0] = uHueRot.x;
  rot[1] = uHueRot.y;
  rot[2] = uHueRot.z;
  rot[3] = uHueRot.w;
  float sheet[4];
  sheet[0] = uRowSheet.x;
  sheet[1] = uRowSheet.y;
  sheet[2] = uRowSheet.z;
  sheet[3] = uRowSheet.w;

  // how far the footprint point moves between two slices: the sheet is
  // widened to at least that, so sparse slices never alias into speckle
  float slicePitch = (topAlt / N) * rd.z / rd.y;

  vec3 accMel = vec3(0.0);
  vec3 accLow = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    if (fi >= N) break;
    float f = (fi + jitter) / N;               // 0 = base, 1 = top of the tallest curtain
    float alt = uRays.x + f * topAlt;          // slice altitude above the eye
    vec2 q = rd.xz * (alt / rd.y);             // where the ray crosses this slice
    if (q.y > 60.0) break;

    float lu = clamp(q.x / 100.0 + 0.5, 0.0, 1.0);
    for (int k = 0; k < CURTAINS; k++) {
      bool mel = k < 2;
      float w = (0.18 + 0.12 * f) * uWidth * sheet[k] * uNoise.x;
      float we = sqrt(w * w + 0.36 * slicePitch * slicePitch);
      vec4 c = texture2D(tCurtains, vec2(lu, (float(k) + 0.5) / 4.0));
      // height within this curtain (its own height varies along it with the music)
      float lf = f * uTopScale / max(c.b, 0.05);
      if (lf > 1.25) continue;
      float d = q.y - c.x;
      // thin sheet with a faint halo
      float glow = c.y * (w / we) * (exp(-d * d / (we * we)) + 0.04 * exp(-abs(d) * 2.5));
      // colour: near-white core in the bright lower part -> ramp body -> crown further up the ramp
      vec3 body = ramp(c.a, mel);
      vec3 col = mix(body, vec3(1.0), uRays2.x * (1.0 - smoothstep(0.02, 0.4, lf)) * smoothstep(0.1, 1.2, c.y));
      col = mix(col, ramp(c.a + uCrest, mel), smoothstep(0.35, 0.9, lf));
      col = hueRotate(col, rot[k]);
      // a soft lower edge, brightest in the lower-middle of the ray, fading smoothly up to its top
      float fade = smoothstep(0.0, uRays.z, lf) * exp(-lf * uRays.w) * (1.0 - smoothstep(0.85, 1.25, lf));
      vec3 light = col * glow * fade * exp(-q.y * 0.035);
      if (mel) accMel += light;
      else accLow += light;
    }
  }

  float brightness = (0.8 + 0.5 * uEnergy) * (1.0 + 0.25 * uBass) * (1.0 + 0.4 * uSurge) * uBright;
  // a thin sheet is crossed by only ~1-2 slices per pixel, hence the large gain;
  // x uTopScale: the slices span the tallest possible curtain, so each curtain gets that much fewer of them
  float gain = brightness * (175.0 / N) * uTopScale * uOn;
  accMel *= gain;
  accLow *= gain;
  // where the layers cross their light adds up (screen: softer where both are bright)
  // (the screen term stays under min(mel, low), so the sum never drops below the brighter layer)
  vec3 col = accMel + accLow - uScreen * accMel * accLow / (accMel + accLow + 1e-4);
  col = max(mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, uRays2.y), 0.0); // pale, desaturated (the climax opens it up)
  col *= smoothstep(0.0, 0.05, rd.y);
  // soft cap: bright pixels saturate toward uCap instead of clipping to white
  float m = max(max(col.r, col.g), col.b);
  col *= uCap * (1.0 - exp(-m / uCap)) / max(m, 1e-4);
  gl_FragColor = vec4(col, 1.0);
}
