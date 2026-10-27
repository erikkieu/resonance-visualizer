// Brush stroke fragment: ragged bristle edges, tapered ends, grooves along
// the stroke and a little dry-brush break-up toward the tail.
varying vec2 vLocal;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;

void main() {
  float u = vLocal.x;
  float v = vLocal.y;
  float edge = 1.0 - smoothstep(0.62 + 0.28 * vnoise(vec2(u * 3.0 + vSeed * 13.0, v * 9.0)), 1.0, abs(v));
  float ends = 1.0 - smoothstep(0.7 + 0.25 * vnoise(vec2(v * 7.0, vSeed * 5.0)), 1.0, abs(u));
  float groove = 0.5 + 0.5 * sin(v * 14.0 + vSeed * 40.0 + 2.0 * vnoise(vec2(u * 2.0, v * 6.0)));
  float dry = smoothstep(0.2, 0.9, vnoise(vec2(u * 5.0 + vSeed * 7.0, v * 18.0)));
  float a = edge * ends * vAlpha * mix(1.0, 0.55 + 0.45 * dry, smoothstep(-0.2, 1.0, u));
  gl_FragColor = vec4(vColor * (0.82 + 0.3 * groove), a);
}
