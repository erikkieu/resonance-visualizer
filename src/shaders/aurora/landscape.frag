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
// The look (PROFILE.LOOK, after public/textures/aurora-reference.jpg): the
// aurora is sampled through a fan warp (rays converge upward, as seen from
// below) with a slow sway, blurred along the rays into long-exposure streaks;
// the sky gets a teal wash of the aurora's light and a low mist; dark cloud
// banks on both sides (fbm) catch a warm peach rim from a low light below the
// horizon; three mountain layers fade into the haze; the glassy water carries
// fine ripples and rings around a Viking longship (a 2D silhouette: hull,
// dragon prows, mast, sail, rigging, shields, warm lanterns), whose
// reflection and lantern streaks are drawn into the water. A filmic grade
// (lifted teal blacks, desaturation that spares the warm accents, vignette)
// ends the pass; ACES and the dither follow in the composite.
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
uniform float uClock;        // real seconds (steady drift, independent of the music clock)
uniform vec4 uFan;           // x = fan, y = fan centre x, z = sway (screen widths at the top), w = streak blur px
uniform vec4 uSkyLook;       // x = aurora wash, y = haze, z = haze height, w = shore glow
uniform vec3 uHazeCol;
uniform vec4 uStarLook;      // x = density, y = size, z = dimming behind the aurora
uniform vec4 uCloud;         // x = on, y = scale, z = cover, w = softness
uniform vec4 uCloud2;        // xy = inner edges (left, right), zw = band (bottom, top)
uniform vec4 uCloud3;        // x = aurora tint, y = rim strength (incl. bass, dawn), z = rim width
uniform vec4 uCloudLight;    // xy = low light position, zw = drift offsets of the left / right banks
uniform vec3 uCloudBody;
uniform vec3 uCloudRim0;
uniform vec3 uCloudRim1;
uniform vec3 uRock;
uniform vec3 uSnow;
uniform vec4 uMount;         // xyz = haze over the far / middle / near layers, w = sky light on the snow
uniform vec4 uWaterLook;     // x = ripple amplitude, y = fineness, z = ring amplitude, w = rocks on
uniform vec3 uWaterDark;
uniform vec4 uShip;          // x = screen x, y = waterline, z = half-length (screen widths), w = on
uniform vec4 uShip2;         // x = bob, y = roll, z = sail billow, w = lantern strength
uniform vec4 uShip3;         // x = sail light, y = flicker
uniform vec3 uHull;
uniform vec3 uSail;
uniform vec3 uShipLight;
uniform vec4 uGrade;         // x = saturation, y = warm saturation, z = vignette
uniform vec3 uLift;
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
    // (sparse: uStarLook.x is the share of the old field)
    float thresh = 1.0 - (layer == 0 ? 0.022 : 0.012) * uStarLook.x;
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
      col += tint * b * tw * vis * exp(-d * d / ((0.55 + b) * uStarLook.y * uStarLook.y));
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
      // the rays fan in toward the top (seen from below) and sway slowly; outside the
      // aurora layer's width the top corners stay dark
      float up = max(uv.y - HORIZON, 0.0);
      float k = max(1.0 - uFan.x * up, 0.2);
      float x0 = uFan.y + (uv.x - uFan.y) / k + uFan.z * up / (1.0 - HORIZON);
      float edge = smoothstep(-0.05, 0.3, x0) * smoothstep(1.05, 0.7, x0);
      uv = vec2(x0, uv.y);
      // long-exposure streaks: the blur runs along the rays (y), with the soft blur across
      o = vec2(uAuroraBlur.x, uFan.w) / uResolution;
      // 3x3 tent: a stable kernel, no shimmer
      vec3 c = 0.25 * texture2D(tAurora, uv).rgb;
      c += 0.125 * (texture2D(tAurora, uv + vec2(o.x, 0.0)).rgb + texture2D(tAurora, uv - vec2(o.x, 0.0)).rgb
                  + texture2D(tAurora, uv + vec2(0.0, o.y)).rgb + texture2D(tAurora, uv - vec2(0.0, o.y)).rgb);
      c += 0.0625 * (texture2D(tAurora, uv + o).rgb + texture2D(tAurora, uv - o).rgb
                   + texture2D(tAurora, uv + vec2(o.x, -o.y)).rgb + texture2D(tAurora, uv + vec2(-o.x, o.y)).rgb);
      return c * edge;
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

// ------------------------------------------------------------- clouds

