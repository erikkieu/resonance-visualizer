// Final pass to the screen: grades each scene's HDR output, cross-fades the
// incoming scene over the outgoing one with a soft noise-shaped dissolve,
// encodes to sRGB and dithers to hide banding in the soft gradients.

uniform sampler2D tCur;
uniform sampler2D tPrev;
uniform float uMix;         // 0..1 progress of the crossfade
uniform float uHasPrev;
uniform vec2 uCurGrade;     // x = exposure, y = tone map flag
uniform vec2 uPrevGrade;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;

// ACES filmic fit (Stephen Hill), the same curve three.js uses.
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACESOutputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 grade(vec3 c, vec2 g) {
  c *= g.x;
  if (g.y > 0.5) c = acesFilmic(c);
  return clamp(c, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 col = grade(texture2D(tCur, vUv).rgb, uCurGrade);

  if (uHasPrev > 0.5) {
    vec3 prev = grade(texture2D(tPrev, vUv).rgb, uPrevGrade);
    // Spatially varying threshold: the new scene seeps in like ink, but the
    // edges stay wide and soft so it still reads as a crossfade.
    vec2 p = vUv * vec2(uResolution.x / uResolution.y, 1.0) * 2.2;
    float n = 0.5 + 0.35 * snoise(vec3(p, uTime * 0.15)) + 0.15 * snoise(vec3(p * 2.7, 4.0));
    n = clamp(n, 0.0, 1.0);
    float w = 0.45;
    float t = smoothstep(n * w, n * w + (1.0 - w), uMix);
    col = mix(prev, col, t);
  }

  col = linearToSRGB(col);
  // Triangular-ish dither, 1/255 amplitude
  float d = hash12(gl_FragCoord.xy + fract(uTime) * 91.7) + hash12(gl_FragCoord.yx * 1.3 + 17.0) - 1.0;
  col += d / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
