// A bright point of light floating across the sky: a hot core (blooms), a
// soft halo and faint four-point diffraction spikes. Additive; hidden where
// the galaxy's disk lies in front of it (diskShadow, occlude.glsl).
uniform vec3 uColor;
uniform float uBright;
uniform float uFade;
varying vec2 vUv;
varying vec3 vWorld;

void main() {
  float r2 = dot(vUv, vUv);
  float core = exp(-r2 * 180.0);
  float glow = exp(-r2 * 24.0) * 0.22 + exp(-sqrt(r2) * 4.5) * 0.07;
  vec2 a = abs(vUv);
  float spikes = (exp(-a.y * 160.0) * exp(-a.x * 3.5) + exp(-a.x * 160.0) * exp(-a.y * 3.5)) * 0.3;
  float edge = smoothstep(1.0, 0.75, sqrt(r2)); // nothing at the quad's border
  vec3 col = (mix(uColor, vec3(1.0), 0.6) * core + uColor * (glow + spikes)) * uBright;
  gl_FragColor = vec4(col * edge * uFade * (1.0 - diskShadow(vWorld)), 1.0);
}
