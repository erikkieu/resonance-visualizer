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
// Each curtain has its own height and colour along its length (the audio
// wave: spectrum and note pulses, curtains.frag). Colour comes from the
// AURORA.RAMP: a bright, slightly whitened lower edge, the ramp colour in
// the body, and the crown further up the ramp (toward violet / pink),
// twisted per curtain by the note's pitch class (uHueRot). A soft per-pixel
// cap (uCap) keeps the aurora from washing out the scene.
// ---------------------------------------------------------------------------

#define RAMP_STOPS 6

uniform float uSteps;
uniform sampler2D tCurtains;
uniform vec3 uRamp[RAMP_STOPS];   // linear colours
uniform float uRampAt[RAMP_STOPS];
uniform vec3 uHueRot;             // radians per curtain
uniform float uCrest;             // ramp offset of the crown
uniform float uTopScale;          // tallest possible curtain (relative height)
uniform float uAmp;
uniform float uCap;
uniform float uOn;                // 0..1, the A key fades the aurora out
varying vec2 vUv;

const int CURTAINS = 3;

vec3 ramp(float h) {
  h = clamp(h, 0.0, 1.0);
  vec3 c = uRamp[0];
  for (int i = 1; i < RAMP_STOPS; i++) {
    float f = clamp((h - uRampAt[i - 1]) / max(uRampAt[i] - uRampAt[i - 1], 1e-4), 0.0, 1.0);
    c = mix(c, uRamp[i], f * f * (3.0 - 2.0 * f));
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
  float topAlt = 2.3 * (1.0 + 0.3 * uBass) * uHeight * uTopScale;
  float N = uSteps;
  // per-pixel jitter of the slice offsets hides banding between slices
  float jitter = hash12(gl_FragCoord.xy + fract(t * 7.0) * 13.0);
  float rot[3];
  rot[0] = uHueRot.x;
  rot[1] = uHueRot.y;
  rot[2] = uHueRot.z;

  // how far the footprint point moves between two slices: the sheet is
  // widened to at least that, so sparse slices never alias into speckle
  float slicePitch = (topAlt / N) * rd.z / rd.y;

  vec3 acc = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    if (fi >= N) break;
    float f = (fi + jitter) / N;               // 0 = base, 1 = top of the tallest curtain
    float alt = 0.9 + f * topAlt;              // slice altitude above the eye
    vec2 q = rd.xz * (alt / rd.y);             // where the ray crosses this slice
    if (q.y > 60.0) break;

    float lu = clamp(q.x / 100.0 + 0.5, 0.0, 1.0);
    float w = (0.18 + 0.12 * f) * uWidth;
    float we = sqrt(w * w + 0.36 * slicePitch * slicePitch);
    for (int k = 0; k < CURTAINS; k++) {
      vec4 c = texture2D(tCurtains, vec2(lu, (float(k) + 0.5) / 3.0));
      // height within this curtain (its own height varies along it with the music)
      float lf = f * uTopScale / max(c.b, 0.05);
      if (lf > 1.25) continue;
      float d = q.y - c.x;
      // thin sheet with a faint halo
      float glow = c.y * (w / we) * (exp(-d * d / (we * we)) + 0.04 * exp(-abs(d) * 2.5));
      // colour: whitened bright lower edge -> ramp body -> crown further up the ramp
      vec3 body = ramp(c.a);
      vec3 col = mix(mix(body, vec3(1.0), 0.35), body, smoothstep(0.0, 0.08, lf));
      col = mix(col, ramp(c.a + uCrest), smoothstep(0.35, 0.9, lf));
      col = hueRotate(col, rot[k]);
      // bright at the base, fading up into the soft crown, gone above the curtain's top
      float fade = (0.35 + 0.65 * smoothstep(0.0, 0.05, lf)) * exp(-lf * 2.6) * (1.0 - smoothstep(0.85, 1.25, lf));
      acc += col * glow * fade * exp(-q.y * 0.035);
    }
  }

  float brightness = (0.8 + 0.5 * uEnergy) * (1.0 + 0.25 * uBass) * (1.0 + 0.4 * uSurge) * uBright;
  // a thin sheet is crossed by only ~1-2 slices per pixel, hence the large gain;
  // x uTopScale: the slices span the tallest possible curtain, so each curtain gets that much fewer of them
  vec3 col = acc * brightness * (175.0 / N) * uTopScale * uOn;
  col *= smoothstep(0.0, 0.05, rd.y);
  // soft cap: bright pixels saturate toward uCap instead of clipping to white
  float m = max(max(col.r, col.g), col.b);
  col *= uCap * (1.0 - exp(-m / uCap)) / max(m, 1e-4);
  gl_FragColor = vec4(col, 1.0);
}
