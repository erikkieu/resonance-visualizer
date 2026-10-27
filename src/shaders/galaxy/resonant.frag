varying vec3 vColor;
varying float vHalo;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(p, p);
  if (d2 > 1.0) discard;
  // a sharp core; a resonating star also gets a soft halo
  float core = exp(-d2 * 7.0);
  float halo = vHalo * 0.35 * exp(-d2 * 2.2) * (1.0 - d2);
  gl_FragColor = vec4(vColor * (core + halo + 0.04), 1.0);
}
