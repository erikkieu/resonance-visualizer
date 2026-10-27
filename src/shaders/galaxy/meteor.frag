// Shooting star: a thin streak on a quad (uv.x 0 = tail end, 1 = head),
// a hot blue-white head fading into a warm, thinning tail.
uniform float uAlpha;
varying vec2 vUv;

void main() {
  float u = vUv.x * 0.5 + 0.5;
  float across = vUv.y;
  float core = exp(-across * across * 5.0);
  float tail = pow(u, 1.8) * exp(-across * across * (5.0 + 10.0 * (1.0 - u)));
  float head = exp(-pow((1.0 - u) * 14.0, 2.0)) * core;
  vec3 col = mix(vec3(1.0, 0.72, 0.5), vec3(0.85, 0.93, 1.0), u) * tail * 1.2 + vec3(0.95, 0.97, 1.0) * head * 2.0;
  gl_FragColor = vec4(col * uAlpha, 1.0);
}
