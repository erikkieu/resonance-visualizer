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
// Colour depends on altitude: pink lower fringe, green body, violet crown.
// ---------------------------------------------------------------------------

uniform float uSteps;
uniform sampler2D tCurtains;
varying vec2 vUv;

const int CURTAINS = 3;

void main() {
  vec3 rd = viewRay(vUv);
  if (rd.y <= 0.002) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float t = uTime;
  // bass makes the curtains swell and flare upward
  float topAlt = 2.3 * (1.0 + 0.7 * uBass) * uHeight;
  float N = uSteps;
  // per-pixel jitter of the slice offsets hides banding between slices
  float jitter = hash12(gl_FragCoord.xy + fract(t * 7.0) * 13.0);

  vec3 green = mix(vec3(0.05, 1.0, 0.32), vec3(1.0, 0.2, 0.6), uSurge * 0.7);
  green = mix(green, vec3(0.85, 0.95, 0.35), uWarm * 0.6); // warm, golden-green at the climax
  vec3 violet = mix(vec3(0.45, 0.15, 1.0), vec3(1.0, 0.6, 0.85), uWarm * 0.5);
  vec3 magenta = vec3(0.9, 0.12, 0.55);

  // how far the footprint point moves between two slices: the sheet is
  // widened to at least that, so sparse slices never alias into speckle
  float slicePitch = (topAlt / N) * rd.z / rd.y;

  vec3 acc = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    if (fi >= N) break;
    float f = (fi + jitter) / N;               // 0 = curtain base, 1 = crown
    float alt = 0.9 + f * topAlt;              // slice altitude above the eye
    vec2 q = rd.xz * (alt / rd.y);             // where the ray crosses this slice
    if (q.y > 60.0) break;

    float glow = 0.0;
    float lu = clamp(q.x / 100.0 + 0.5, 0.0, 1.0);
    float w = (0.18 + 0.12 * f) * uWidth;
    float we = sqrt(w * w + 0.36 * slicePitch * slicePitch);
    for (int k = 0; k < CURTAINS; k++) {
      vec2 c = texture2D(tCurtains, vec2(lu, (float(k) + 0.5) / 3.0)).rg;
      float d = q.y - c.x;
      // thin sheet with a faint halo
      glow += c.y * (w / we) * (exp(-d * d / (we * we)) + 0.04 * exp(-abs(d) * 2.5));
    }

    vec3 col = mix(magenta * 0.7, green, smoothstep(0.0, 0.06, f));
    col = mix(col, violet, smoothstep(0.3, 0.75, f));
    col = mix(col, magenta * 0.8, smoothstep(0.7, 1.0, f) * 0.5);
    // bright at the base, fading toward the crown; distant sheets dimmer
    float fade = (0.35 + 0.65 * smoothstep(0.0, 0.05, f)) * exp(-f * 3.0) * exp(-q.y * 0.035);
    acc += col * glow * fade;
  }

  float brightness = (0.7 + 0.8 * uEnergy) * (1.0 + 0.45 * uBass) * (1.0 + 0.6 * uSurge) * uBright;
  // a thin sheet is crossed by only ~1-2 slices per pixel, hence the large gain
  vec3 col = acc * brightness * (175.0 / N);
  col *= smoothstep(0.0, 0.05, rd.y);
  gl_FragColor = vec4(col, 1.0);
}
