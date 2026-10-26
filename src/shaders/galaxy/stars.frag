varying vec3 vColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(p, p);
  if (d2 > 1.0) discard;
  gl_FragColor = vec4(vColor * (exp(-d2 * 6.0) + 0.05), 1.0);
}
