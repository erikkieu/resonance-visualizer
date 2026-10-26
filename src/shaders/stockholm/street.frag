// ---------------------------------------------------------------------------
// Scene 4: a 1930s Stockholm square as silent-film footage.
//
// Geometry is ray-cast against a few planes: the ground, two building
// facades receding on the left and right, and a row of facades across the
// far side of the square with a clock tower. Moving things (trams, cars,
// pedestrians) plus lamps and bare trees are 2D silhouettes standing on
// vertical planes at fixed depths, so they get true perspective and
// parallax for free. A per-pixel depth test sorts everything.
//
// Rays use dir.z == 1, so the ray parameter equals the depth z.
// All sizes are in metres. Output is luminance, film-treated, sepia-tinted.
// ---------------------------------------------------------------------------

uniform float uAspect;
uniform vec2 uResolution;
uniform float uTime;       // object clock, stepped at film frame rate
uniform float uFrame;      // film frame index (real time, ~18 fps)
uniform float uBass;
uniform float uTreble;
uniform float uFlash;      // beat exposure flash
uniform float uShake;      // bass camera shake
uniform vec2 uClock;       // hour / minute hand angles
uniform sampler2D tPlate;
uniform float uUsePlate;
uniform float uPlateAspect;
varying vec2 vUv;

const float HORIZON = 0.44;
const float FOCAL = 1.15;
const vec3 CAM = vec3(0.0, 3.4, 0.0);

