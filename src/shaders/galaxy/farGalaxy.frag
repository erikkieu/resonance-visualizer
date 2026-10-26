// A small distant spiral galaxy seen at an angle.
uniform vec3 uColor;
uniform float uTilt;
uniform float uSpin;
varying vec2 vUv;

void main() {
  vec2 p = vUv;
  float c = cos(uSpin), s = sin(uSpin);
  p = mat2(c, s, -s, c) * p;
  p.y /= uTilt;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float arms = 0.5 + 0.5 * cos(2.0 * a - log(r + 0.05) * 5.0);
  float b = exp(-r * 9.0) * 1.6 + arms * exp(-r * 3.5) * 0.35;
  gl_FragColor = vec4(uColor * b * smoothstep(1.0, 0.6, r), 1.0);
}