// Cloud density at sky point p (screen heights: x from the centre, y above the horizon):
// two banks, left and right of the aurora, drifting at their own speeds.
float cloudDensity(vec2 p) {
  float side = max(smoothstep(uCloud2.x, uCloud2.x - 0.4, p.x), smoothstep(uCloud2.y, uCloud2.y + 0.4, p.x));
  float band = smoothstep(uCloud2.z - 0.02, uCloud2.z + 0.08, p.y) * (1.0 - smoothstep(uCloud2.w - 0.18, uCloud2.w, p.y));
  vec2 q = p * uCloud.y + vec2(p.x < 0.0 ? uCloudLight.z : uCloudLight.w, 0.0);
  // billowing: rounder low frequencies, a little stretched sideways
  float n = 0.5 + 0.5 * fbm(q * vec2(0.8, 1.15), 4);
  return n * (0.35 + 0.65 * side) * band + 0.25 * side * band;
}

// Cloud cover (x) and warm rim (y) at p: the rim is where the cloud thins out toward the low light.
vec2 clouds(vec2 p) {
  if (uCloud.x <= 0.0) return vec2(0.0);
  float d = cloudDensity(p);
  float cover = smoothstep(uCloud.z, uCloud.z + uCloud.w, d);
  if (cover <= 0.0) return vec2(0.0);
  vec2 L = uCloudLight.xy - p;
  float dist = length(L);
  float toward = cloudDensity(p + L / dist * uCloud3.z);
  // (only the thin edge: inside the bank the rim fades)
  float rim = cover * (1.0 - smoothstep(uCloud.z - 0.04, uCloud.z + uCloud.w * 0.6, toward)) * (1.0 - smoothstep(0.3, 1.0, cover) * 0.6);
  rim *= exp(-dist * 1.6) * 2.2; // strongest near the light, low over the horizon
  return vec2(cover, rim);
}

// ------------------------------------------------------------- the longship

