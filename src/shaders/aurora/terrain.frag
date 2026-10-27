// ---------------------------------------------------------------------------
// Aurora scene: static terrain bake (runs only on resize).
// The mountains and the Milky Way never move, so their expensive noise is
// evaluated once into a texture:
//   r = Milky Way band intensity
//   g = snow cover
//   b = material: 0 sky, 0.33 far range, 0.66 middle range, 1 near range
// The mountains frame a V-shaped fjord (reference restyle): steep near slopes
// on both sides, a middle range behind them, and low far hills across.
// ---------------------------------------------------------------------------

varying vec2 vUv;

float ridge(float x, float seed) {
  float n = 0.0;
  float a = 0.5;
  float f = 1.0;
  for (int i = 0; i < 5; i++) {
    n += a * (1.0 - abs(snoise(vec2(x * f, seed + float(i) * 3.1))));
    a *= 0.5;
    f *= 2.13;
  }
  return n;
}

// mountain silhouettes (heights above the horizon, in screen heights; x from the centre)
float vSlope(float x, float inL, float inR, float hL, float hR, float reach) {
  float l = hL * pow(clamp((inL - x) / reach, 0.0, 1.0), 0.85);
  float r = hR * pow(clamp((x - inR) / reach, 0.0, 1.0), 0.85);
  return max(l, r);
}

float farRange(float x) {
  return 0.008 + 0.045 * pow(ridge(x * 2.2 + 4.0, 1.7), 2.0) * (0.4 + smoothstep(0.0, 0.5, abs(x + 0.15)));
}

// a slope plus jagged peaks along it
float midRange(float x) {
  float s = vSlope(x, -0.02, 0.26, 0.28, 0.25, 0.7);
  return 0.01 + s * (0.7 + 0.35 * ridge(x * 1.4 + 1.0, 5.1)) + 0.08 * pow(ridge(x * 4.5 + 2.0, 6.2), 2.5) * smoothstep(0.0, 0.08, s);
}

float nearRange(float x) {
  float s = vSlope(x, -0.2, 0.45, 0.42, 0.36, 0.62);
  return s * (0.72 + 0.3 * ridge(x * 1.5 - 2.0, 9.3)) + 0.1 * pow(ridge(x * 3.8 - 1.0, 3.3), 2.5) * smoothstep(0.0, 0.08, s);
}

// snow: streaks down the gullies (simplex noise stretched downhill), broken by rock ribs
float snowNoise(vec2 p) {
  return 0.5 + 0.32 * snoise(p * vec2(38.0, 11.0)) + 0.18 * snoise(p * vec2(110.0, 30.0) + 3.0);
}

void main() {
  float x = (vUv.x - 0.5) * uAspect;
  float y = vUv.y - HORIZON;
  if (y < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // faint Milky Way band with dusty structure
  vec2 mw = vec2(x * 0.8 + y * 0.6, y * 0.8 - x * 0.6);
  float band = exp(-pow((mw.y - 0.18) / 0.12, 2.0)) * (0.5 + 0.5 * fbm(mw * 6.0, 4));

  float snow = 0.0;
  float material = 0.0;
  float fr = farRange(x);
  if (y < fr) {
    snow = 0.6 * smoothstep(0.02, 0.0, fr - y);
    material = 0.33;
  }
  float mr = midRange(x);
  if (y < mr) {
    // snow down most of the slope, broken by rocky ribs
    float snowLine = 0.12 + 0.05 * snoise(vec2(x * 14.0, 1.0));
    snow = smoothstep(snowLine, snowLine * 0.3, mr - y + 0.04 * smoothstep(0.05, 0.25, mr));
    snow *= smoothstep(0.25, 0.7, snowNoise(vec2(x, y)));
    material = 0.66;
  }
  float nr = nearRange(x);
  if (y < nr) {
    float snowLine = 0.1 + 0.05 * snoise(vec2(x * 18.0, 4.0));
    snow = smoothstep(snowLine, snowLine * 0.25, nr - y);
    snow *= smoothstep(0.3, 0.75, snowNoise(vec2(x, y) * 1.3 + 5.0));
    material = 1.0;
  }
  gl_FragColor = vec4(band, snow, material, 1.0);
}
