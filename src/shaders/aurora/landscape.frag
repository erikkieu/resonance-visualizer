// ---------------------------------------------------------------------------
// Aurora scene: sky, stars, mountains, fjord reflection and shoreline.
// Static terrain comes from the baked tTerrain texture; the aurora comes
// from the low-resolution aurora pass, sampled directly for the sky and
// mirrored + rippled for the water. tAmbient (1x1) holds the average aurora
// light, used to light the snow, the rocks and the shoreline.
// The aurora is laid on like glowing paint (paintedAurora): short directional
// brush strokes along long arcs sweeping around a centre above the sky,
// the light dragged along each stroke, bristle lines and an impasto
// highlight on the ridge of bright strokes; the bare sky shows a faint
// trace of the same strokes, and is never covered (the light is added).
// The night progression (uNight, uDawn; PROFILE.NIGHT) sets the sky: a deep
// blue dusk with a warm band low in the west (left), cooling and sinking as
// the night deepens; the black-blue deepest night with every star and a
// hint of the Milky Way; then a pale blue to rose glow in the east (right)
// as dawn comes, the stars thinning from the horizon upward. It also
// lights the snow, darkens the water and sets the aurora's strength.
// ---------------------------------------------------------------------------

uniform sampler2D tAurora;
uniform vec4 uPaint;   // x = stroke amount, y = stroke length, z = stroke width, w = smear (screen heights)
uniform vec4 uPaint2;  // x = impasto, y = sky strokes, zw = swirl centre (screen x, height)
uniform sampler2D tTerrain;
uniform sampler2D tAmbient;
uniform vec3 uSkyDusk[2];    // horizon, zenith at night 0
uniform vec3 uSkyNight[2];   // horizon, zenith at night 1
uniform vec3 uDuskWarm;      // the dusk glow, warm (night 0) ...
uniform vec3 uDuskCool;      // ... cooling to teal-blue
uniform vec4 uDuskGlow;      // xy = night range of the cooling, z = night where it is gone, w = strength
uniform vec3 uDawnLow;       // the dawn glow at the horizon ...
uniform vec3 uDawnHigh;      // ... and above it
uniform vec4 uGlowHeight;    // x = dusk glow height, y = dawn glow height (view-ray y), z = dawn strength
uniform vec4 uStars;         // x = brightness, y = share shown (brightest first), z = dawn reach
uniform float uMilkyWay;
uniform vec4 uNightAurora;   // x = aurora gain, y = saturation
uniform vec3 uWater;         // base water colour at night 0
uniform float uSnowGlow;
uniform vec2 uAuroraBlur;    // x = radius px, y = 1: 3x3 tent (clean), 0: the previous 5 taps
varying vec2 vUv;

// the stars: the brightest `shown` share of the field (fading in from the brightest down)
vec3 starField(vec2 uv, float shown) {
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
      // the faint layer only shows in the second half of the night's stars
      float sh = layer == 0 ? shown : clamp(2.0 * shown - 1.0, 0.0, 1.0);
      float vis = smoothstep(1.0 - sh - 0.1, 1.0 - sh + 0.02, b);
      b = b * b * (layer == 0 ? 1.1 : 0.45);
      // twinkle: gentle always, sharper with treble
      float tw = 0.7 + 0.3 * sin(uTime * (1.5 + h.x * 4.0) + h.y * 40.0);
      tw *= 1.0 + uTreble * 0.9 * sin(uTime * 17.0 + h.x * 70.0);
      vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.92, 0.8), h.x);
      col += tint * b * tw * vis * exp(-d * d / (0.55 + b));
    }
  }
  return col;
}