float segD(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// Ship coordinates of screen point uv: x along the hull (-1..1 = its length), y up from the waterline.
vec2 shipLocal(vec2 uv) {
  float S = uShip.z * uAspect;
  vec2 q = vec2((uv.x - uShip.x) * uAspect, uv.y - uShip.y - uShip2.x) / S;
  float c = cos(uShip2.y);
  float s = sin(uShip2.y);
  return vec2(c * q.x + s * q.y, -s * q.x + c * q.y);
}

// The ship at ship point q: rgb + coverage. px = one pixel in ship units.
vec4 shipColor(vec2 q, float px, vec3 amb) {
  if (q.x < -1.15 || q.x > 1.15 || q.y < -0.05 || q.y > 1.4) return vec4(0.0);
  float ax = abs(q.x);
  // hull: low in the middle, sweeping up toward both ends
  float top = 0.1 + 0.14 * pow(min(ax / 0.9, 1.2), 4.0);
  float bot = -0.03 + 0.14 * pow(min(ax / 0.9, 1.2), 3.0);
  float dHull = max(max(q.y - top, bot - q.y), ax - 0.93);
  // dragon prows: a stem curving up and out, a head and a snout, at both ends
  float sy = clamp((q.y - 0.1) / 0.3, 0.0, 1.0);
  float stem = abs(ax - (0.87 + 0.11 * sqrt(sy))) - (0.03 - 0.012 * sy);
  stem = max(stem, max(0.1 - q.y, q.y - 0.42));
  float head = length(vec2(ax - 0.975, q.y - 0.43)) - 0.034;
  float snout = segD(vec2(ax, q.y), vec2(0.98, 0.44), vec2(1.045, 0.415)) - 0.012;
  float curl = abs(length(vec2(ax - 0.955, q.y - 0.385)) - 0.03) - 0.007;
  float dProw = min(min(stem, head), min(snout, curl));
  // mast and yard
  float dMast = max(abs(q.x - 0.03) - 0.013, max(0.05 - q.y, q.y - 1.3));
  float dYard = segD(q, vec2(-0.36, 1.07), vec2(0.45, 1.11)) - 0.008;
  float solid = smoothstep(px, -px, min(min(dHull, dProw), min(dMast, dYard)));
  // rigging: hairlines from the mast top and the yard ends to the hull
  vec2 mt = vec2(0.03, 1.3);
  float dRig = min(min(segD(q, mt, vec2(-0.86, 0.13)), segD(q, mt, vec2(-0.52, 0.09))),
                   min(segD(q, mt, vec2(0.58, 0.09)), segD(q, mt, vec2(0.87, 0.14))));
  dRig = min(dRig, min(segD(q, vec2(-0.36, 1.07), vec2(-0.66, 0.1)), segD(q, vec2(0.45, 1.11), vec2(0.72, 0.1))));
  float rig = 0.55 * smoothstep(1.4 * px, 0.3 * px, dRig);
  // the square sail, hanging from the yard, its leeward edge curved by the wind
  float v = (q.y - 0.36) / 0.7;
  float xl = -0.34 - 0.03 * sin(3.1416 * v);
  float xr = 0.43 + uShip2.z * sin(3.1416 * clamp(v, 0.0, 1.0));
  float dSail = max(max(xl - q.x, q.x - xr), max(-v, v - 1.0) * 0.7);
  float sail = smoothstep(px, -px, dSail);
  float u = clamp((q.x - xl) / (xr - xl), 0.0, 1.0);
  float shade = 0.55 + 0.45 * sin(3.1416 * u) * (0.8 + 0.2 * v); // the belly catches the most light
  // a row of round shields along the gunwale, their rims catching the sky
  float si = clamp(floor(q.x / 0.082 + 0.5), -9.0, 9.0);
  float dShield = length(q - vec2(si * 0.082, 0.05)) - 0.031;
  float shieldRim = smoothstep(0.012, 0.0, abs(dShield + 0.006)) * step(dShield, 0.0);

  vec3 hull = uHull + amb * 0.03 + amb * 0.12 * smoothstep(top - 0.03, top, q.y) * step(dHull, 0.0); // a faint rim of sky light
  hull += (uHull * 3.0 + amb * 0.1) * shieldRim;
  vec3 sailCol = uSail * 0.05 * shade + amb * uShip3.x * shade;
  vec3 col = mix(sailCol, hull, max(solid, rig));
  float a = max(max(solid, rig), sail * 0.96);
  return vec4(col, a);
}

// Warm lantern / shield light at ship point q (HDR, added on top).
vec3 shipLights(vec2 q, vec2 stretch) {
  vec3 l = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 c = vec2((-7.0 + 2.4 * fi) * 0.082, 0.065 + 0.01 * hash11(fi * 3.7));
    vec2 d = (q - c) / stretch;
    float flick = 1.0 + uShip3.y * sin(uClock * (0.6 + 0.17 * fi) + fi * 1.9);
    float w = 0.55 + 0.45 * hash11(fi * 9.1);
    l += w * flick * (exp(-dot(d, d) / 0.00014) + 0.18 * exp(-dot(d, d) / 0.0016));
  }
  return uShipLight * uShip2.w * l;
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
  // the stars dim behind the aurora
  col /= 1.0 + uStarLook.z * dot(aurora, vec3(0.2126, 0.7152, 0.0722));
  col += aurora;
  // the aurora washes the sky teal-green around it (most in the middle of the sky)
  col += amb * uSkyLook.x * (0.35 + 0.65 * exp(-pow((h - 0.35) / 0.4, 2.0)));
  // low mist over the horizon
  vec3 haze = uHazeCol * (0.55 + 0.45 * (1.0 - uNight)) + amb * 0.2 + glow * 0.5;
  col = mix(col, haze, uSkyLook.y * exp(-ry / uSkyLook.z));

  // cloud banks: dark bodies lit green by the aurora, warm rims toward the low light
  vec2 cp = vec2((uv.x - 0.5) * uAspect, y);
  vec2 cl = clouds(cp);
  vec3 body = uCloudBody * (0.6 + 0.4 * (1.0 - uNight)) + amb * uCloud3.x + aurora * 0.06;
  col = mix(col, body, cl.x * 0.93);
  col += mix(uCloudRim0, uCloudRim1, smoothstep(0.2, 1.0, cl.y)) * cl.y * uCloud3.y;

  // mountains: three layers, farther = lighter, bluer and hazier; the snow takes the sky's light
  if (terrain.b > 0.16) {
    float layer = terrain.b > 0.83 ? 2.0 : terrain.b > 0.5 ? 1.0 : 0.0;
    float near = layer / 2.0;
    vec3 skyLight = amb * 0.6 + uHazeCol * 0.4 + horizonGlow(0.02, uv.x) * uSnowGlow;
    vec3 rock = uRock * mix(0.1, 0.05, near) + amb * 0.04;
    vec3 snowCol = uSnow * mix(0.16, 0.2, near) + skyLight * uMount.w;
    vec3 m = mix(rock, snowCol, terrain.g);
    float hz = layer > 1.5 ? uMount.z : layer > 0.5 ? uMount.y : uMount.x;
    col = mix(m, haze, hz);
  }
  // a faint glow where the far shore meets the water
  col += amb * uSkyLook.w * exp(-y * 90.0) * step(0.0, y);
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

    // glassy: fine, low, mostly horizontal ripples (long across, short in depth)
    float tt = uTime * 0.4;
    vec2 wp = vec2(w.x * 0.3, w.y * 1.4 * uWaterLook.y);
    float n0 = snoise(vec3(wp, tt));
    float n1 = snoise(vec3(wp * vec2(2.3, 2.9) + 7.0, tt * 1.6));
    vec2 slope = vec2(0.25 * n1, n0 + 0.5 * n1) * uWaterLook.x;
    // rings spreading from the ship (and a little more on strong notes)
    vec3 rs = viewRay(vec2(uShip.x, uShip.y));
    vec2 ws = rs.xz * (-1.0 / rs.y);
    vec2 dw = (w - ws) * vec2(1.0, 2.2);
    float dr = length(dw);
    slope.y += uWaterLook.z * uShip.w * sin(dr * 9.0 - uClock * 1.6) * exp(-dr * 0.35) * smoothstep(0.0, 0.6, dr);

    // mirrored sample, displaced by the ripples (more near the viewer)
    vec2 ruv = vec2(uv.x, 2.0 * HORIZON - uv.y);
    ruv += slope * vec2(0.003, 0.01) * (0.3 + depth * 1.5);
    ruv.y = max(ruv.y, HORIZON + 0.0005);
    vec3 refl = above(ruv, amb, 0.35);

    // fresnel-ish: grazing angles reflect more
    float fres = mix(0.8, 0.3, pow(depth, 0.7));
    vec3 water = mix(uWater, uWaterDark, uNight);
    col = water + refl * fres;

    // the ship's reflection: mirrored about its waterline, broken by the ripples, darker;
    // its lanterns stretch into vertical warm streaks
    if (uShip.w > 0.0 && uv.y < uShip.y) {
      float S = uShip.z * uAspect;
      vec2 su = vec2(uv.x + slope.x * 0.004 + slope.y * 0.0025, 2.0 * uShip.y - uv.y);
      vec2 q = shipLocal(su);
      vec4 sh = shipColor(q, 2.0 / (uResolution.y * S), amb);
      col = mix(col, sh.rgb * 0.6 + water, sh.a * 0.85 * uShip.w);
      vec2 qs = shipLocal(vec2(uv.x + slope.y * 0.004, uShip.y + (uShip.y - uv.y) * 0.22));
      float broken = 0.55 + 0.45 * smoothstep(-0.3, 0.5, n1);
      col += shipLights(qs, vec2(0.9, 1.0)) * 0.55 * broken * uShip.w;
    }
    // thin bright ripple glints catch the aurora
    col += amb * 0.25 * smoothstep(0.55, 1.0, n0) * (1.0 - depth);

    // --- foreground shoreline rocks with a green aurora rim light (off in the restyle)
    float x = (uv.x - 0.5) * uAspect;
    float top = uWaterLook.w > 0.5 ? boulders(x) : -1.0;
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

  // the longship, in front of the water and the mountains
  if (uShip.w > 0.0 && uv.y >= uShip.y - 0.004) {
    float S = uShip.z * uAspect;
    vec2 q = shipLocal(uv);
    vec4 sh = shipColor(q, 1.2 / (uResolution.y * S), amb);
    col = mix(col, sh.rgb, sh.a * uShip.w * smoothstep(uShip.y - 0.0015, uShip.y + 0.0005, uv.y)); // cut at the waterline
    col += shipLights(q, vec2(1.0)) * uShip.w;
  }

  // filmic grade (HDR, before the bloom and ACES): lifted teal blacks, desaturation that
  // spares the warm accents (cloud rims, lanterns), a gentle vignette
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float warm = smoothstep(0.08, 0.35, (col.r - col.b) / max(max(col.r, col.g), 1e-4));
  col = max(mix(vec3(luma), col, mix(uGrade.x, uGrade.y, warm)), 0.0);
  col += uLift;
  vec2 vd = (uv - 0.5) * vec2(1.0, 0.85);
  col *= 1.0 - uGrade.z * smoothstep(0.25, 0.85, length(vd) * 1.2);
  gl_FragColor = vec4(col, 1.0);
}
