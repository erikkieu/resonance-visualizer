// ---------------------------------------------------------------------------
// One-off analysis of the reference painting (mipmapped afterwards):
//   r = cypress   (dark green / brown paint in the left part)
//   g = landscape (below the horizon line)
//   b = light     (bright yellowish paint: stars, moon, village windows)
//   a = buildings (the village houses and the church with its spire, from
//       shapes measured off the painting: they stand still, in front)
// ---------------------------------------------------------------------------

uniform sampler2D tRef;
uniform float uHorizon[11]; // horizon height v at u = 0, 0.1, ... 1
uniform vec2 uVillage[3];   // the houses' top line: (u, v) points, houses below it right of the first
uniform vec4 uSpire;        // u0, u1 at the base, base v, tip v
uniform vec4 uTower;        // u0, u1, v0, v1
uniform vec4 uNave;         // u0, u1, v0, v1 (walls)
uniform float uGable;       // v of the nave's gable peak
varying vec2 vUv;

float horizon(float u) {
  float x = clamp(u, 0.0, 1.0) * 10.0;
  int i = int(min(floor(x), 9.0));
  return mix(uHorizon[i], uHorizon[i + 1], x - float(i));
}

float box(vec2 p, vec4 b) {
  return step(b.x, p.x) * step(p.x, b.y) * step(b.z, p.y) * step(p.y, b.w);
}

// 1 inside a triangle standing on [u0, u1] at v0 with its tip at v1
float spike(vec2 p, vec4 b) {
  float t = (p.y - b.z) / (b.w - b.z);
  float half_ = 0.5 * (b.y - b.x) * (1.0 - t);
  return step(0.0, t) * step(t, 1.0) * step(abs(p.x - 0.5 * (b.x + b.y)), half_);
}

float buildings(vec2 p) {
  float t = clamp((p.x - uVillage[1].x) / (uVillage[2].x - uVillage[1].x), 0.0, 1.0);
  float top = p.x < uVillage[1].x ? mix(uVillage[0].y, uVillage[1].y, clamp((p.x - uVillage[0].x) / (uVillage[1].x - uVillage[0].x), 0.0, 1.0)) : mix(uVillage[1].y, uVillage[2].y, t);
  float village = smoothstep(top + 0.006, top - 0.006, p.y) * smoothstep(uVillage[0].x - 0.01, uVillage[0].x + 0.01, p.x);
  float church = max(max(spike(p, uSpire), box(p, uTower)), max(box(p, uNave), spike(p, vec4(uNave.xy, uNave.w, uGable))));
  return max(village, church);
}

void main() {
  vec3 c = pow(texture2D(tRef, refUV(vUv)).rgb, vec3(1.0 / 2.2)); // approx sRGB for colour tests
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float cypress = smoothstep(0.3, 0.2, lum) * step(c.b, max(c.r, c.g) * 1.25) * smoothstep(0.5, 0.44, vUv.x) * step(vUv.y, 0.97);
  float h = horizon(vUv.x);
  float land = smoothstep(h + 0.01, h - 0.02, vUv.y);
  float warmth = (c.r + c.g) * 0.5 - c.b;
  float light = smoothstep(0.06, 0.25, warmth) * smoothstep(0.45, 0.75, lum);
  float bld = buildings(vUv) * (1.0 - step(0.5, cypress));
  gl_FragColor = vec4(cypress, land, light, bld);
}
