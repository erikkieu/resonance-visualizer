// Resonant starfield: stars at every depth, some of them tuned to one
// frequency band (aBand = band index, -1 = steady). A tuned star swells and
// brightens with its band's level and takes on the band's tint (warm for
// low notes, ice blue for high ones). Near stars are drawn larger.
attribute vec3 aColor;
attribute float aSize;
attribute float aSeed;
attribute float aBand;
attribute float aSens;
uniform float uTime;
uniform float uScale;
uniform float uBands[8];
uniform vec3 uTints[8];
uniform float uGain;
uniform float uSizeGain;
varying vec3 vColor;
varying float vHalo;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.8 + 0.2 * sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 40.0);
  float glow = 0.0;
  vec3 tint = vec3(1.0);
  if (aBand >= 0.0) {
    int b = int(aBand + 0.5);
    glow = uBands[b] * aSens;
    tint = uTints[b];
  }
  vColor = mix(aColor, tint * max(max(aColor.r, aColor.g), aColor.b), min(1.0, glow * 1.5)) * tw * (1.0 + uGain * glow);
  vColor *= 1.0 - diskShadow((modelMatrix * vec4(position, 1.0)).xyz);
  vHalo = min(1.0, glow);
  gl_PointSize = max(1.0, aSize * uScale * (1.0 + uSizeGain * glow));
}