// The brush stroke under screen position uv: x = paint (0 in the gaps, up to ~1.4),
// y = ridge (the stroke's crest), z = the stroke's random id; dir = the stroke direction (uv units).
vec3 brush(vec2 uv, out vec2 dir) {
  vec2 p = vec2((uv.x - uPaint2.z) * uAspect, uv.y - uPaint2.w);
  float r = length(p);
  // wobble the arcs so they never look ruled
  r += 0.025 * (vnoise(p * 3.0) - 0.5) + 0.006 * (vnoise(p * 17.0) - 0.5);
  vec2 tang = normalize(vec2(-p.y, p.x));
  dir = vec2(tang.x / uAspect, tang.y);
  float along = atan(p.x, -p.y) * r;
  float W = uPaint.z;
  float L = uPaint.y;
  float row = floor(r / W);
  float fr = fract(r / W);
  float cellA = along / L + hash11(row * 1.37) * 7.0;
  float fa = fract(cellA);
  float h = hash12(vec2(row, floor(cellA)));
  // tapered ends (random length), rounded across, bristle lines inside
  float len = 0.65 + 0.35 * h;
  float body = smoothstep(0.0, 0.15, fa) * smoothstep(len, len - 0.25, fa);
  float across = 1.0 - pow(abs(fr * 2.0 - 1.0), 2.5);
  float bristle = 0.72 + 0.28 * sin(fr * 23.0 + h * 40.0);
  float v = body * across * bristle * (0.65 + 0.7 * h);
  float ridge = body * smoothstep(0.5, 0.95, 1.0 - abs(fr * 2.0 - 0.75));
  return vec3(v, ridge, h);
}

vec3 paintedAurora(vec2 uv, out float stroke) {
  stroke = 0.5;
  if (uPaint.x <= 0.0 && uPaint2.x <= 0.0) {
    // painting off: smooth, continuous light (a soft blur hides the volume march's jitter grain)
    vec2 o = uAuroraBlur.x / uResolution;
    if (uAuroraBlur.y > 0.5) {
      // 3x3 tent: a stable kernel, no shimmer
      vec3 c = 0.25 * texture2D(tAurora, uv).rgb;
      c += 0.125 * (texture2D(tAurora, uv + vec2(o.x, 0.0)).rgb + texture2D(tAurora, uv - vec2(o.x, 0.0)).rgb
                  + texture2D(tAurora, uv + vec2(0.0, o.y)).rgb + texture2D(tAurora, uv - vec2(0.0, o.y)).rgb);
      c += 0.0625 * (texture2D(tAurora, uv + o).rgb + texture2D(tAurora, uv - o).rgb
                   + texture2D(tAurora, uv + vec2(o.x, -o.y)).rgb + texture2D(tAurora, uv + vec2(-o.x, o.y)).rgb);
      return c;
    }
    return 0.4 * texture2D(tAurora, uv).rgb
         + 0.15 * (texture2D(tAurora, uv + vec2(o.x, o.y)).rgb + texture2D(tAurora, uv + vec2(-o.x, o.y)).rgb
                 + texture2D(tAurora, uv + vec2(o.x, -o.y)).rgb + texture2D(tAurora, uv - o).rgb);
  }
  vec2 dir;
  vec3 b = brush(uv, dir);
  stroke = b.x;
  // the light dragged along the stroke
  vec2 sm = dir * uPaint.w;
  vec3 a = 0.3 * texture2D(tAurora, uv).rgb
         + 0.2 * (texture2D(tAurora, uv + sm * 0.5).rgb + texture2D(tAurora, uv - sm * 0.5).rgb)
         + 0.15 * (texture2D(tAurora, uv + sm).rgb + texture2D(tAurora, uv - sm).rgb);
  // broken into strokes: the gaps keep some of the light, the strokes carry more
  vec3 col = a * mix(1.0, 0.35 + 1.1 * b.x, uPaint.x);
  col *= 1.0 + 0.12 * (b.z - 0.5) * uPaint.x; // stroke-to-stroke variation
  float lum = dot(a, vec3(0.2126, 0.7152, 0.0722));
  col += mix(a, vec3(lum * 1.3), 0.6) * b.y * uPaint2.x * smoothstep(0.01, 0.25, lum);
  return col;
}

