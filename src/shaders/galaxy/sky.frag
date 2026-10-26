// Nebula backdrop on a huge inverted sphere: soft fbm clouds in teal and
// crimson, broken up by darker dust filaments.
uniform float uTime;
uniform float uBass;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float drift = uTime * 0.004;
  float n1 = fbm3(d * 1.3 + vec3(0.0, drift, 0.0), 5);
  float n2 = fbm3(d * 1.7 + vec3(7.1, -drift, 2.3), 5);
  float dust = fbm3(d * 4.0 + 3.0, 3);
  vec3 col = vec3(0.003, 0.004, 0.009);
  float teal = smoothstep(-0.1, 0.65, n1);
  float crimson = smoothstep(0.0, 0.7, n2);
  col += vec3(0.02, 0.15, 0.17) * teal * teal;
  col += vec3(0.2, 0.025, 0.07) * crimson * crimson;
  col += vec3(0.08, 0.04, 0.12) * teal * crimson; // violet where they overlap
  col *= 0.55 + 0.45 * smoothstep(-0.35, 0.3, dust);
  col *= 1.0 + 0.15 * uBass;
  gl_FragColor = vec4(col, 1.0);
}
