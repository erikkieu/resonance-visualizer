// Soft round sprite. Stars get a tight core with a faint halo; gas and dust
// glows (vSoft) are broad and smooth. Additive blending accumulates light.
varying vec3 vColor;
varying float vSoft;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(p, p);
  if (d2 > 1.0) discard;
  float star = exp(-d2 * 9.0) + 0.12 * exp(-d2 * 2.5);
  float gas = exp(-d2 * 3.0) * (1.0 - d2);
  float a = mix(star, gas, vSoft);
  gl_FragColor = vec4(vColor * a, 1.0);
}
