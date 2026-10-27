// Brush stroke fragment: ragged bristle edges, tapered ends, grooves along
// the stroke and a little dry-brush break-up toward the tail. While a stroke
// draws on, its brush head is soft; fresh paint has a wet sheen in the grooves.
varying vec2 vLocal;
varying float vHead;  // brush head along the stroke (-1..1; 1 = fully drawn)
varying float vWet;   // fresh paint sheen, 0 when dry
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
  float head = vHead < 0.999 ? 1.0 - smoothstep(vHead - 0.35, vHead, u) : 1.0;
  float a = edge * ends * head * vAlpha * mix(1.0, 0.55 + 0.45 * dry, smoothstep(-0.2, 1.0, u));
  vec3 col = vColor * (0.82 + 0.3 * groove);
  col += vWet * 0.35 * pow(groove, 6.0) * vec3(1.0, 0.97, 0.9) * (0.4 + dot(vColor, vec3(0.2126, 0.7152, 0.0722)));
  gl_FragColor = vec4(col, a);
}
