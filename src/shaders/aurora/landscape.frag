// ---------------------------------------------------------------------------
// Aurora scene: sky, stars, mountains, fjord reflection and shoreline.
// Static terrain comes from the baked tTerrain texture; the aurora comes
// from the low-resolution aurora pass, sampled directly for the sky and
// mirrored + rippled for the water. tAmbient (1x1) holds the average aurora
// light, used to light the snow, the rocks and the shoreline.
// ---------------------------------------------------------------------------

uniform sampler2D tAurora;
uniform sampler2D tTerrain;
uniform sampler2D tAmbient;
varying vec2 vUv;

vec3 starField(vec2 uv) {
  vec2 px = uv * uResolution;
  float scale = uResolution.y / 260.0; // cell size in pixels
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float s = scale * (layer == 0 ? 1.0 : 0.55);
    vec2 cell = floor(px / s);
    vec2 f = px - (cell + 0.5) * s;
    vec3 h = hash32(cell + float(layer) * 91.0);
    float thresh = layer == 0 ? 0.978 : 0.988;
    if (h.z > thresh) {
      vec2 o = (h.xy - 0.5) * s * 0.7;
      float d = length(f - o);
      float b = (h.z - thresh) / (1.0 - thresh);
      b = b * b * (layer == 0 ? 1.1 : 0.45);
      // twinkle: gentle always, sharper with treble
      float tw = 0.7 + 0.3 * sin(uTime * (1.5 + h.x * 4.0) + h.y * 40.0);
      tw *= 1.0 + uTreble * 0.9 * sin(uTime * 17.0 + h.x * 70.0);
      vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.92, 0.8), h.x);
      col += tint * b * tw * exp(-d * d / (0.55 + b));
    }
  }
  return col;
}

// Everything above the water line, for screen position uv.
vec3 above(vec2 uv, vec3 amb, float starGain) {
  vec3 rd = viewRay(uv);
  float y = uv.y - HORIZON;
  vec4 terrain = texture2D(tTerrain, uv);

  // sky gradient: deep teal-black at the horizon to dark purple overhead
  float h = clamp(rd.y / 0.55, 0.0, 1.0);
  vec3 col = mix(vec3(0.004, 0.022, 0.026), vec3(0.022, 0.01, 0.04), smoothstep(0.0, 0.9, h));
  col += vec3(0.0, 0.025, 0.02) * exp(-max(rd.y, 0.0) * 14.0); // airglow
  col += vec3(0.02, 0.022, 0.03) * terrain.r;                   // Milky Way
  col += starField(uv) * starGain * (1.0 + terrain.r * 1.5);
  col += texture2D(tAurora, uv).rgb;

  // mountains: near range (darker) in front of the far range (hazy, aurora-lit snow)
  if (terrain.b > 0.75) {
    vec3 rock = vec3(0.004, 0.007, 0.009) + amb * 0.02;
    col = mix(rock, vec3(0.05, 0.065, 0.08) + amb * 0.55, terrain.g);
  } else if (terrain.b > 0.25) {
    vec3 rock = vec3(0.01, 0.018, 0.025) + amb * 0.05;
    vec3 snowCol = vec3(0.1, 0.13, 0.16) + amb * 0.9;
    col = mix(rock, snowCol, terrain.g);
    col = mix(col, vec3(0.012, 0.03, 0.036) + amb * 0.1, 0.25); // atmospheric haze
  }
  // soft green glow where the far shore meets the water
  col += amb * 0.5 * exp(-y * 90.0) * step(0.0, y);
  return col;
}

// Rounded boulders along the foreground shore. Returns the rock top height.
float boulders(float x) {
  float xs = x / (uAspect * 0.5); // -1..1 across the screen
  float top = -1.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    // a cluster on each side, leaving the middle of the water open
    float cx = i < 4 ? -1.02 + 0.14 * fi : 0.62 + 0.14 * (fi - 4.0);
    float r = 0.07 + 0.07 * hash11(fi * 7.3);
    float d = xs - cx;
    if (abs(d) < r) top = max(top, 0.015 + 0.04 * hash11(fi * 3.1) + sqrt(r * r - d * d) * 0.45);
  }
  return top;
}

void main() {
  vec2 uv = vUv;
  vec3 amb = texture2D(tAmbient, vec2(0.5)).rgb;
  vec3 col;

  if (uv.y >= HORIZON) {
    col = above(uv, amb, 1.0);
  } else {
    // --- water: the ray hits a plane one unit below the eye
    vec3 rd = viewRay(uv);
    float t = -1.0 / rd.y;
    vec2 w = rd.xz * t;
    float depth = (HORIZON - uv.y) / HORIZON; // 0 at horizon, 1 at the bottom

    // long, low swells across the view plus finer wavelets
    float tt = uTime * 0.4;
    vec2 wp = vec2(w.x * 0.35, w.y * 1.4);
    float n0 = snoise(vec3(wp, tt));
    float n1 = snoise(vec3(wp * vec2(2.3, 2.9) + 7.0, tt * 1.6));
    vec2 slope = vec2(0.25 * n1, n0 + 0.5 * n1);

    // mirrored sample, displaced by the ripples (more near the viewer)
    vec2 ruv = vec2(uv.x, 2.0 * HORIZON - uv.y);
    ruv += slope * vec2(0.003, 0.01) * (0.3 + depth * 1.5);
    ruv.y = max(ruv.y, HORIZON + 0.0005);
    vec3 refl = above(ruv, amb, 0.35);

    // fresnel-ish: grazing angles reflect more
    float fres = mix(0.8, 0.3, pow(depth, 0.7));
    vec3 water = vec3(0.002, 0.008, 0.01);
    col = water + refl * fres;
    // thin bright ripple glints catch the aurora
    col += amb * 0.25 * smoothstep(0.55, 1.0, n0) * (1.0 - depth);

    // --- foreground shoreline rocks with a green aurora rim light
    float x = (uv.x - 0.5) * uAspect;
    float top = boulders(x);
    float y = uv.y;
    if (y < top) {
      float edge = top - y;
      vec3 rock = vec3(0.003, 0.005, 0.006);
      rock += amb * 0.35 * smoothstep(0.07, 0.0, edge); // soft green wash
      rock += amb * 2.5 * smoothstep(0.005, 0.0, edge); // rim
      rock *= 0.85 + 0.3 * vnoise(vec2(x * 60.0, y * 60.0));
      col = rock;
    } else if (top > 0.0) {
      // glow reflected in the water just above each boulder
      col += amb * 0.15 * exp(-(y - top) * 40.0);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
