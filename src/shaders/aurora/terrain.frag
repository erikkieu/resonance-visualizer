// ---------------------------------------------------------------------------
// Aurora scene: static terrain bake (runs only on resize).
// The mountains and the Milky Way never move, so their expensive noise is
// evaluated once into a texture:
//   r = Milky Way band intensity
//   g = snow cover
//   b = material: 0 sky, 0.5 far range, 1 near range
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

// mountain silhouettes (heights above the horizon, in screen units)
float farRange(float x) {
  float side = 0.45 + 0.75 * smoothstep(0.05, 0.8, abs(x));
  return 0.03 + 0.2 * pow(ridge(x * 1.1 + 4.0, 1.7), 2.2) * side;
}

float nearRange(float x) {
  float side = 0.2 + 1.0 * smoothstep(0.25, 1.0, abs(x + 0.1));
  return 0.012 + 0.15 * pow(ridge(x * 1.5 - 2.0, 9.3), 2.0) * side;
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
    float snowLine = 0.05 + 0.025 * snoise(vec2(x * 24.0, 1.0));
    snow = smoothstep(0.08, 0.14, fr) * smoothstep(snowLine, snowLine * 0.4, fr - y);
    snow *= smoothstep(0.25, 0.6, vnoise(vec2(x * 60.0 + y * 20.0, y * 7.0))); // rocky gullies
    material = 0.5;
  }
  float nr = nearRange(x);
  if (y < nr) {
    float snowLine = 0.035 + 0.02 * snoise(vec2(x * 30.0, 4.0));
    snow = smoothstep(0.07, 0.12, nr) * smoothstep(snowLine, snowLine * 0.3, nr - y);
    snow *= smoothstep(0.3, 0.65, vnoise(vec2(x * 80.0 + y * 30.0, y * 10.0)));
    material = 1.0;
  }
  gl_FragColor = vec4(band, snow, material, 1.0);
}
