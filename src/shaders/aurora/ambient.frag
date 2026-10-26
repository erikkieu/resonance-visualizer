// Average aurora light (rendered into a 1x1 target once per frame), used to
// light snow, rocks and the shoreline without per-pixel texture taps.
uniform sampler2D tAurora;

void main() {
  vec3 a = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 6; i++) {
      a += texture2D(tAurora, vec2(0.08 + 0.168 * float(i), 0.55 + 0.13 * float(j))).rgb;
    }
  }
  gl_FragColor = vec4(a / 18.0, 1.0);
}
