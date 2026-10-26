// ---------------------------------------------------------------------------
// Starry Night: composition shared by the underpainting and stroke passes.
// Painting space: p.y in 0..1 (bottom to top), p.x in 0..uLayout.
// Landmarks are placed by fractions of the layout width so wide screens stay
// balanced. uLayout is the screen aspect, but never narrower than 1.25:1:
// on portrait screens we show a centred crop (screen x starts at uOffsetX)
// instead of squeezing the whole composition together.
// ---------------------------------------------------------------------------

uniform float uAspect;
uniform float uLayout;
uniform float uOffsetX;
uniform float uTime;     // scene clock (energy-driven)
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uEnergy;
uniform float uBeat;
uniform float uSway;     // cypress sway amount (grows with volume)

#define NSTARS 11
// x = fraction of width, y = height, z = size
const vec3 STARS[NSTARS] = vec3[NSTARS](
  vec3(0.060, 0.80, 0.034),
  vec3(0.255, 0.93, 0.030),
  vec3(0.365, 0.86, 0.040),
  vec3(0.535, 0.93, 0.030),
  vec3(0.645, 0.83, 0.042),
  vec3(0.735, 0.68, 0.050),
  vec3(0.770, 0.94, 0.028),
  vec3(0.265, 0.56, 0.034),
  vec3(0.600, 0.52, 0.040),
  vec3(0.890, 0.56, 0.040),
  vec3(0.965, 0.71, 0.030)
);

vec2 starPos(int i) { return vec2(STARS[i].x * uLayout, STARS[i].y); }
float starSize(int i) { return STARS[i].z * (1.0 + 0.28 * uBass); }

vec2 swirlCenter() { return vec2(0.47 * uLayout, 0.645); }
vec2 swirlCenter2() { return vec2(0.30 * uLayout, 0.70); }
vec2 moonPos() { return vec2(0.875 * uLayout, 0.835); }
const float MOON_R = 0.058;

// --- hills -----------------------------------------------------------------
float farHill(float x) {
  float xn = x / uLayout;
  return 0.30 + 0.07 * smoothstep(0.25, 1.0, xn) + 0.022 * sin(xn * 9.0 + 0.7) + 0.012 * sin(xn * 23.0 + 1.3);
}

float nearHill(float x) {
  float xn = x / uLayout;
  return 0.215 + 0.025 * sin(xn * 6.0 + 2.0) + 0.03 * smoothstep(0.45, 1.0, xn) + 0.008 * sin(xn * 31.0);
}

// --- cypress ----------------------------------------------------------------
// Returns (inside 0/1, signed position across the trunk -1..1, height fraction)
vec3 cypress(vec2 p) {
  const float top = 0.94;
  float yf = clamp(p.y / top, 0.0, 1.0);
  float sway = uSway * yf * yf * sin(uTime * 0.55) + 0.01 * yf * sin(p.y * 9.0 + uTime * 0.45);
  float cx = 0.155 * uLayout + sway + 0.012 * sin(p.y * 4.3 + 0.6);
  float w = 0.125 * pow(max(1.0 - yf, 0.0), 0.8) + 0.003;
  // flame tongues: each side ripples at its own rate
  float wl = w * (1.0 + 0.32 * sin(p.y * 19.0 + uTime * 0.35) + 0.14 * sin(p.y * 47.0 + uTime * 0.2));
  float wr = w * (1.0 + 0.32 * sin(p.y * 16.0 + 1.7 + uTime * 0.3) + 0.14 * sin(p.y * 41.0 + 0.4));
  float dx = p.x - cx;
  float edge = dx < 0.0 ? wl : wr;
  float inside = step(abs(dx), edge) * step(p.y, top);
  return vec3(inside, dx / max(edge, 1e-4), yf);
}

// --- village ------------------------------------------------------------------
// One row of houses. Returns (cover, roof?, lit window, shade)
vec4 houseRow(vec2 p, float baseY, float cw, float hs, float seed) {
  float sx = p.x + seed * 0.37;
  float id = floor(sx / cw);
  float lx = fract(sx / cw);
  vec4 r = vec4(hash12(vec2(id, seed)), hash12(vec2(id, seed + 1.0)), hash12(vec2(id, seed + 2.0)), hash12(vec2(id, seed + 3.0)));
  if (r.x < 0.3) return vec4(0.0);
  float hw = 0.3 + 0.16 * r.x;
  float cx = 0.5 + (r.y - 0.5) * 0.14;
  float wallH = hs * (0.55 + 0.45 * r.z);
  float roofH = hs * (0.3 + 0.35 * r.w);
  float y = p.y - baseY - 0.006 * sin(p.x * 7.0 + seed);
  float dx = abs(lx - cx);
  if (y > 0.0 && y < wallH && dx < hw) {
    vec2 wq = vec2((lx - cx) / hw, y / wallH);
    float wx = step(abs(abs(wq.x) - 0.42), 0.15);
    float wy = step(abs(wq.y - 0.52), 0.16);
    float lit = step(0.5, hash12(vec2(id + sign(wq.x) * 0.5, seed + 7.0)));
    return vec4(1.0, 0.0, wx * wy * lit, r.z);
  }
  float rw = (hw + 0.07) * (1.0 - (y - wallH) / roofH);
  if (y >= wallH && y < wallH + roofH && dx < rw) return vec4(1.0, 1.0, 0.0, r.w);
  return vec4(0.0);
}

// Whole village: rows back-to-front plus the church. Same return layout;
// roof value 0.5 marks the church so it can be darker.
vec4 village(vec2 p) {
  float xn = p.x / uLayout;
  if (xn < 0.25 || p.y > 0.42) return vec4(0.0);
  vec4 v = vec4(0.0);
  vec4 h;
  h = houseRow(p, 0.165, 0.040, 0.030, 3.0);
  if (h.x > 0.0) v = h;

  // church: nave, tower and spire
  float cx = 0.565 * uLayout;
  float y = p.y;
  float nave = step(abs(p.x - cx), 0.04) * step(0.12, y) * step(y, 0.178);
  float naveRoof = step(abs(p.x - cx), 0.04 * (1.0 - (y - 0.178) / 0.03)) * step(0.178, y) * step(y, 0.208);
  float tower = step(abs(p.x - cx - 0.022), 0.013) * step(0.12, y) * step(y, 0.25);
  float spire = step(abs(p.x - cx - 0.022), 0.013 * (1.0 - (y - 0.25) / 0.16)) * step(0.25, y) * step(y, 0.41);
  if (nave + naveRoof + tower + spire > 0.0) {
    float win = step(abs(p.x - cx + 0.012), 0.004) * step(abs(y - 0.15), 0.012);
    v = vec4(1.0, 0.5, win, 0.3);
  }

  h = houseRow(p, 0.095, 0.052, 0.042, 11.0);
  if (h.x > 0.0) v = h;
  h = houseRow(p, 0.02, 0.064, 0.052, 23.0);
  if (h.x > 0.0) v = h;
  return v * step(0.27, xn);
}
