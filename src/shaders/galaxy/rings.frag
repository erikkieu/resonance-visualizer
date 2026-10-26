// Shockwave rings in the galactic plane, expanding from the core on beats.
uniform vec4 uWaves[4];
uniform float uRadiusScale; // quad half-size / galaxy radius
varying vec2 vUv;

void main() {
  float r = length(vUv) * uRadiusScale;
  float a = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = (r - uWaves[i].x) / (0.025 + 0.03 * uWaves[i].x);
    a += exp(-d * d) * uWaves[i].y;
  }
  vec3 col = vec3(0.9, 0.55, 1.0) * a * 0.22 * smoothstep(1.3, 0.9, r);
  gl_FragColor = vec4(col, 1.0);
}