const float WALL_X = 13.0;
const float LEFT_END = 34.0;
const float RIGHT_END = 30.0;
const float FAR_Z = 74.0;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float sdRoundBox(vec2 p, vec2 b, float r) { return sdBox(p, b - r) - r; }
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdSegment(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// world size of one pixel at depth z
float pxAt(float z) { return z / (FOCAL * uResolution.y); }

// anti-aliased coverage of a signed distance
float cover(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

// ------------------------------------------------------------------ facades

// Neoclassical facade pattern. u runs along the wall, v is height. Returns luminance.
float facade(float u, float v, float height, float base, float aa, float seed) {
  float lum = base + 0.04 * vnoise(vec2(u * 0.7, v * 0.5) + seed); // weathered stone
  // rusticated ground floor: horizontal grooves and big shop windows
  if (v < 4.6) {
    lum -= 0.06 * (1.0 - smoothstep(0.0, 0.06 + aa, abs(fract(v / 0.55) - 0.5) * 0.55));
    float bay = fract(u / 4.2);
    float shop = step(abs(bay - 0.5), 0.3) * step(0.3, v) * step(v, 3.6);
    lum = mix(lum, 0.12 + 0.08 * (v / 3.6), shop * (1.0 - step(abs(bay - 0.5), 0.015)));
  } else if (v < height - 1.6) {
    // window bays
    float floorH = 3.5;
    float fv = (v - 4.6) / floorH;
    float fl = fract(fv);
    float bay = fract(u / 3.0);
    float win = cover(max(abs(bay - 0.5) * 3.0 - 0.62, abs(fl - 0.5) * floorH - 1.0), aa * 1.5);
    float pane = 0.16 + 0.12 * hash12(vec2(floor(u / 3.0), floor(fv)) + seed);
    float frame = cover(abs(abs(bay - 0.5) * 3.0 - 0.62) - 0.06, aa) * step(abs(fl - 0.5) * floorH, 1.05);
    lum = mix(lum, pane, win);
    lum = mix(lum, base + 0.12, frame * 0.6);
    // pediment shadow above each window, sill highlight below
    float head = cover(abs((fl - 0.5) * floorH - 1.2) - 0.09, aa) * step(abs(bay - 0.5) * 3.0, 0.8);
    lum = mix(lum, base - 0.12, head * 0.7);
    float sill = cover(abs((fl - 0.5) * floorH + 1.1) - 0.05, aa) * step(abs(bay - 0.5) * 3.0, 0.75);
    lum = mix(lum, base + 0.14, sill * 0.7);
    // string course between floors
    lum -= 0.07 * cover(abs(fl * floorH) - 0.12, aa);
    // pilasters every other bay
    float pil = cover(abs(fract(u / 6.0 + 0.25) - 0.5) * 6.0 - 0.35, aa);
    lum = mix(lum, base + 0.05, pil * 0.5 * (1.0 - win));
  } else {
    // cornice: bright lip with a deep shadow underneath
    float c = v - (height - 1.6);
    lum = c < 0.45 ? base - 0.18 : base + 0.1 - 0.05 * step(1.1, c);
    lum -= 0.05 * step(0.5, fract(u / 0.6)) * step(c, 0.45);
  }
  return lum;
}

// Far row of buildings across the square. Returns skyline height at x.
float skyline(float x) {
  float ax = abs(x);
  if (ax < 4.2) return 41.0;            // clock tower (top of cupola + spire handled below)
  if (ax < 14.0) return 22.0;           // central building
  float seg = floor((x + 100.0) / 15.0);
  return 14.5 + 5.0 * hash11(seg * 3.7) + (fract((x + 100.0) / 15.0) < 0.06 ? 1.0 : 0.0);
}

float farFacade(float x, float y, float aa) {
  float ax = abs(x);
  float lum;
  if (ax < 4.2 && y > 21.0) {
    // tower with a clock and an open belfry
    lum = 0.58;
    vec2 cp = vec2(x, y - 30.5);
    float r = length(cp);
    if (r < 2.4) {
      lum = r < 2.15 ? 0.82 : 0.28; // dial and bezel
      // hour marks
      float a = atan(cp.x, cp.y);
      float tick = cover(abs(fract(a / (TAU / 12.0) + 0.5) - 0.5) * 12.0 - 0.18, 0.06) * step(1.7, r) * step(r, 2.05);
      lum = mix(lum, 0.15, tick);
      // hands (real local time)
      vec2 hd = vec2(sin(uClock.x), cos(uClock.x));
      vec2 md = vec2(sin(uClock.y), cos(uClock.y));
      float hands = min(sdSegment(cp, vec2(0.0), hd * 1.15, 0.09), sdSegment(cp, vec2(0.0), md * 1.75, 0.06));
      lum = mix(lum, 0.1, cover(hands, aa));
    }
    // belfry arches above the clock
    if (y > 33.5 && y < 37.0) lum = mix(lum, 0.15, cover(sdRoundBox(vec2(fract(x / 2.6 + 0.5) - 0.5, y - 35.2) * vec2(2.6, 1.0), vec2(0.7, 1.4), 0.6), aa));
    // cupola tapering into a spire
    if (y > 37.5) {
      float w = mix(4.2, 0.4, smoothstep(37.5, 41.0, y));
      lum = ax < w ? 0.42 - 0.12 * smoothstep(0.0, 4.0, ax) : -1.0;
    }
    lum -= 0.1 * cover(abs(y - 21.5) - 0.3, aa);
  } else if (ax < 14.0) {
    // central building with a columned portico and pediment
    lum = facade(x + 30.0, y, 22.0, 0.6, aa, 5.0);
    if (y > 2.0 && y < 13.0 && ax < 10.0) {
      float col = cover(abs(fract(x / 2.4) - 0.5) * 2.4 - 0.45, aa);
      lum = mix(0.24, 0.72 - 0.1 * smoothstep(2.0, 13.0, y), col);
    }
    float ped = 13.0 + 3.8 * (1.0 - ax / 11.0);
    if (y > 13.0 && y < ped && ax < 11.0) lum = y > ped - 0.5 ? 0.8 : 0.66 - 0.2 * step(y, 13.6);
  } else {
    float seg = floor((x + 100.0) / 15.0);
    lum = facade(x, y, skyline(x), 0.48 + 0.18 * hash11(seg * 1.3), aa, seg);
  }
  return lum;
}

// ---------------------------------------------------------------- moving things

// Tram facing +x. Returns (signed distance, luminance).
vec2 tram(vec2 p, float wheelPhase) {
  float body = sdRoundBox(p - vec2(0.0, 2.0), vec2(5.5, 1.45), 0.4);
  float roof = sdRoundBox(p - vec2(0.0, 3.55), vec2(5.2, 0.16), 0.1);
  float clere = sdBox(p - vec2(0.0, 3.8), vec2(3.4, 0.12));
  float under = sdBox(p - vec2(0.0, 0.5), vec2(4.6, 0.22));
  vec2 wq = vec2(abs(abs(p.x) - 3.6) - 0.75, p.y - 0.38);
  float wheels = sdCircle(wq, 0.38);
  float pole = sdSegment(p, vec2(-1.0, 3.9), vec2(-3.4, 6.2), 0.05);
  float d = min(min(min(body, roof), min(clere, under)), min(wheels, pole));

  float lum = p.y < 1.75 ? 0.2 : 0.66; // dark lower panels, cream upper
  lum = mix(lum, 0.12, cover(abs(p.y - 1.75) - 0.06, 0.02));
  // windows with a reflection gradient and passenger silhouettes
  float wx = fract((p.x + 5.05) / 1.12);
  if (p.y > 1.98 && p.y < 3.05 && abs(p.x) < 4.75 && abs(wx - 0.5) < 0.38) {
    lum = 0.3 + 0.22 * (p.y - 1.98);
    float seat = floor((p.x + 5.05) / 1.12);
    if (hash11(seat * 3.1) > 0.35) lum = mix(lum, 0.1, cover(sdCircle(p - vec2(seat * 1.12 - 4.49 + 0.1 * hash11(seat), 2.45), 0.15), 0.02));
  }
  lum = mix(lum, 0.9, cover(sdCircle(p - vec2(5.35, 1.25), 0.13), 0.02)); // headlamp
  lum = mix(lum, 0.82, cover(sdBox(p - vec2(4.9, 3.25), vec2(0.45, 0.12)), 0.02)); // route board
  if (roof < 0.0 || clere < 0.0) lum = 0.26;
  if (under < 0.0) lum = 0.08;
  if (wheels < 0.0) {
    float a = atan(wq.y, wq.x) + wheelPhase;
    lum = 0.07 + 0.2 * step(0.75, fract(a / TAU * 6.0)) * step(0.12, length(wq));
  }
  if (pole < 0.0) lum = 0.1;
  // body shading: lighter top, darker bottom
  lum *= 0.85 + 0.2 * smoothstep(0.5, 3.4, p.y);
  return vec2(d, lum);
}

// Boxy 1930s sedan facing +x.
vec2 car(vec2 p, float wheelPhase, float tone) {
  float chassis = sdRoundBox(p - vec2(0.0, 0.88), vec2(2.15, 0.33), 0.16);
  vec2 cp = p - vec2(-0.5, 1.48);
  cp.x += (p.y - 1.48) * 0.28;
  float cabin = sdRoundBox(cp, vec2(1.1, 0.36), 0.22);
  vec2 wq = vec2(abs(p.x) - 1.38, p.y - 0.38);
  float fender = max(sdCircle(wq - vec2(0.0, 0.12), 0.56), -(p.y - 0.42));
  float wheel = sdCircle(wq, 0.37);
  float board = sdBox(p - vec2(0.0, 0.47), vec2(0.9, 0.05));
  float lamp = sdCircle(p - vec2(2.05, 1.22), 0.13);
  float d = min(min(min(chassis, cabin), min(fender, wheel)), min(board, lamp));

  float lum = tone + 0.32 * smoothstep(0.08, 0.0, abs(p.y - 1.12)) + 0.2 * smoothstep(0.1, 0.0, abs(cabin + 0.05));
  if (cabin < -0.08 && p.y > 1.28) lum = abs(cp.x + 0.15) < 0.05 ? tone : 0.42 + 0.15 * (p.y - 1.3); // windows
  if (p.x > 1.95 && p.y > 0.6 && p.y < 1.12 && chassis < 0.0) lum = 0.35 + 0.3 * step(0.5, fract(p.y * 18.0)); // grille
  if (fender < 0.0 && chassis > 0.0) lum = tone + 0.15 * smoothstep(0.3, 0.6, p.y);
  if (wheel < 0.0) {
    float a = atan(wq.y, wq.x) + wheelPhase;
    lum = length(wq) < 0.13 ? 0.6 : 0.06 + 0.25 * step(0.8, fract(a / TAU * 8.0)) * step(length(wq), 0.27);
  }
  if (lamp < 0.0) lum = 0.85;
  return vec2(d, lum);
}

// Walking pedestrian facing +x. phase drives the walk cycle; kind picks
// coat/hat/dress variations.
vec2 pedestrian(vec2 p, float phase, float kind, float tone) {
  float woman = step(0.6, kind);
  float bob = 0.03 * abs(cos(phase));
  p.y -= bob;
  float head = sdCircle(p - vec2(0.02, 1.6), 0.105);
  float hat = woman > 0.5
    ? sdCircle((p - vec2(0.0, 1.67)) * vec2(1.0, 1.25), 0.125)
    : min(sdBox(p - vec2(0.0, 1.695), vec2(0.17, 0.016)), sdRoundBox(p - vec2(0.0, 1.77), vec2(0.1, 0.075), 0.03));
  // coat / dress: a trapezoid from shoulders to hem
  float hem = woman > 0.5 ? 0.5 : 0.62 + 0.1 * fract(kind * 7.0);
  float t = clamp((1.46 - p.y) / (1.46 - hem), 0.0, 1.0);
  float halfW = mix(0.19, woman > 0.5 ? 0.3 : 0.24, t);
  float coat = max(abs(p.x - 0.01) - halfW, max(p.y - 1.46, hem - p.y));
  coat = min(coat, sdCircle(p - vec2(0.0, 1.4), 0.13)); // rounded shoulders
  // legs swing in opposite phase, the forward leg lifts a little
  float sw = sin(phase) * 0.42;
  vec2 hip = vec2(0.0, 0.88);
  vec2 footA = hip + vec2(sin(sw), -cos(sw)) * 0.84 + vec2(0.0, 0.07 * max(0.0, cos(phase)));
  vec2 footB = hip + vec2(sin(-sw), -cos(-sw)) * 0.84 + vec2(0.0, 0.07 * max(0.0, -cos(phase)));
  float legs = min(sdSegment(p, hip, footA, 0.06), sdSegment(p, hip, footB, 0.06));
  legs = min(legs, min(sdBox(p - footA - vec2(0.06, 0.0), vec2(0.1, 0.035)), sdBox(p - footB - vec2(0.06, 0.0), vec2(0.1, 0.035))));
  // arms swing against the legs
  vec2 hand = vec2(-sin(phase) * 0.26, 0.92);
  float arm = sdSegment(p, vec2(0.0, 1.38), hand, 0.05);
  float extra = 1e3;
  if (kind < 0.25) extra = sdSegment(p, hand, hand + vec2(0.12, -0.9), 0.02);          // walking cane
  else if (kind > 0.85) extra = max(sdCircle((p - vec2(0.0, 2.05)) * vec2(0.8, 1.6), 0.55), -(p.y - 2.0)); // umbrella
  if (kind > 0.85) extra = min(extra, sdSegment(p, hand, vec2(0.0, 2.05), 0.015));
  float d = min(min(min(head, hat), min(coat, legs)), min(arm, extra));

  float lum = tone;
  if (head < 0.0 && hat > 0.0) lum = 0.5;
  if (hat < 0.0) lum = tone * 0.6;
  if (legs < 0.0 && coat > 0.0) lum = 0.08;
  return vec2(d, lum);
}

vec2 lamp(vec2 p) {
  float base = sdRoundBox(p - vec2(0.0, 0.35), vec2(0.17, 0.35), 0.05);
  float pole = sdSegment(p, vec2(0.0, 0.6), vec2(0.0, 4.3), 0.055);
  float lw = 0.2 + 0.06 * (p.y - 4.3);
  float lantern = max(abs(p.x) - lw, abs(p.y - 4.65) - 0.33);
  float cap = sdSegment(p, vec2(-0.3, 5.02), vec2(0.0, 5.3), 0.04);
  cap = min(cap, sdSegment(p, vec2(0.3, 5.02), vec2(0.0, 5.3), 0.04));
  cap = min(cap, sdSegment(p, vec2(0.0, 5.3), vec2(0.0, 5.55), 0.03));
  float d = min(min(base, pole), min(lantern, cap));
  float lum = lantern < -0.04 ? 0.5 : 0.12;
  return vec2(d, lum);
}

// Bare winter tree: trunk, a few limbs and a ridged-noise twig network.
vec2 tree(vec2 p, float seed, float aa) {
  float trunk = sdSegment(p, vec2(0.0, 0.0), vec2(0.15 * (seed - 0.5), 4.2), 0.28 - 0.04 * p.y);
  float limbs = 1e3;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float a = (fi - 2.0) * 0.48 + (hash11(seed * 13.0 + fi) - 0.5) * 0.3;
    vec2 tip = vec2(0.0, 4.0) + vec2(sin(a), cos(a)) * (4.5 + 2.0 * hash11(seed * 7.0 + fi));
    limbs = min(limbs, sdSegment(p, vec2(0.0, 3.6), tip, 0.13));
  }
  float d = min(trunk, limbs);
  vec2 cq = (p - vec2(0.0, 7.6)) / vec2(5.0, 4.3);
  float crown = dot(cq, cq);
  if (crown < 1.0) {
    vec2 q = p + seed * 17.0;
    float twig = min(abs(snoise(q * 0.9)) - 0.035, abs(snoise(q * 2.2 + 5.0)) - 0.05);
    twig = max(twig, -0.1) + smoothstep(0.4, 1.0, crown) * 0.05;
    d = min(d, twig * 1.2 - aa * 0.4);
  }
  return vec2(d, 0.26);
}

// ------------------------------------------------------------------- the frame

vec3 ray(vec2 uv) {
  return vec3((uv.x - 0.5) * uAspect / FOCAL, (uv.y - HORIZON) / FOCAL, 1.0);
}

// --- placement of moving things: lane depth, direction, distance travelled, x
void pedPlace(int i, float t, out float zo, out float dir, out float dist, out float xo) {
  float fi = float(i);
  float h = hash11(fi * 7.77 + 1.0);
  zo = i < 9 ? 11.0 + fi * 2.4 : 35.0 + (fi - 9.0) * 4.6;
  dir = mod(fi, 2.0) < 1.0 ? 1.0 : -1.0;
  float L = zo * 0.82 + 4.0;
  dist = t * (1.15 + 0.45 * h) + h * 97.0;
  xo = (mod(dist, 2.0 * L) - L) * dir;
}

void carPlace(int i, float t, out float zo, out float dir, out float dist, out float xo) {
  float fi = float(i);
  zo = i == 1 ? 57.0 : 38.0;
  dir = i == 1 ? -1.0 : 1.0;
  float L = zo * 0.82 + 8.0;
  dist = t * (6.0 + 1.5 * fi) + fi * 41.0;
  xo = (mod(dist, 2.0 * L) - L) * dir;
}

void tramPlace(int i, float t, out float zo, out float dir, out float dist, out float xo) {
  float fi = float(i);
  zo = i == 0 ? 44.0 : 50.0;
  dir = i == 0 ? 1.0 : -1.0;
  float L = zo * 0.82 + 14.0;
  dist = t * 4.2 + fi * 53.0;
  xo = (mod(dist, 2.0 * L) - L) * dir;
}

// Soft contact shadows of everything that moves, on the ground point g.
float groundShadow(vec2 g, float t) {
  float sh = 0.0;
  float zo, dir, dist, xo;
  for (int i = 0; i < 2; i++) {
    tramPlace(i, t, zo, dir, dist, xo);
    sh += exp(-pow((g.y - zo) / 1.1, 2.0)) * smoothstep(6.3, 4.8, abs(g.x - xo)) * 0.45;
  }
  for (int i = 0; i < 3; i++) {
    carPlace(i, t, zo, dir, dist, xo);
    sh += exp(-pow((g.y - zo) / 0.8, 2.0)) * smoothstep(2.6, 1.8, abs(g.x - xo)) * 0.4;
  }
  for (int i = 0; i < 16; i++) {
    pedPlace(i, t, zo, dir, dist, xo);
    vec2 d = (g - vec2(xo, zo)) / vec2(0.45, 0.3);
    sh += exp(-dot(d, d)) * 0.35;
  }
  return clamp(sh, 0.0, 0.6);
}

float scene(vec2 uv) {
  vec3 rd = ray(uv);
  float depth = 1e5;
  float lum;
  float aa;

  // ---- background: sky, ground, walls, far row (or a photo plate)
  if (uUsePlate > 0.5) {
    vec2 puv = uv - 0.5;
    puv.x *= uAspect / uPlateAspect;
    if (uAspect < uPlateAspect) puv *= 1.0;
    else puv *= uPlateAspect / uAspect;
    vec3 c = texture2D(tPlate, puv + 0.5).rgb;
    lum = dot(c, vec3(0.299, 0.587, 0.114));
  } else {
    // overcast sky
    lum = 0.78 - 0.18 * (uv.y - HORIZON) + 0.04 * fbm(uv * vec2(3.0, 6.0) + uTime * 0.01, 3);
    depth = 1e5;

    // far row
    float xf = CAM.x + rd.x * FAR_Z;
    float yf = CAM.y + rd.y * FAR_Z;
    aa = pxAt(FAR_Z);
    float sky = skyline(xf);
    if (yf > 0.0 && yf < sky) {
      float f = farFacade(xf, yf, aa);
      if (f >= 0.0) {
        lum = mix(f, 0.72, 0.38); // atmospheric haze at this distance
        depth = FAR_Z;
      }
    }

    // ground
    if (rd.y < 0.0) {
      float z = -CAM.y / rd.y;
      if (z < depth) {
        depth = z;
        vec2 g = vec2(CAM.x + rd.x * z, z);
        aa = pxAt(z);
        // cobbled setts with darker joints, fading to a mean grey with distance
        float row = floor(g.y / 0.2);
        vec2 sc = vec2(fract((g.x + row * 0.13) / 0.26), fract(g.y / 0.2));
        float joint = min(min(sc.x, 1.0 - sc.x) * 0.26, min(sc.y, 1.0 - sc.y) * 0.2);
        float stone = 0.42 + 0.1 * hash12(vec2(floor((g.x + row * 0.13) / 0.26), row));
        float setts = mix(0.26, stone, smoothstep(0.0, 0.025 + aa, joint));
        lum = mix(setts, 0.4, smoothstep(0.012, 0.05, aa));
        // sidewalks along the buildings, with a bright curb
        if (abs(g.x) > 9.5 && g.y < LEFT_END) {
          float slab = min(fract(g.x), fract(g.y)) ;
          lum = mix(0.36, 0.5, smoothstep(0.0, 0.03 + aa, slab));
          lum = mix(lum, 0.62, cover(abs(abs(g.x) - 9.55) - 0.08, aa));
        }
        // tram rails: polished steel catching the sky
        for (int k = 0; k < 2; k++) {
          float lane = k == 0 ? 44.0 : 50.0;
          float rd2 = abs(abs(g.y - lane) - 0.72);
          lum = mix(lum, 0.78, cover(rd2 - 0.04, aa) * 0.9);
          lum = mix(lum, 0.15, cover(abs(rd2 - 0.09) - 0.03, aa) * 0.6);
        }
        lum *= 1.0 - groundShadow(g, uTime);
        // the street darkens and the distance hazes toward the light
        lum = mix(lum, 0.6, smoothstep(20.0, 75.0, z) * 0.55);
        lum *= 0.85 + 0.15 * smoothstep(8.0, 20.0, z);
      }
    }

    // left and right facades
    if (rd.x < 0.0) {
      float z = (-WALL_X - CAM.x) / rd.x;
      float y = CAM.y + rd.y * z;
      if (z < depth && z > 2.0 && z < LEFT_END && y > 0.0 && y < 21.0) {
        depth = z;
        lum = facade(z, y, 21.0, 0.6, pxAt(z) * 3.0, 1.0);
        lum *= 0.95;
      }
    } else {
      float z = (WALL_X - CAM.x) / rd.x;
      float y = CAM.y + rd.y * z;
      if (z < depth && z > 2.0 && z < RIGHT_END && y > 0.0 && y < 19.0) {
        depth = z;
        lum = facade(z + 7.0, y, 19.0, 0.48, pxAt(z) * 3.0, 2.0) * 0.9; // the shaded side
      }
    }
  }

  // ---- silhouettes, roughly far to near (the depth test resolves the rest)
  float t = uTime;

  // bare trees along the far side of the square
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float zo = 64.0 + 4.0 * hash11(fi * 3.3);
    float xo = (fi < 3.0 ? -1.0 : 1.0) * (17.0 + mod(fi, 3.0) * 10.0 + 3.0 * hash11(fi));
    vec2 hp = vec2(CAM.x + rd.x * zo - xo, CAM.y + rd.y * zo);
    if (zo < depth && abs(hp.x) < 6.0 && hp.y < 12.5) {
      vec2 r = tree(hp, hash11(fi * 5.1), pxAt(zo));
      float c = cover(r.x, pxAt(zo));
      lum = mix(lum, mix(r.y, 0.72, 0.3), c);
      if (c > 0.5) depth = zo;
    }
  }

  // pedestrians: (lane z, direction, speed) packed per index
  float zo, dir, dist, xo;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    pedPlace(i, t, zo, dir, dist, xo);
    float sc = 0.92 + 0.14 * hash11(fi * 2.1);
    vec2 hp = vec2((CAM.x + rd.x * zo - xo) * dir, CAM.y + rd.y * zo) / sc;
    if (zo < depth && abs(hp.x) < 1.0 && hp.y < 2.7) {
      vec2 r = pedestrian(hp, dist / 0.75 * PI, hash11(fi * 4.3), 0.12 + 0.2 * hash11(fi * 9.1));
      float c = cover(r.x, pxAt(zo) / sc);
      lum = mix(lum, mix(r.y, 0.7, smoothstep(12.0, 70.0, zo) * 0.45), c);
      if (c > 0.5) depth = zo;
    }
  }

  // street lamps
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 lp = i < 2 ? vec2(-9.0, 14.0 + fi * 11.0) : i < 4 ? vec2(9.0, 15.0 + (fi - 2.0) * 10.0) : i < 6 ? vec2(fi < 5.0 ? -7.0 : 7.0, 47.0) : vec2(-21.0, 62.0);
    vec2 hp = vec2(CAM.x + rd.x * lp.y - lp.x, CAM.y + rd.y * lp.y);
    if (lp.y < depth && abs(hp.x) < 0.5 && hp.y < 5.7) {
      vec2 r = lamp(hp);
      float c = cover(r.x, pxAt(lp.y));
      lum = mix(lum, mix(r.y, 0.7, smoothstep(12.0, 70.0, lp.y) * 0.4), c);
      if (c > 0.5) depth = lp.y;
    }
  }

  // cars
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    carPlace(i, t, zo, dir, dist, xo);
    vec2 hp = vec2((CAM.x + rd.x * zo - xo) * dir, CAM.y + rd.y * zo);
    if (zo < depth && abs(hp.x) < 2.4 && hp.y < 2.0) {
      vec2 r = car(hp, -dist / 0.37, 0.07 + 0.08 * fi);
      float c = cover(r.x, pxAt(zo));
      lum = mix(lum, mix(r.y, 0.7, 0.25), c);
      if (c > 0.5) depth = zo;
    }
  }

  // trams and their overhead contact wires
  for (int i = 0; i < 2; i++) {
    tramPlace(i, t, zo, dir, dist, xo);
    vec2 hp = vec2((CAM.x + rd.x * zo - xo) * dir, CAM.y + rd.y * zo);
    if (zo < depth && abs(hp.x) < 6.0 && hp.y < 6.4) {
      vec2 r = tram(hp, -dist / 0.38);
      float c = cover(r.x, pxAt(zo));
      lum = mix(lum, mix(r.y, 0.7, 0.28), c);
      if (c > 0.5) depth = zo;
    }
    if (zo < depth) {
      float wx = CAM.x + rd.x * zo;
      float sag = 0.22 * (0.5 - 0.5 * cos(wx / 16.0 * TAU));
      float d = abs(CAM.y + rd.y * zo - (6.25 - sag));
      float px = pxAt(zo);
      lum = mix(lum, 0.2, cover(d - 0.02, px) * min(1.0, 0.06 / px));
    }
  }

  // span wires strung between the buildings, and catenaries receding down the street
  for (int i = 0; i < 2; i++) {
    float zo = i == 0 ? 17.0 : 27.0;
    if (zo < depth) {
      float wx = CAM.x + rd.x * zo;
      float d = abs(CAM.y + rd.y * zo - (9.0 - 0.4 * (1.0 - (wx * wx) / 169.0)));
      float px = pxAt(zo);
      lum = mix(lum, 0.18, cover(d - 0.02, px) * min(1.0, 0.05 / px) * step(abs(wx), 13.0));
    }
  }
  for (int i = 0; i < 2; i++) {
    float xw = i == 0 ? -3.6 : 3.6;
    float zs = (xw - CAM.x) / rd.x;
    if (zs > 20.0 && zs < 74.0 && zs < depth) {
      float d = abs(CAM.y + rd.y * zs - 6.4);
      float px = pxAt(zs);
      lum = mix(lum, 0.2, cover(d - 0.02, px) * min(1.0, 0.05 / px));
    }
  }

  return lum;
}

