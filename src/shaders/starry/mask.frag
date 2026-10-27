// ---------------------------------------------------------------------------
// One-off analysis of the reference painting (mipmapped afterwards):
//   r = cypress   (dark green / brown paint in the left part)
//   g = landscape (below the horizon line)
//   b = light     (bright yellowish paint: stars, moon, village windows)
// ---------------------------------------------------------------------------

uniform sampler2D tRef;
uniform float uHorizon[11]; // horizon height v at u = 0, 0.1, ... 1
varying vec2 vUv;

float horizon(float u) {
  float x = clamp(u, 0.0, 1.0) * 10.0;
  int i = int(min(floor(x), 9.0));
  return mix(uHorizon[i], uHorizon[i + 1], x - float(i));
}

void main() {
  vec3 c = pow(texture2D(tRef, refUV(vUv)).rgb, vec3(1.0 / 2.2)); // approx sRGB for colour tests
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float cypress = smoothstep(0.3, 0.2, lum) * step(c.b, max(c.r, c.g) * 1.25) * smoothstep(0.5, 0.44, vUv.x) * step(vUv.y, 0.97);
  float h = horizon(vUv.x);
  float land = smoothstep(h + 0.01, h - 0.02, vUv.y);
  float warmth = (c.r + c.g) * 0.5 - c.b;
  float light = smoothstep(0.06, 0.25, warmth) * smoothstep(0.45, 0.75, lum);
  gl_FragColor = vec4(cypress, land, light, 1.0);
}
