// Splat injection: adds up to MAX_SPLATS Gaussian blobs in one pass.
// For velocity the "color" is the impulse (vx, vy); for dye it is the
// premultiplied colour + paint amount. uFade scales the existing content
// down under the blob (multiplicatively, so colours keep their hue): that
// is how the cells of an acrylic pour open up.
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform int uCount;
uniform vec3 uPoints[MAX_SPLATS];  // xy = position (uv), z = radius
uniform vec4 uColors[MAX_SPLATS];
uniform float uFade[MAX_SPLATS];
uniform float uMin;                // lower clamp (0 for dye, -inf for velocity)
varying vec2 vUv;

void main() {
  vec4 base = texture2D(uTarget, vUv);
  vec4 add = vec4(0.0);
  float keep = 1.0;
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uCount) break;
    vec2 p = vUv - uPoints[i].xy;
    p.x *= aspectRatio;
    float g = exp(-dot(p, p) / uPoints[i].z);
    add += g * uColors[i];
    keep *= 1.0 - clamp(uFade[i] * g, 0.0, 1.0);
  }
  gl_FragColor = max(base * keep + add, vec4(uMin));
}