void main() {
  float frame = uFrame;
  // gate weave and bass camera shake, stepped per film frame
  vec2 weave = (vec2(hash11(frame * 1.31), hash11(frame * 2.17 + 4.0)) - 0.5) * vec2(0.0016, 0.003);
  weave += (vec2(hash11(frame * 3.7 + 9.0), hash11(frame * 5.3 + 1.0)) - 0.5) * 0.012 * uShake;
  vec2 uv = vUv + weave;

  float lum = scene(uv);

  // film: contrast, flicker, exposure flash
  lum = clamp((lum - 0.45) * 1.18 + 0.47, 0.0, 1.0);
  float flicker = 1.0 + (hash11(frame * 0.71) - 0.5) * (0.07 + 0.2 * uBass) + 0.03 * sin(frame * 0.9);
  lum *= flicker;
  lum = mix(lum, 1.0, uFlash * 0.38);

  // grain: clumpy, per frame, heavier with treble
  vec2 gp = gl_FragCoord.xy / max(1.0, uResolution.y / 540.0);
  float g = hash12(floor(gp / 1.5) + frame * 17.31) - 0.5;
  g += 0.5 * (hash12(gp + frame * 7.7) - 0.5);
  lum += g * (0.09 + 0.12 * uTreble) * (0.6 + 0.6 * lum);

  // vertical scratches that persist for a few frames
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float life = floor(frame / (5.0 + fk * 4.0));
    float hk = hash11(life * 3.1 + fk * 17.0);
    if (hk > 0.45 - 0.25 * uTreble) {
      float x = hash11(life * 7.3 + fk) + (hash11(frame + fk) - 0.5) * 0.002;
      float w = (1.0 + 1.5 * hash11(life + fk * 3.0)) / uResolution.x;
      float along = smoothstep(0.2, 0.8, vnoise(vec2(uv.y * 6.0, life + fk)));
      float s = (1.0 - smoothstep(0.0, w, abs(uv.x - x))) * along;
      lum = mix(lum, hk > 0.75 ? 0.95 : 0.12, s * 0.65);
    }
  }

  // dust specks and the odd hair, a new set every frame
  float specks = 5.0 + 9.0 * uTreble;
  for (int k = 0; k < 14; k++) {
    float fk = float(k);
    if (fk >= specks) break;
    vec3 h = hash32(vec2(frame, fk * 13.7));
    vec2 c = h.xy;
    vec2 d = (uv - c) * vec2(uAspect, 1.0);
    float r = (0.0012 + 0.004 * h.z * h.z);
    float n = vnoise(d * 900.0 + fk);
    float blob = 1.0 - smoothstep(r * (0.6 + 0.6 * n), r * (0.9 + 0.6 * n), length(d));
    if (h.z > 0.93) {
      // a hair: thin wavy curve
      float hx = d.x + 0.01 * sin(d.y * 220.0 + fk);
      blob = (1.0 - smoothstep(0.0006, 0.0012, abs(hx))) * step(abs(d.y), 0.03);
    }
    lum = mix(lum, h.z > 0.7 ? 0.92 : 0.05, blob * 0.85);
  }

  // vignette and the soft rounded corners of the film gate
  vec2 q = (vUv - 0.5) * vec2(1.0, 1.1);
  lum *= smoothstep(0.95, 0.25, length(q)) * 0.55 + 0.45;
  vec2 gq = abs(vUv - 0.5) * 2.0;
  float gate = sdRoundBox(gq, vec2(1.0), 0.08);
  lum *= smoothstep(0.02, -0.02, gate);
  lum = clamp(lum, 0.0, 1.0);

  // monochrome with a slight warm sepia tint, lifted projector blacks
  vec3 col = vec3(lum) * mix(vec3(1.0), vec3(1.07, 0.97, 0.82), 0.75);
  col = col * 0.93 + vec3(0.03, 0.026, 0.02);
  gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
}
