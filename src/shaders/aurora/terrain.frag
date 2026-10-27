// ---------------------------------------------------------------------------
// Aurora scene: static terrain bake (runs only on resize).
// The mountains and the Milky Way never move, so their expensive noise is
// evaluated once into a texture:
//   r = Milky Way band intensity
//   g = snow cover
//   b = material: 0 sky, 0.33 far range, 0.66 middle range, 1 near range
//   a = crest: 1 on a ridge line, fading down the slope (the aurora's rim light)
// Reference restyle 2: a low band across the frame (the water line at HORIZON,
// the peaks ~0.15 screen heights above it), tallest at left-centre, sloping
// down to the right and rising again at the far right; low far hills behind,
// low dark foothills along the shore. The silhouettes are sharp but not noisy
// (few octaves), the snow lies in streaks down the gullies from the ridges.
// ---------------------------------------------------------------------------

varying vec2 vUv;

float ridge(float x, float seed, int octaves) {
  float n = 0.0;
  float a = 0.5;
  float f = 1.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    n += a * (1.0 - abs(snoise(vec2(x * f, seed + float(i) * 3.1))));
    a *= 0.5;
    f *= 2.13;
  }
  return n;
}

// mountain silhouettes: heights above the water line (screen heights), xf = screen x 0..1

float farRange(float xf) {
  return 0.035 + 0.03 * ridge(xf * 3.0 + 4.0, 1.7, 3) + 0.02 * smoothstep(0.5, 0.9, xf);
}

// the main range: a broad massif at left-centre, a saddle, a rise at the far right
float midRange(float xf) {
  float mass = 0.105 * exp(-pow((xf - 0.3) / 0.17, 2.0));
  float right = 0.065 * smoothstep(0.7, 1.02, xf);
  float s = 0.025 + mass + right;
  return s + 0.04 * pow(ridge(xf * 4.0 + 2.0, 6.2, 4), 1.6) * (0.4 + 6.0 * (mass + right));
}

float nearRange(float xf) {
  float sides = smoothstep(0.42, 0.0, xf) + 0.7 * smoothstep(0.75, 1.05, xf);
  return 0.006 + 0.03 * sides * (0.6 + 0.6 * ridge(xf * 6.0 - 2.0, 9.3, 3));
}

// snow: streaks down the gullies (simplex noise stretched downhill), broken by rock ribs
float snowNoise(vec2 p) {
  return 0.5 + 0.3 * snoise(p * vec2(30.0, 6.0)) + 0.2 * snoise(mat2(0.9, 0.4, -0.4, 0.9) * p * vec2(70.0, 16.0) + 3.0);
}

void main() {
  float xf = vUv.x;
  float x = (vUv.x - 0.5) * uAspect;
  float y = vUv.y - HORIZON;
  if (y < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // faint Milky Way band with dusty structure
  vec2 mw = vec2(x * 0.8 + y * 0.6, y * 0.8 - x * 0.6);
  float band = exp(-pow((mw.y - 0.3) / 0.12, 2.0)) * (0.5 + 0.5 * fbm(mw * 6.0, 4));

  float snow = 0.0;
  float material = 0.0;
  float crest = 0.0;
  float fr = farRange(xf);
  if (y < fr) {
    snow = 0.5 * smoothstep(0.015, 0.0, fr - y);
    crest = smoothstep(0.006, 0.0, fr - y);
    material = 0.33;
  }
  float mr = midRange(xf);
  if (y < mr) {
    // snow from the ridge down, in streaks, less toward the foot
    float depth = mr - y;
    // streaks of uneven length that taper downhill, and a thin cap along the ridge
    // snow fields near the ridge breaking up into couloirs that taper downhill, between dark rock ribs
    float reach = 0.06 * (0.4 + 1.2 * (0.5 + 0.5 * snoise(vec2(x * 7.0, 2.0))));
    float down = depth / reach;
    float n = snowNoise(vec2(x, y));
    float field = 0.5 + 0.5 * snoise(vec2(x * 11.0, y * 6.0) + 9.0);
    snow = smoothstep(0.34 + 0.45 * down, 0.66 + 0.45 * down, 0.55 * n + 0.45 * field) * smoothstep(1.2, 0.6, down);
    crest = smoothstep(0.008, 0.0, depth);
    material = 0.66;
  }
  float nr = nearRange(xf);
  if (y < nr) {
    snow = 0.3 * smoothstep(0.012, 0.0, nr - y) * smoothstep(0.4, 0.7, snowNoise(vec2(x, y) * 1.3 + 5.0));
    crest = 0.5 * smoothstep(0.005, 0.0, nr - y);
    material = 1.0;
  }
  gl_FragColor = vec4(band, snow, material, crest);
}