// The low glow of dusk (west, left) and dawn (east, right) at view-ray height ry.
vec3 horizonGlow(float ry, float x) {
  float n = uNight;
  float dusk = (1.0 - smoothstep(0.0, uDuskGlow.z, n)) * uDuskGlow.w;
  vec3 duskCol = mix(uDuskWarm, uDuskCool, smoothstep(uDuskGlow.x, uDuskGlow.y, n));
  float duskH = uGlowHeight.x * (1.0 - 0.5 * smoothstep(0.15, 0.5, n)); // it sinks as it fades
  float west = 0.55 + 0.7 * exp(-pow((x - 0.2) / 0.55, 2.0));
  vec3 col = duskCol * dusk * west * exp(-ry / duskH);
  float dawnH = uGlowHeight.y * (0.5 + 0.7 * uDawn);
  float east = 0.55 + 0.7 * exp(-pow((x - 0.8) / 0.55, 2.0));
  col += mix(uDawnLow, uDawnHigh, smoothstep(0.0, dawnH, ry)) * uDawn * uGlowHeight.z * east * exp(-ry / dawnH);
  return col;
}

// Everything above the water line, for screen position uv.
vec3 above(vec2 uv, vec3 amb, float starGain) {
  vec3 rd = viewRay(uv);
  float y = uv.y - HORIZON;
  vec4 terrain = texture2D(tTerrain, uv);
  float ry = max(rd.y, 0.0);

  // sky gradient, horizon -> zenith, from the deep blue of dusk to the black-blue of deepest night
  float h = clamp(rd.y / 0.55, 0.0, 1.0);
  vec3 horizonCol = mix(uSkyDusk[0], uSkyNight[0], uNight);
  vec3 zenithCol = mix(uSkyDusk[1], uSkyNight[1], uNight);
  vec3 col = mix(horizonCol, zenithCol, smoothstep(0.0, 0.9, h));
  col += vec3(0.0, 0.025, 0.02) * exp(-ry * 14.0) * (0.4 + 0.6 * uNight); // airglow
  vec3 glow = horizonGlow(ry, uv.x);
  col += glow;
  col += vec3(0.02, 0.022, 0.03) * terrain.r * uMilkyWay;                 // Milky Way
  // stars: fewer and dimmer at dusk; at dawn they thin from the horizon upward
  float cut = uDawn * uStars.z;
  float thin = mix(1.0, smoothstep(cut - 0.25, cut + 0.05, h), smoothstep(0.0, 0.1, uDawn)) * (1.0 - 0.5 * uDawn);
  col += starField(uv, uStars.y) * starGain * uStars.x * thin * (1.0 + terrain.r * 1.5);
  float stroke;
  vec3 aurora = paintedAurora(uv, stroke);
  // pale and faint at dusk, vivid at night, giving way to the dawn
  aurora = mix(vec3(dot(aurora, vec3(0.2126, 0.7152, 0.0722))), aurora, uNightAurora.y) * uNightAurora.x;
  col *= 1.0 + uPaint2.y * (stroke - 0.5); // a faint trace of the strokes in the bare sky
  col += aurora;

  // mountains: near range (darker) in front of the far range (hazy, aurora-lit snow)
  if (terrain.b > 0.75) {
    vec3 rock = vec3(0.004, 0.007, 0.009) + amb * 0.02;
    col = mix(rock, vec3(0.05, 0.065, 0.08) + amb * 0.55, terrain.g);
  } else if (terrain.b > 0.25) {
    vec3 rock = vec3(0.01, 0.018, 0.025) + amb * 0.05;
    vec3 snowCol = vec3(0.1, 0.13, 0.16) + amb * 0.9 + horizonGlow(0.02, uv.x) * uSnowGlow; // dusk / dawn light on the snow
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
  vec3 amb = texture2D(tAmbient, vec2(0.5)).rgb * uNightAurora.x;
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
    vec3 water = mix(uWater, vec3(0.001, 0.004, 0.005), uNight);
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
