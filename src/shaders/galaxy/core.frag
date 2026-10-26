// Bright galactic core: a tight hot centre in a broad warm halo; pulses with bass.
uniform float uIntensity;
varying vec2 vUv;

void main() {
  float r2 = dot(vUv, vUv);
  vec3 col = vec3(1.0, 0.86, 0.66) * exp(-r2 * 60.0) * 2.2;
  col += vec3(1.0, 0.72, 0.5) * exp(-r2 * 7.0) * 0.55;
  col += vec3(0.9, 0.5, 0.6) * exp(-sqrt(r2) * 4.0) * 0.12;
  col *= uIntensity * smoothstep(1.0, 0.7, r2);
  gl_FragColor = vec4(col, 1.0);
}
