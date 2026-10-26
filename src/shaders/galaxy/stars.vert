// Background starfield layers. Sizes are in pixels (stars are point-like),
// the near layer sits close enough to the camera to show parallax.
attribute float aSize;
attribute vec3 aColor;
attribute float aSeed;
uniform float uTime;
uniform float uTreble;
uniform float uScale;
varying vec3 vColor;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.78 + 0.22 * sin(uTime * (0.8 + aSeed * 2.5) + aSeed * 50.0);
  tw *= 1.0 + uTreble * 1.2 * pow(0.5 + 0.5 * sin(uTime * 11.0 + aSeed * 91.0), 6.0);
  vColor = aColor * tw;
  gl_PointSize = max(1.0, aSize * uScale);
}
